import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import type { IncomingMessage, Job, OutboxEntry, Session } from "./types.js";
import type { Store } from "./store.js";
import type { RunnerRegistry } from "./runner/registry.js";
import type { Summarizer, TaskBrief } from "./intent.js";
import { log, errorText } from "./log.js";

/** Final answer shape of every group-session turn (App Server outputSchema). */
export const groupOutputSchema = {
  type: "object", additionalProperties: false, required: ["answer", "remember", "assignments"],
  properties: {
    answer: { type: "string" },
    remember: { type: "array", items: { type: "string" } },
    assignments: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "owner_open_id", "request"],
      properties: { title: { type: "string" }, owner_open_id: { type: "string" }, request: { type: "string" } } } },
  },
};
export const groupOutputGuide = `最终回答必须是 JSON：{"answer": 发到群里的回答正文, "remember": 值得长期记住的稳定事实数组, "assignments": 分工数组}。
- answer：直接给成员看的中文正文，可用 <at user_id="open_id"></at> 指人；不需要回复时 answer 填 NO_REPLY。
- remember：只放本次讨论新确定的约定、决定、负责人等稳定事实（每条一句），没有就填 []；不要重复群记忆已有内容。
- assignments：只有被要求分工、或讨论明确产生了分工时才填；每项 {title 简短标题, owner_open_id 只能取群成员 open_id, request 交给负责人的具体要求}；否则填 []。
  填了 assignments 时，answer 里不要再逐条列出分工，系统会把分工清单附在 answer 后面。`;

export interface GroupState {
  sessionId: string;
  /** Inbound rowid already given to the group agent. */
  cursor: number;
  /** Time up to which topic progress was reported. */
  topicsAt: number;
  importedAt?: number;
  /** Top-level messages since the bot last engaged in the main timeline (Claude Tag ~100 pause). */
  unengaged?: number;
  autoReply?: "conservative" | "mention_only";
  memory?: { id: number; text: string; by: string; at: number }[];
  /** Group-wide default model and reasoning effort for new turns (set by a Leader). */
  defaults?: { model?: string; effort?: string };
  /** Latest proposed division of work, ready for "open topics for these". */
  assignments?: { title: string; owner: string; request: string; by: string; at: number }[];
}
const clock = (at: number) => new Date(at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

/** The long-lived main-group session (Claude Tag "channel session") and its full record. */
export class GroupAgent {
  constructor(readonly config: AppConfig, readonly store: Store, readonly registry: RunnerRegistry,
    private summarizer?: Summarizer) {
    store.db.exec("CREATE TABLE IF NOT EXISTS group_sessions(tenant TEXT NOT NULL,chat TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(tenant,chat))");
  }
  get settings() { return this.config.runnerBridge?.groupAgent; }
  get enabled(): boolean { return !!this.settings?.enabled; }
  state(tenant: string, chat: string): GroupState | undefined {
    const row = this.store.query("SELECT data FROM group_sessions WHERE tenant=? AND chat=?", [tenant, chat])[0];
    return row ? JSON.parse(String(row.data)) as GroupState : undefined;
  }
  saveState(tenant: string, chat: string, state: GroupState): void {
    this.store.db.prepare("INSERT INTO group_sessions VALUES(?,?,?) ON CONFLICT(tenant,chat) DO UPDATE SET data=excluded.data")
      .run(tenant, chat, JSON.stringify(state));
  }
  /** Create or return the group's session, bound to the shared server node. */
  ensure(tenant: string, chat: string, actor: string): Session {
    const existing = this.state(tenant, chat);
    const found = existing && this.store.getSession(existing.sessionId);
    if (found) return found;
    const id = randomUUID();
    const session: Session = { id, tenantId: tenant, chatId: chat, rootMessageId: `group:${chat}`, initiatorId: actor,
      kind: "group", workspaceVolume: `fc-work-${id}`, stateVolume: `fc-state-${id}`,
      repoId: this.config.defaultRepo ?? this.config.repositories[0]?.id, initialized: false, review: "open", createdAt: Date.now() };
    this.registry.bind(session, actor, this.settings?.node ?? "team-runner");
    // Keep memory, settings, import marker and cursors recorded before the session existed.
    this.saveState(tenant, chat, { cursor: 0, topicsAt: 0, ...existing, sessionId: id });
    return session;
  }
  private names(chat: string): Map<string, string> {
    const names = new Map<string, string>();
    for (const row of this.store.query("SELECT data FROM inbound WHERE chat=? ORDER BY rowid DESC LIMIT 2000", [chat])) {
      const m = JSON.parse(String(row.data)) as IncomingMessage;
      if (m.senderName && m.senderName !== m.senderId && !names.has(m.senderId)) names.set(m.senderId, m.senderName);
      for (const x of m.mentions) if (x.name && x.id && !names.has(x.id)) names.set(x.id, x.name);
    }
    return names;
  }
  members(chat: string): string {
    const names = this.names(chat);
    return this.config.allowedMembers.map(id => `${names.get(id) ?? "成员"}=${id}`).join("，");
  }
  private line(m: IncomingMessage, names: Map<string, string>): string {
    const who = m.senderType === "bot" ? "机器人" : names.get(m.senderId) ?? m.senderName ?? m.senderId;
    return `[${clock(m.createdAt)} ${who}] ${m.text.replace(/\s+/g, " ").trim()}`;
  }
  private compress = async (lines: string[], budget: number, label: string): Promise<string> => {
    const text = lines.join("\n");
    if (text.length <= budget) return text;
    // Keep the most recent two thirds verbatim; compress the rest rather than dropping it.
    const recent: string[] = [];
    let used = 0;
    for (let i = lines.length - 1; i >= 0 && used + lines[i]!.length < budget * 2 / 3; i--) { recent.unshift(lines[i]!); used += lines[i]!.length + 1; }
    const older = lines.slice(0, lines.length - recent.length).join("\n");
    let digest = "";
    try { digest = this.summarizer ? await this.summarizer.summarize(older, Math.floor(budget / 3)) : ""; }
    catch (e) { log("group_feed_summary_error", { error: errorText(e) }); }
    return `${digest ? `【更早${label}要点（共 ${lines.length - recent.length} 条，原文见 history.md）】\n${digest}\n` :
      `【更早的 ${lines.length - recent.length} 条${label}未展开，原文见 history.md】\n`}【近期原文】\n${recent.join("\n")}`;
  };
  /** Bot replies already present as imported messages are skipped so nothing is counted twice. */
  private botReplies(chat: string, since: number, until: number): { at: number; root: string; text: string }[] {
    const imported = new Set(this.store.query("SELECT message_id FROM inbound WHERE chat=?", [chat]).map(r => String(r.message_id)));
    return this.store.query("SELECT created_at,data FROM outbox WHERE status='sent' AND created_at>? AND created_at<=? ORDER BY created_at,rowid", [since, until])
      .map(r => ({ at: Number(r.created_at), entry: JSON.parse(String(r.data)) as OutboxEntry }))
      .filter(({ entry }) => entry.target.chatId === chat && !!entry.text && entry.purpose !== "acknowledgement" &&
        !(entry.sentMessageId && imported.has(entry.sentMessageId)))
      .map(({ at, entry }) => {
        const s = entry.sessionId ? this.store.getSession(entry.sessionId) : undefined;
        return { at, root: s && s.kind !== "group" ? s.rootMessageId : entry.target.messageId, text: entry.text!.replace(/\s+/g, " ").slice(0, 2000) };
      });
  }
  /**
   * Everything said in the group since the last turn: the main timeline and, per topic, every
   * member reply and bot reply. Newest kept verbatim; older backlog compressed, never dropped.
   */
  async feed(tenant: string, chat: string, uptoRowid?: number): Promise<{ text: string; topics: string; cursor: number; topicsAt: number }> {
    const state = this.state(tenant, chat) ?? { sessionId: "", cursor: 0, topicsAt: 0 };
    const rows = this.store.query(`SELECT rowid,data FROM inbound WHERE tenant=? AND chat=? AND rowid>?
      ${uptoRowid ? "AND rowid<=?" : ""} ORDER BY created_at,rowid`, [tenant, chat, state.cursor, ...(uptoRowid ? [uptoRowid] : [])]);
    const names = this.names(chat);
    const main: string[] = [];
    const topics = new Map<string, { at: number; text: string }[]>();
    for (const row of rows) {
      const m = JSON.parse(String(row.data)) as IncomingMessage;
      if (m.text === "[unauthorized]") continue;
      if (m.rootId && m.threadId) {
        const list = topics.get(m.rootId) ?? []; list.push({ at: m.createdAt, text: this.line(m, names) }); topics.set(m.rootId, list);
      } else main.push(this.line(m, names));
    }
    const cursor = rows.reduce((max, r) => Math.max(max, Number(r.rowid)), state.cursor);
    const topicsAt = Date.now();
    for (const reply of this.botReplies(chat, state.topicsAt, topicsAt)) {
      const list = topics.get(reply.root) ?? []; list.push({ at: reply.at, text: `[${clock(reply.at)} 机器人] ${reply.text}` }); topics.set(reply.root, list);
    }
    const budget = this.settings?.feedBudgetChars ?? 60_000;
    const topicLines = [...topics.entries()].sort((a, b) => a[1][0]!.at - b[1][0]!.at).flatMap(([root, list]) => {
      const owner = this.store.findSession(tenant, chat, [root]);
      return [`## 话题 ${root.slice(-8)}${owner ? `（负责人 ${names.get(owner.initiatorId) ?? owner.initiatorId}）` : ""}`,
        ...list.sort((a, b) => a.at - b.at).map(x => x.text)];
    });
    return { text: await this.compress(main, Math.floor(budget / 2), "主群消息"),
      topics: await this.compress(topicLines, Math.floor(budget / 2), "话题消息"), cursor, topicsAt };
  }
  /** Authoritative facts from the control database, so the agent never infers them from chat. */
  systemState(tenant: string, chat: string): string {
    const names = this.names(chat), who = (id: string) => `${names.get(id) ?? "成员"}(${id})`;
    const nodes = this.registry.nodes().filter(n => !n.revoked);
    const grants = this.store.query("SELECT node,actor,project FROM runner_grants");
    const lines = nodes.map(n => `- ${n.name}：登记人 ${who(n.ownerId)}${this.registry.shared(n) ? "，团队共享（所有获准成员可用）" : ""}；` +
      `${Date.now() - n.lastSeen <= 30_000 && n.capabilities.ready ? "在线" : "离线"}；授权：${grants.filter(g => g.node === n.id)
        .map(g => `${who(String(g.actor))}/${g.project}`).join("、") || "无"}`);
    const tasks = this.store.allSessions().filter(s => s.tenantId === tenant && s.chatId === chat && s.kind !== "group")
      .map(s => ({ s, job: this.store.jobs().filter(j => j.sessionId === s.id).at(-1) }))
      .filter(x => x.job && ["queued", "running", "needs_recovery"].includes(x.job.status))
      .map(({ s, job }) => `- 话题 ${s.rootMessageId.slice(-8)}：负责人 ${who(s.initiatorId)}，${job!.mode === "execute" ? "执行" : "讨论"}，${job!.status}`);
    return `执行机器与授权：\n${lines.join("\n") || "（无）"}\n进行中的任务：\n${tasks.join("\n") || "（无）"}`;
  }
  advance(tenant: string, chat: string, cursor: number, topicsAt: number): void {
    const state = this.state(tenant, chat);
    if (!state) return;
    state.cursor = Math.max(state.cursor, cursor); state.topicsAt = Math.max(state.topicsAt, topicsAt);
    this.saveState(tenant, chat, state);
  }
  private mutate(tenant: string, chat: string, change: (state: GroupState) => void): GroupState {
    const state = this.state(tenant, chat) ?? { sessionId: "", cursor: 0, topicsAt: 0 };
    change(state); this.saveState(tenant, chat, state); return state;
  }
  /** The bot engaged in the main timeline (an @ or its own reply): resume reading every message. */
  engaged(tenant: string, chat: string): void { this.mutate(tenant, chat, s => { s.unengaged = 0; }); }
  /** Count one more top-level message without engagement; true once judgement is paused. */
  noteUnengaged(tenant: string, chat: string): boolean {
    const state = this.mutate(tenant, chat, s => { s.unengaged = (s.unengaged ?? 0) + 1; });
    return (state.unengaged ?? 0) > (this.settings?.pauseAfter ?? 100);
  }
  defaults(tenant: string, chat: string): { model?: string; effort?: string } { return this.state(tenant, chat)?.defaults ?? {}; }
  setDefaults(tenant: string, chat: string, change: { model?: string; effort?: string }): void {
    this.mutate(tenant, chat, s => { s.defaults = { ...s.defaults, ...Object.fromEntries(Object.entries(change).filter(([, v]) => v)) }; });
  }
  autoReply(tenant: string, chat: string): "conservative" | "mention_only" { return this.state(tenant, chat)?.autoReply ?? "conservative"; }
  setAutoReply(tenant: string, chat: string, mode: "conservative" | "mention_only"): void { this.mutate(tenant, chat, s => { s.autoReply = mode; }); }
  memory(tenant: string, chat: string): { id: number; text: string }[] { return this.state(tenant, chat)?.memory ?? []; }
  remember(tenant: string, chat: string, text: string, by: string): number {
    let id = 0;
    this.mutate(tenant, chat, s => {
      s.memory ??= [];
      if (s.memory.some(x => x.text === text)) { id = s.memory.find(x => x.text === text)!.id; return; }
      id = Math.max(0, ...s.memory.map(x => x.id)) + 1;
      s.memory.push({ id, text: text.slice(0, 500), by, at: Date.now() });
      if (s.memory.length > 100) s.memory.shift();
    });
    return id;
  }
  forget(tenant: string, chat: string, ref: string): string | undefined {
    let removed: string | undefined;
    this.mutate(tenant, chat, s => {
      const n = Number(ref.replace(/^第|条$/g, ""));
      const index = (s.memory ?? []).findIndex(x => (Number.isInteger(n) && x.id === n) || (ref.length > 1 && x.text.includes(ref)));
      if (index >= 0) removed = s.memory!.splice(index, 1)[0]!.text;
    });
    return removed;
  }
  memoryText(tenant: string, chat: string): string {
    return this.memory(tenant, chat).map(x => `${x.id}. ${x.text}`).join("\n");
  }
  recentMain(tenant: string, chat: string, limit = 15): string[] {
    const names = this.names(chat);
    return this.store.query(`SELECT data FROM inbound WHERE tenant=? AND chat=? AND (root IS NULL OR thread IS NULL)
      ORDER BY created_at DESC,rowid DESC LIMIT ?`, [tenant, chat, limit]).reverse()
      .map(r => this.line(JSON.parse(String(r.data)) as IncomingMessage, names));
  }
  /** Topics with unfinished work or activity in the last six hours: hand-off candidates, newest first. */
  activeTasks(tenant: string, chat: string): (TaskBrief & { session: Session })[] {
    const names = this.names(chat), since = Date.now() - 6 * 3_600_000;
    const request = (prompt: string) => (prompt.split("当前请求：\n").at(-1) ?? "").replace(/\s+/g, " ").slice(0, 160);
    return this.store.allSessions().filter(s => s.tenantId === tenant && s.chatId === chat && s.kind !== "group" && !s.archived)
      .flatMap(s => {
        const jobs = this.store.jobs().filter(j => j.sessionId === s.id && !j.unprompted);
        const last = Math.max(s.createdAt, ...jobs.map(j => j.endedAt ?? j.createdAt));
        const live = jobs.some(j => ["queued", "running", "needs_recovery"].includes(j.status)) || last > since;
        if (!live || (!jobs.length && !s.title)) return [];
        const latest = jobs.at(-1);
        return [{ topic: s.rootMessageId, title: (s.title ?? (jobs[0] ? request(jobs[0].prompt) : "")).slice(0, 80),
          owner: names.get(s.initiatorId) ?? s.initiatorId, status: latest ? `${latest.mode === "execute" ? "执行" : "讨论"}·${latest.status}` : "待开始",
          latest: latest ? request(latest.prompt) : "", lastActive: clock(last), session: s, at: last }];
      }).sort((a, b) => b.at - a.at).slice(0, 20).map(({ at: _at, ...rest }) => rest);
  }
  /** Turn the group agent's JSON answer into the message, memory notes and a proposed division of work. */
  beforeDeliver(job: Job): void {
    if (!job.outputSchema || job.status !== "completed" || !job.response) return;
    const group = this.store.getSession(job.sessionId);
    if (!group || group.kind !== "group") return;
    let parsed: { answer?: unknown; remember?: unknown; assignments?: unknown };
    try { parsed = JSON.parse(job.response); } catch { return; } // Plain text answers are delivered as they are.
    const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
    if (!answer) return;
    for (const note of Array.isArray(parsed.remember) ? parsed.remember : [])
      if (typeof note === "string" && note.trim()) this.remember(group.tenantId, group.chatId, note.trim(), "主群 Agent");
    const assignments = (Array.isArray(parsed.assignments) ? parsed.assignments : []).flatMap(a => {
      const item = a as { title?: unknown; owner_open_id?: unknown; request?: unknown };
      return typeof item.title === "string" && typeof item.request === "string" && typeof item.owner_open_id === "string" &&
        this.config.allowedMembers.includes(item.owner_open_id)
        ? [{ title: item.title.slice(0, 80), owner: item.owner_open_id, request: item.request.slice(0, 2000), by: job.senderId, at: Date.now() }] : [];
    }).slice(0, 12);
    if (/^NO_REPLY\b/.test(answer)) { job.response = "NO_REPLY"; return; }
    let text = answer;
    if (assignments.length && answer !== "NO_REPLY") {
      this.mutate(group.tenantId, group.chatId, s => { s.assignments = assignments; });
      text += `\n\n分工：\n${assignments.map((a, i) => `${i + 1}. ${a.title} —— <at user_id="${a.owner}"></at>：${a.request}`).join("\n")}` +
        "\n\n需要的话说“按这个分工开话题”，我会为每项开一个话题，由负责人在话题里推进。";
    }
    job.response = text;
  }
  /** Post one topic per proposed assignment; each becomes a topic session owned by the assignee. */
  openAssignments(tenant: string, chat: string, actor: string): { posted: number; error?: string } {
    const state = this.state(tenant, chat);
    const list = (state?.assignments ?? []).filter(a => Date.now() - a.at < 24 * 3_600_000);
    if (!list.length) return { posted: 0, error: "最近没有待开的分工。可以先让我按讨论总结并分工。" };
    if (!this.config.leaders.includes(actor) && !list.every(a => a.by === actor))
      return { posted: 0, error: "只有发起这次分工的人或 Leader 可以按分工开话题。" };
    for (const a of list)
      this.store.enqueueReply({ purpose: "post", target: { tenantId: tenant, chatId: chat, messageId: "" },
        post: { initiatorId: a.owner, title: a.title, request: a.request },
        text: `【分工】${a.title}\n负责人：<at user_id="${a.owner}"></at>\n${a.request}\n\n负责人在本话题回复即可开始；需要改代码时直接说要改什么，我会按话题执行。` });
    this.mutate(tenant, chat, s => { s.assignments = []; });
    return { posted: list.length };
  }
  /** A posted assignment message becomes the root of a topic session owned by the assignee. */
  afterPost(entry: OutboxEntry, messageId: string): void {
    if (!entry.post) return;
    const id = randomUUID();
    const topic: Session = { id, tenantId: entry.target.tenantId, chatId: entry.target.chatId, rootMessageId: messageId,
      initiatorId: entry.post.initiatorId, workspaceVolume: `fc-work-${id}`, stateVolume: `fc-state-${id}`,
      repoId: this.config.defaultRepo ?? this.config.repositories[0]?.id, initialized: false, review: "open", createdAt: Date.now(),
      title: entry.post.title, seedContext: `主群讨论后的分工任务：${entry.post.title}\n要求：${entry.post.request}` };
    this.registry.bind(topic, entry.post.initiatorId);
    this.store.addAliases(topic, [messageId]);
    this.store.audit(entry.post.initiatorId, id, "assignment_topic_opened", { messageId, title: entry.post.title });
  }
  /** After a group turn: advance the feed cursor and seed the asker's topic with the group's answer. */
  afterTurn(job: Job): void {
    if (!job.topicSessionId || job.status !== "completed") return;
    const group = this.store.getSession(job.sessionId);
    if (!group || group.kind !== "group") return;
    this.advance(group.tenantId, group.chatId, job.feedCursor ?? 0, job.createdAt);
    if (/^\s*NO_REPLY\b/.test(job.response ?? "")) return;
    if (job.unprompted) this.engaged(group.tenantId, group.chatId);
    const topic = this.store.getSession(job.topicSessionId);
    if (!topic) return;
    const question = job.prompt.split("回答会发在这条消息下的话题里）：\n").at(-1) ?? "";
    topic.seedContext = `用户：${question.slice(0, 2000)}\n主群 Agent：${(job.response ?? "").slice(0, 6000)}`;
    this.store.saveSession(topic);
  }
  /** Complete raw record of the group (main timeline, topics and bot replies), newest kept within the byte budget. */
  history(tenant: string, chat: string): string {
    const names = this.names(chat);
    const entries: { at: number; text: string }[] = [];
    for (const row of this.store.query("SELECT data FROM inbound WHERE tenant=? AND chat=?", [tenant, chat])) {
      const m = JSON.parse(String(row.data)) as IncomingMessage;
      if (m.text === "[unauthorized]") continue;
      entries.push({ at: m.createdAt, text: `${m.rootId && m.threadId ? `  ↳话题 ${m.rootId.slice(-8)} ` : ""}${this.line(m, names)}` });
    }
    const imported = new Set(this.store.query("SELECT message_id FROM inbound WHERE chat=?", [chat]).map(r => String(r.message_id)));
    for (const e of this.store.outbox().filter(e => e.target.chatId === chat && e.status === "sent" && e.text &&
        !(e.sentMessageId && imported.has(e.sentMessageId)))) {
      const s = e.sessionId ? this.store.getSession(e.sessionId) : undefined;
      const at = Number(this.store.query("SELECT created_at FROM outbox WHERE id=?", [e.id])[0]?.created_at ?? 0);
      entries.push({ at, text: `  ↳话题 ${(s?.rootMessageId ?? e.target.messageId).slice(-8)} [${clock(at)} 机器人] ${e.text!.replace(/\s+/g, " ").slice(0, 2000)}` });
    }
    entries.sort((a, b) => a.at - b.at);
    const max = this.settings?.historyMaxBytes ?? 4 * 1024 * 1024;
    const kept: string[] = [];
    let bytes = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      const size = Buffer.byteLength(entries[i]!.text, "utf8") + 1;
      if (bytes + size > max) { kept.unshift(`（更早的 ${i + 1} 条记录超过 ${max} 字节上限，未写入本文件）`); break; }
      kept.unshift(entries[i]!.text); bytes += size;
    }
    return `# 群完整记录（主群与话题，按时间）\n生成时间：${clock(Date.now())}\n\n${kept.join("\n")}\n`;
  }
}
