import type { Client } from "@larksuiteoapi/node-sdk";
import type { AppConfig, Secrets } from "./config.js";
import type { Store } from "./store.js";
import type { IncomingMessage } from "./types.js";
import type { GroupAgent } from "./group.js";
import { textOf, type Historical } from "./platform-context.js";
import { errorText, log } from "./log.js";
import { L } from "./i18n.js";

type Lister = Pick<Client["im"]["message"], "list">;

/** One-time full import of a group's history (main timeline and every topic) with the bot identity. */
export async function importGroupHistory(messages: Lister, config: AppConfig, secrets: Secrets, store: Store,
  group: GroupAgent, tenant: string, chat: string): Promise<{ imported: number; threads: number }> {
  const state = group.state(tenant, chat);
  if (state?.importedAt) return { imported: 0, threads: 0 };
  let imported = 0;
  const threads = new Set<string>();
  const save = (item: Historical) => {
    const sender = item.sender;
    const app = sender?.sender_type === "app" && sender.id === secrets.appId;
    const member = sender?.sender_type === "user" && config.allowedMembers.includes(sender.id ?? "");
    if (!item.message_id || item.chat_id !== chat || (!app && !member)) return;
    let text = textOf(item) ?? L(`[${item.msg_type ?? "未知"}消息]`, `[${item.msg_type ?? "unknown"} message]`);
    for (const mention of item.mentions ?? []) if (mention.key) text = text.replaceAll(mention.key, `@${mention.name ?? ""}`);
    const m: IncomingMessage = { tenantId: tenant, chatId: chat, messageId: item.message_id, senderId: sender!.id!,
      senderName: sender!.id!, senderType: app ? "bot" : "user", text, mentionedBot: false,
      mentions: (item.mentions ?? []).map(x => ({ id: x.id ?? "", key: x.key, name: x.name })),
      rootId: item.root_id || undefined, threadId: item.thread_id || undefined, replyToMessageId: item.parent_id || undefined,
      createdAt: Number(item.create_time) };
    const session = store.findSession(tenant, chat, [m.messageId, m.rootId, m.threadId].filter((v): v is string => !!v));
    // Imported history is reference material: never re-inject it as unused background into old topics.
    const changes = store.db.prepare(`INSERT OR IGNORE INTO inbound(tenant,chat,message_id,session_id,root,thread,reply_to,background,used,created_at,data)
      VALUES(?,?,?,?,?,?,?,1,1,?,?)`).run(tenant, chat, m.messageId, session?.id ?? null, m.rootId ?? null, m.threadId ?? null,
      m.replyToMessageId ?? null, m.createdAt, JSON.stringify(m)).changes;
    imported += Number(changes);
    if (item.thread_id && !m.rootId) threads.add(item.thread_id);
  };
  const page = async (type: "chat" | "thread", id: string) => {
    let token: string | undefined;
    do {
      const res = await messages.list({ params: { container_id_type: type, container_id: id, sort_type: "ByCreateTimeAsc",
        page_size: 50, ...(token ? { page_token: token } : {}) } });
      if (res.code !== 0) throw new Error(L(`群历史读取失败 (${res.code})`, `Failed to read group history (${res.code})`));
      for (const item of res.data?.items ?? []) {
        save(item);
        if (type === "chat" && item.thread_id) threads.add(item.thread_id);
      }
      token = res.data?.has_more ? res.data.page_token : undefined;
    } while (token);
  };
  await page("chat", chat);
  for (const thread of threads) {
    try { await page("thread", thread); } catch (e) { log("history_thread_error", { thread, error: errorText(e) }); }
  }
  group.saveState(tenant, chat, { ...(group.state(tenant, chat) ?? { sessionId: "", cursor: 0, topicsAt: 0 }), importedAt: Date.now() });
  log("group_history_imported", { chat: chat.slice(-6), imported, threads: threads.size });
  return { imported, threads: threads.size };
}
