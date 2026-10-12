import { readFile } from "node:fs/promises";
import { createLarkChannel, LarkChannelError, type CardActionEvent, type NormalizedMessage, type RawMessageEvent } from "@larksuite/channel";
import type { AppConfig, Secrets } from "./config.js";
import type { CardControls, IncomingMessage, Messenger, OutboxEntry } from "./types.js";
import { errorText, log } from "./log.js";

export function normalizeMessage(m: NormalizedMessage): IncomingMessage | undefined {
  const raw = m.raw as RawMessageEvent | undefined;
  const tenant = raw?.sender?.tenant_key;
  // A missing tenant/sender-kind is not proof of authorization.
  if (!tenant || m.senderType !== "user") return;
  const timestamp = m.createTime < 1e12 ? m.createTime * 1000 : m.createTime;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return;
  const botMention = m.mentions.find(mention => mention.isBot && mention.name);
  const botPrefix = botMention ? `@${botMention.name}` : undefined;
  const text = m.mentionedBot && botPrefix && m.content.trimStart().startsWith(botPrefix)
    ? m.content.trimStart().slice(botPrefix.length).trimStart() : m.content;
  return {
    tenantId: tenant, chatId: m.chatId, messageId: m.messageId,
    senderId: m.senderId, senderName: m.senderName ?? m.senderId, senderType: "user",
    text, mentions: m.mentions.map(a => ({ id: a.openId ?? a.userId ?? "", key: a.key, name: a.name })),
    mentionedBot: m.mentionedBot, rootId: m.rootId, threadId: m.threadId,
    replyToMessageId: m.replyToMessageId, createdAt: timestamp,
    resources: m.resources.slice(0, 4).map(resource => ({ type: resource.type,
      fileKey: resource.fileKey, fileName: resource.fileName })),
  };
}

const EFFORTS = [["low", "低"], ["medium", "中"], ["high", "高"], ["xhigh", "超高"]] as const;
const plain = (content: string) => ({ tag: "plain_text", content });
/** Callback value carried by every card control; the Bridge re-checks permissions on click. */
export interface CardValue { a: "model" | "effort" | "stop" | "accept" | "reject"; scope: "topic" | "group"; target: string }
function controlElements(c: CardControls): object[] {
  const value = (a: CardValue["a"]): CardValue => ({ a, scope: c.scope, target: c.target });
  const select = (a: "model" | "effort", placeholder: string, options: readonly (readonly [string, string])[], initial?: string) => ({
    tag: "select_static", name: a, placeholder: plain(placeholder), ...(initial ? { initial_option: initial } : {}),
    options: options.map(([v, label]) => ({ text: plain(label), value: v })), behaviors: [{ type: "callback", value: value(a) }] });
  const elements: object[] = [{ tag: "column_set", columns: [
    { tag: "column", width: "weighted", weight: 1, elements: [select("model", "模型", c.models.map(m => [m.id, m.label] as const), c.model)] },
    { tag: "column", width: "weighted", weight: 1, elements: [select("effort", "思考强度", EFFORTS, c.effort)] }] }];
  if (c.stop) elements.push({ tag: "button", text: plain("停止"), type: "danger", behaviors: [{ type: "callback", value: value("stop") }] });
  if (c.review) elements.push({ tag: "form", name: "review", elements: [
    { tag: "input", name: "feedback", placeholder: plain("退回意见（退回时填写）") },
    { tag: "button", name: "accept", text: plain("接受"), type: "primary", form_action_type: "submit", behaviors: [{ type: "callback", value: value("accept") }] },
    { tag: "button", name: "reject", text: plain("退回"), type: "default", form_action_type: "submit", behaviors: [{ type: "callback", value: value("reject") }] }] });
  return elements;
}
/** Feishu card (JSON 2.0): markdown body, optional header and controls; text <at> tags become card mentions. */
export function toCard(text: string, header?: OutboxEntry["card"], controls?: CardControls): string {
  const content = text.replace(/<at user_id="([^"]+)"><\/at>/g, "<at id=$1></at>");
  return JSON.stringify({ schema: "2.0", config: { update_multi: true },
    ...(header ? { header: { title: plain(header.title.slice(0, 100)), template: header.template } } : {}),
    body: { elements: [{ tag: "markdown", content }, ...(controls ? controlElements(controls) : [])] } });
}

export class DeliveryError extends Error {
  constructor(message: string, readonly disposition: "retry" | "uncertain" | "failed") { super(message); }
}

export class Feishu implements Messenger {
  readonly channel;
  constructor(readonly config: AppConfig, secrets: Secrets, onUnrecoverable?: (error: unknown) => void) {
    // Do not forward raw Axios request objects from SDK logs: they can contain keys.
    const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {} };
    this.channel = createLarkChannel({
      appId: secrets.appId, appSecret: secrets.appSecret, includeRawEvent: true,
      policy: { requireMention: false, groupAllowlist: config.allowedChats, dmMode: "disabled" },
      outbound: { retry: { maxAttempts: 1 }, textChunkLimit: 10_000 },
      logger, connectTimeoutMs: 20_000,
      handshakeTimeoutMs: 10_000, source: "feishu-codex",
      httpTimeoutMs: 20_000, keepalive: { enabled: true, onUnrecoverable },
    });
  }
  async connect(handler: (message: IncomingMessage) => Promise<void>,
    onCard?: (event: CardActionEvent) => Promise<Record<string, unknown> | void>): Promise<void> {
    if (onCard) this.channel.on("cardAction", async event => {
      log("card_action_received", { messageId: event.messageId, tag: event.action.tag });
      try { return (await onCard(event)) ?? undefined; }
      catch (e) { log("card_action_error", { error: errorText(e) }); return { toast: { type: "error", content: "操作未完成，请稍后再试" } }; }
    });
    this.channel.on("reconnecting", () => log("feishu_reconnecting"));
    this.channel.on("reconnected", () => log("feishu_reconnected"));
    this.channel.on("error", err => log("feishu_error", { code: err.code }));
    this.channel.on("message", m => {
      const incoming = normalizeMessage(m);
      if (!incoming) return;
      log("message_received", { messageId: incoming.messageId, mentioned: incoming.mentionedBot });
      // SDK callback returns immediately; neither model execution nor stop blocks ingestion.
      void handler(incoming).catch(e => log("inbound_error", { messageId: incoming.messageId, error: errorText(e) }));
    });
    await this.channel.connect();
  }
  async reply(entry: OutboxEntry): Promise<{ messageId: string; rootId?: string; threadId?: string }> {
    let uploading = false;
    try {
      if (entry.purpose === "reaction") {
        // Claude Tag reacts to show it picked a message up; failure here never blocks the answer.
        const reacted = await this.channel.rawClient.im.messageReaction.create({ path: { message_id: entry.target.messageId },
          data: { reaction_type: { emoji_type: entry.emoji ?? "OnIt" } } });
        if (reacted.code !== 0 || !reacted.data?.reaction_id) throw new DeliveryError(`飞书表情回应失败 (${reacted.code})`, "failed");
        return { messageId: reacted.data.reaction_id };
      }
      if (entry.purpose === "post") {
        const posted = await this.channel.rawClient.im.message.create({ params: { receive_id_type: "chat_id" },
          data: { receive_id: entry.target.chatId, msg_type: "text", content: JSON.stringify({ text: entry.text ?? "" }), uuid: entry.id } });
        if (posted.code !== 0 || !posted.data?.message_id) throw new DeliveryError(`飞书群消息发送失败 (${posted.code})`, "failed");
        return { messageId: posted.data.message_id };
      }
      let content: string, msgType: "file" | "text";
      if (entry.filePath) {
        uploading = true;
        const file = await this.channel.rawClient.im.file.create({ data: {
          file_type: "stream", file_name: entry.fileName ?? "result.zip", file: await readFile(entry.filePath),
        } });
        if (!file?.file_key)
          throw new DeliveryError("飞书附件上传未返回 file_key", "failed");
        uploading = false; msgType = "file"; content = JSON.stringify({ file_key: file.file_key });
      } else {
        if ((entry.text?.length ?? 0) > 4000) throw new DeliveryError("消息必须在 outbox 中预先分段", "failed");
        msgType = "text"; content = JSON.stringify({ text: entry.text ?? "" });
      }
      // Keep an explicit reference to the task root in either display mode.
      // A revoked target must fail rather than becoming an unrelated top-level send.
      const send = (type: "file" | "text" | "interactive", body: string, uuid: string) => this.channel.rawClient.im.message.reply({
        path: { message_id: entry.target.messageId },
        data: { msg_type: type, content: body, reply_in_thread: this.config.replyMode === "thread", uuid },
      });
      let response = msgType === "text" ? await send("interactive", toCard(entry.text ?? "", entry.card, entry.controls), entry.id) : undefined;
      // A card the platform explicitly rejects must not lose the answer: resend as plain text under a
      // distinct idempotency key. Uncertain failures (timeouts) throw above and keep outbox semantics.
      if (!response || response.code !== 0 || !response.data?.message_id)
        response = await send(msgType, content, msgType === "text" ? `${entry.id.slice(0, 30)}-t` : entry.id);
      if (response.code !== 0 || !response.data?.message_id)
        throw new DeliveryError(`飞书引用回复失败 (${response.code})`, response.code === 99991400 ? "retry" : "failed");
      return { messageId: response.data.message_id, rootId: response.data.root_id, threadId: response.data.thread_id };
    } catch (e) {
      if (e instanceof DeliveryError) throw e;
      const status = (e as { response?: { status?: number } })?.response?.status;
      if (status === 429) throw new DeliveryError("飞书限流，等待补发", "retry");
      if (uploading) throw new DeliveryError("飞书附件上传未完成，原线程尚未发送", "retry");
      if (e instanceof LarkChannelError) {
        if (e.code === "rate_limited" || e.code === "not_connected")
          throw new DeliveryError(`飞书投递失败：${e.code}`, "retry");
        if (["permission_denied", "target_revoked", "format_error", "ssrf_blocked"].includes(e.code))
          throw new DeliveryError(`飞书投递失败：${e.code}`, "failed");
        // Timeout/unknown can mean the platform accepted the request.
        throw new DeliveryError(`飞书发送结果待核对：${e.code}`, "uncertain");
      }
      throw new DeliveryError(errorText(e), "uncertain");
    }
  }
  /** Edit a card the bot already sent (live progress checklist). */
  async updateCard(messageId: string, card: string): Promise<void> {
    await this.channel.updateCard(messageId, JSON.parse(card) as object);
  }
  async doctor(): Promise<Record<string, unknown>> {
    const chats: { visible: boolean; backgroundReadable: boolean }[] = [];
    for (const chatId of this.config.allowedChats) {
      const result = await this.channel.rawClient.im.chat.get({ path: { chat_id: chatId } });
      if (result.code !== 0) throw new Error(`飞书群访问失败 (${result.code})`);
      let backgroundReadable = false;
      try {
        const messages = await this.channel.rawClient.im.message.list({
          params: { container_id_type: "chat", container_id: chatId, page_size: 1 },
        });
        backgroundReadable = messages.code === 0;
      } catch { /* Report @-only rather than pretending history access. */ }
      chats.push({ visible: true, backgroundReadable });
    }
    return { chats, replyMode: this.config.replyMode,
      mode: this.config.receiveBackground ? "background configured; verify event subscription in console" : "@-only",
      delivery: "发送与附件权限需真实投递验证；免费诊断不会发送消息。" };
  }
  async close(): Promise<void> { await this.channel.disconnect(); }
}
