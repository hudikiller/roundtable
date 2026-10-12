import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, Job, OutboxEntry, Session, RunEvent } from "./types.js";
import type { SQLInputValue } from "node:sqlite";
import { L } from "./i18n.js";

type Row = Record<string, unknown>;
const now = () => Date.now();
const parse = <T>(row: Row | undefined): T | undefined =>
  row ? JSON.parse(row.data as string) as T : undefined;

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, tenant TEXT NOT NULL, chat TEXT NOT NULL, root TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(tenant,chat,root));
      CREATE TABLE IF NOT EXISTS aliases(tenant TEXT NOT NULL, chat TEXT NOT NULL, alias TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id), PRIMARY KEY(tenant,chat,alias));
      CREATE TABLE IF NOT EXISTS inbound(tenant TEXT NOT NULL, chat TEXT NOT NULL, message_id TEXT NOT NULL, session_id TEXT, root TEXT, thread TEXT, reply_to TEXT, background INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(tenant,message_id));
      CREATE INDEX IF NOT EXISTS inbound_session ON inbound(session_id,used,created_at);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), message_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(session_id,message_id));
      CREATE INDEX IF NOT EXISTS job_queue ON jobs(status,created_at);
      CREATE TABLE IF NOT EXISTS events(job_id TEXT NOT NULL REFERENCES jobs(id), seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(job_id,seq));
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, session_id TEXT, job_id TEXT, status TEXT NOT NULL, next_at INTEGER NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS outbox_queue ON outbox(status,next_at);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor TEXT, session_id TEXT, action TEXT NOT NULL, detail TEXT NOT NULL);
      INSERT OR IGNORE INTO migrations VALUES(1, unixepoch()*1000);
    `);
    if (Number(this.query("PRAGMA user_version")[0]?.user_version ?? 0) === 0)
      this.db.exec("PRAGMA user_version=1");
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  insertMessage(m: IncomingMessage, sessionId?: string): boolean {
    return this.db.prepare(`INSERT OR IGNORE INTO inbound
      (tenant,chat,message_id,session_id,root,thread,reply_to,background,created_at,data)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(m.tenantId, m.chatId, m.messageId, sessionId ?? null,
        m.rootId ?? null, m.threadId ?? null, m.replyToMessageId ?? null,
        m.mentionedBot ? 0 : 1, m.createdAt, JSON.stringify(m)).changes > 0;
  }
  getSession(id: string): Session | undefined {
    return parse(this.db.prepare("SELECT data FROM sessions WHERE id=?").get(id));
  }
  allSessions(): Session[] {
    return this.db.prepare("SELECT data FROM sessions").all().map(row => parse<Session>(row)!);
  }
  saveSession(s: Session): void {
    this.db.prepare(`INSERT INTO sessions(id,tenant,chat,root,data) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(s.id, s.tenantId, s.chatId, s.rootMessageId, JSON.stringify(s));
  }
  findSession(tenant: string, chat: string, references: string[]): Session | undefined {
    const ids = new Set<string>();
    for (const alias of references) {
      const row = this.db.prepare("SELECT session_id FROM aliases WHERE tenant=? AND chat=? AND alias=?").get(tenant, chat, alias);
      if (row) ids.add(String(row.session_id));
    }
    if (ids.size > 1) throw new Error(L("消息关联到多个任务线程，需要管理员核对映射", "Message is linked to multiple task threads; an admin needs to check the mapping"));
    return ids.size ? this.getSession([...ids][0]!) : undefined;
  }
  addAliases(s: Session, references: (string | undefined)[]): void {
    for (const alias of new Set(references.filter((v): v is string => !!v))) {
      const previous = this.db.prepare("SELECT session_id FROM aliases WHERE tenant=? AND chat=? AND alias=?").get(s.tenantId, s.chatId, alias);
      if (previous && previous.session_id !== s.id) throw new Error(L("拒绝合并不同任务的线程别名", "Refusing to merge thread aliases of different tasks"));
      this.db.prepare("INSERT OR IGNORE INTO aliases VALUES(?,?,?,?)").run(s.tenantId, s.chatId, alias, s.id);
      this.db.prepare(`UPDATE inbound SET session_id=? WHERE tenant=? AND chat=? AND session_id IS NULL
        AND (root=? OR thread=? OR reply_to=? OR message_id=?)`).run(s.id, s.tenantId, s.chatId, alias, alias, alias, alias);
    }
  }
  background(sessionId: string, before: number): { messages: IncomingMessage[]; truncated: boolean } {
    const rows = this.db.prepare(`SELECT message_id,data FROM inbound WHERE session_id=? AND background=1
      AND used=0 AND created_at<=? ORDER BY created_at DESC, rowid DESC LIMIT 21`).all(sessionId, before);
    let truncated = rows.length > 20;
    const selected: IncomingMessage[] = [];
    let budget = 8000;
    for (const row of rows.slice(0, 20)) {
      const m = parse<IncomingMessage>(row)!;
      const label = `[${m.senderName || m.senderId} | ${m.messageId}] `;
      if (budget <= label.length) { truncated = true; continue; }
      const available = budget - label.length;
      const clipped = m.text.slice(0, available);
      if (clipped.length < m.text.length) truncated = true;
      selected.unshift({ ...m, text: clipped });
      budget -= label.length + clipped.length + 1;
    }
    return { messages: selected, truncated };
  }
  consumeBackground(messages: IncomingMessage[]): void {
    for (const m of messages) this.db.prepare("UPDATE inbound SET used=1 WHERE tenant=? AND message_id=?").run(m.tenantId, m.messageId);
  }
  insertJob(job: Job): void {
    this.db.prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?)")
      .run(job.id, job.sessionId, job.messageId, job.status, job.createdAt, JSON.stringify(job));
  }
  getJob(id: string): Job | undefined {
    return parse(this.db.prepare("SELECT data FROM jobs WHERE id=?").get(id));
  }
  saveJob(job: Job): void {
    this.db.prepare("UPDATE jobs SET status=?,data=? WHERE id=?").run(job.status, JSON.stringify(job), job.id);
  }
  jobs(status?: Job["status"]): Job[] {
    const rows = status
      ? this.db.prepare("SELECT data FROM jobs WHERE status=? ORDER BY created_at,rowid").all(status)
      : this.db.prepare("SELECT data FROM jobs ORDER BY created_at,rowid").all();
    return rows.map(r => parse<Job>(r)!);
  }
  queued(exclude: Set<string>): Job | undefined {
    const blocked = new Set(this.jobs("needs_recovery").map(j => j.sessionId));
    return this.jobs("queued").find(j => !exclude.has(j.sessionId) && !blocked.has(j.sessionId));
  }
  event(jobId: string, event: RunEvent): void {
    this.db.prepare("INSERT INTO events VALUES(?,(SELECT COALESCE(MAX(seq),0)+1 FROM events WHERE job_id=?),?)")
      .run(jobId, jobId, JSON.stringify(event));
  }
  events(jobId: string): RunEvent[] {
    return this.db.prepare("SELECT data FROM events WHERE job_id=? ORDER BY seq").all(jobId).map(r => parse<RunEvent>(r)!);
  }
  enqueueReply(input: Omit<OutboxEntry, "id" | "status" | "attempts" | "nextAttemptAt"> & { id?: string }): string {
    const id = input.id ?? randomUUID();
    const entry: OutboxEntry = { ...input, id, status: "pending", attempts: 0, nextAttemptAt: now() };
    this.db.prepare("INSERT OR IGNORE INTO outbox VALUES(?,?,?,?,?,?,?)")
      .run(id, entry.sessionId ?? null, entry.jobId ?? null, entry.status, entry.nextAttemptAt, now(), JSON.stringify(entry));
    return id;
  }
  saveOutbox(entry: OutboxEntry): void {
    this.db.prepare("UPDATE outbox SET status=?,next_at=?,data=? WHERE id=?")
      .run(entry.status, entry.nextAttemptAt, JSON.stringify(entry), entry.id);
  }
  outbox(status?: OutboxEntry["status"]): OutboxEntry[] {
    const rows = status
      ? this.db.prepare("SELECT data FROM outbox WHERE status=? ORDER BY created_at,rowid").all(status)
      : this.db.prepare("SELECT data FROM outbox ORDER BY created_at,rowid").all();
    return rows.map(r => parse<OutboxEntry>(r)!);
  }
  nextReply(): OutboxEntry | undefined {
    return this.outbox("pending").find(e => e.nextAttemptAt <= now());
  }
  audit(actor: string | undefined, sessionId: string | undefined, action: string, detail: unknown): void {
    this.db.prepare("INSERT INTO audit(at,actor,session_id,action,detail) VALUES(?,?,?,?,?)")
      .run(now(), actor ?? null, sessionId ?? null, action, JSON.stringify(detail));
  }
  recover(): void {
    this.transaction(() => {
      const unresolved = this.db.prepare(`SELECT actor,session_id,detail FROM audit AS request
        WHERE action='steer_requested' AND NOT EXISTS (
          SELECT 1 FROM audit AS resolution WHERE resolution.action IN ('steer_applied','steer_rejected','steer_uncertain')
          AND resolution.session_id=request.session_id
          AND json_extract(resolution.detail,'$.messageId')=json_extract(request.detail,'$.messageId'))`).all();
      for (const row of unresolved) {
        const detail = JSON.parse(String(row.detail)) as { messageId: string; jobId: string };
        this.audit(String(row.actor), String(row.session_id), "steer_uncertain", { ...detail, reason: L("服务在插话确认期间中断，不自动重发", "Service was interrupted while confirming a steering message; not resending automatically") });
        const session = this.getSession(String(row.session_id))!;
        this.enqueueReply({ sessionId: session.id, jobId: detail.jobId, purpose: "control",
          target: { tenantId: session.tenantId, chatId: session.chatId, messageId: session.rootMessageId },
          text: L("上次插话的确认因服务中断而不确定，不会自动重发。请核对已有成果，并明确恢复未结束任务。", "A service interruption left the last steering message unconfirmed, so it won't be resent automatically. Check the existing results and explicitly recover any unfinished task.") });
      }
      for (const job of this.jobs("running")) {
        job.status = "needs_recovery";
        job.error = L("服务中断，执行结果可能包含尚未记录的副作用；请由发起人或 Leader 明确恢复。", "Service was interrupted; the run may have side effects not yet recorded. The initiator or a Leader needs to explicitly recover it.");
        this.saveJob(job);
        const session = this.getSession(job.sessionId)!;
        this.enqueueReply({ sessionId: session.id, jobId: job.id,
          target: { tenantId: session.tenantId, chatId: session.chatId, messageId: session.rootMessageId },
          text: L(`任务 ${job.id.slice(0, 8)} 待恢复：${job.error}`, `Task ${job.id.slice(0, 8)} needs recovery: ${job.error}`) });
      }
      for (const entry of this.outbox("sending")) {
        entry.status = "uncertain";
        entry.error = L("上次发送过程中服务中断；核对平台是否已送达后再决定补发。", "Service was interrupted during the last send. Check whether the platform delivered it before resending.");
        this.saveOutbox(entry);
      }
    });
  }
  query(sql: string, params: SQLInputValue[] = []): Row[] {
    return this.db.prepare(sql).all(...params);
  }
  close(): void { this.db.close(); }
}
