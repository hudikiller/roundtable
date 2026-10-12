import { randomUUID, randomBytes, createHash, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import type { Session, Job } from "../types.js";
import { Store } from "../store.js";
import { writeDurableFile } from "../durable-file.js";
import { L } from "../i18n.js";
import { LEASE_MS, OFFLINE_MS, terminal, CHUNK_BYTES, type Capabilities, type NodeRecord,
  type RunRecord, type Assignment, type Control, type Envelope, type Chunk } from "./protocol.js";

const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const decode = <T>(row: Record<string, unknown> | undefined): T | undefined => row ? JSON.parse(String(row.data)) as T : undefined;
const active = (r: RunRecord): boolean => !terminal(r.state);
export class NodeChoiceRequired extends Error {}

export class RunnerRegistry {
  private key: Buffer;
  assignmentFiles?: (session: Session, job: Job) => { path: string; content: string }[];
  constructor(readonly config: AppConfig, readonly store: Store, key?: Buffer) {
    if (Number(store.query("PRAGMA user_version")[0]?.user_version) > 2) throw new Error(L("控制库版本较新，拒绝降级迁移；请使用匹配版本或备份", "The control database is from a newer version; refusing to migrate down. Use a matching version or a backup"));
    if (key) this.key = key;
    else {
      const path = config.runnerBridge!.enrollmentKeyFile;
      if (!existsSync(path)) { mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 }); writeFileSync(path, randomBytes(32), { mode: 0o600, flag: "wx" }); }
      chmodSync(path, 0o600); this.key = readFileSync(path);
    }
    if (this.key.length !== 32) throw new Error(L("配对回执加密密钥必须为32字节", "The pairing receipt encryption key must be 32 bytes"));
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS runner_nodes(id TEXT PRIMARY KEY,name TEXT NOT NULL,owner TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(owner,name));
      CREATE TABLE IF NOT EXISTS runner_pairs(code_hash TEXT PRIMARY KEY,owner TEXT NOT NULL,name TEXT NOT NULL,expires INTEGER NOT NULL,request_id TEXT,receipt TEXT);
      CREATE TABLE IF NOT EXISTS runner_grants(node TEXT NOT NULL,actor TEXT NOT NULL,project TEXT NOT NULL,PRIMARY KEY(node,actor,project));
      CREATE TABLE IF NOT EXISTS runner_runs(id TEXT NOT NULL,generation INTEGER NOT NULL,job TEXT NOT NULL,session TEXT NOT NULL,node TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(id,generation));
      CREATE INDEX IF NOT EXISTS runner_runs_job ON runner_runs(job,generation);
      CREATE TABLE IF NOT EXISTS runner_controls(id TEXT PRIMARY KEY,node TEXT NOT NULL,run TEXT NOT NULL,generation INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runner_events(run TEXT NOT NULL,generation INTEGER NOT NULL,seq INTEGER NOT NULL,hash TEXT NOT NULL,data TEXT NOT NULL,quarantined INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(run,generation,seq));
      CREATE TABLE IF NOT EXISTS runner_late_events(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,node TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runner_chunks(run TEXT NOT NULL,generation INTEGER NOT NULL,artifact TEXT NOT NULL,part INTEGER NOT NULL,hash TEXT NOT NULL,bytes INTEGER NOT NULL,path TEXT NOT NULL,PRIMARY KEY(run,generation,artifact,part));
      INSERT OR IGNORE INTO migrations VALUES(2,unixepoch()*1000);
      PRAGMA user_version=2;
    `);
    if (!store.query("PRAGMA table_info(runner_events)").some(r => r.name === "quarantined"))
      store.db.exec("ALTER TABLE runner_events ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0");
    for (const s of store.allSessions()) {
      if (!s.projectAlias) { s.projectAlias = s.repoId; s.workspaceId = s.id; store.saveSession(s); }
    }
  }
  private seal(text: string): string {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(text), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  }
  private unseal(text: string): string {
    const data = Buffer.from(text, "base64"), cipher = createDecipheriv("aes-256-gcm", this.key, data.subarray(0, 12));
    cipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString();
  }
  pair(ownerId: string, name: string): string {
    if (!this.config.allowedMembers.includes(ownerId) || !/^[a-zA-Z0-9_-]{1,80}$/.test(name)) throw new Error(L("配对成员或节点名称不合法", "Invalid pairing member or node name"));
    if (this.nodes().some(n => n.ownerId === ownerId && n.name === name && !n.revoked)) throw new Error(L("节点已登记；撤销后显式重新配对", "This node is already registered; revoke it, then pair again explicitly"));
    const code = randomBytes(24).toString("base64url");
    this.store.db.prepare("INSERT INTO runner_pairs VALUES(?,?,?,?,NULL,NULL)").run(hash(code), ownerId, name, Date.now() + 600_000);
    return code;
  }
  enroll(code: string, requestId: string, capabilities: Capabilities): { node: NodeRecord; token: string } {
    return this.store.transaction(() => {
      const row = this.store.db.prepare("SELECT * FROM runner_pairs WHERE code_hash=?").get(hash(code));
      if (!row || Number(row.expires) < Date.now()) throw new Error(L("配对码无效或已过期", "The pairing code is invalid or has expired"));
      if (row.request_id) {
        if (row.request_id !== requestId || !row.receipt) throw new Error(L("配对码已消费", "The pairing code has already been used"));
        return JSON.parse(this.unseal(String(row.receipt))) as { node: NodeRecord; token: string };
      }
      const old = this.nodes().find(n => n.ownerId === row.owner && n.name === row.name);
      if (old && !old.revoked) throw new Error(L("节点已存在", "The node already exists"));
      const token = randomBytes(32).toString("base64url");
      const node: NodeRecord = { id: old?.id ?? randomUUID(), name: String(row.name), ownerId: String(row.owner),
        tokenHash: hash(token), revoked: false, enrolledAt: Date.now(), lastSeen: Date.now(), capabilities };
      this.saveNode(node);
      const receipt = { node, token };
      this.store.db.prepare("UPDATE runner_pairs SET request_id=?,receipt=? WHERE code_hash=?")
        .run(requestId, this.seal(JSON.stringify(receipt)), hash(code));
      this.store.audit(node.ownerId, undefined, "runner_enrolled", { nodeId: node.id, name: node.name });
      return receipt;
    });
  }
  nodes(): NodeRecord[] { return this.store.query("SELECT data FROM runner_nodes").map(r => decode<NodeRecord>(r)!); }
  node(id: string): NodeRecord | undefined { return decode(this.store.query("SELECT data FROM runner_nodes WHERE id=?", [id])[0]); }
  private saveNode(n: NodeRecord): void {
    this.store.db.prepare("INSERT INTO runner_nodes VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
      .run(n.id, n.name, n.ownerId, JSON.stringify(n));
  }
  authenticate(token: string): NodeRecord {
    const digest = hash(token);
    const node = this.nodes().find(n => !n.revoked && timingSafeEqual(Buffer.from(n.tokenHash), Buffer.from(digest)));
    if (!node) throw new Error(L("节点凭据无效或已撤销", "Node credentials are invalid or were revoked"));
    return node;
  }
  private currentNode(n: NodeRecord): NodeRecord {
    const current = this.node(n.id);
    if (!current || current.revoked || current.tokenHash !== n.tokenHash) throw new Error(L("节点已撤销或凭据已更新", "Node was revoked or its credentials were rotated"));
    return current;
  }
  revoke(id: string, actor: string): void {
    const node = this.node(id);
    if (!node || node.ownerId !== actor) throw new Error(L("仅节点所有者可撤销", "Only the node owner can revoke it"));
    node.revoked = true; this.saveNode(node);
    for (const run of this.runs().filter(r => r.nodeId === id && active(r))) this.requestControl(run, "stop");
    this.store.audit(actor, undefined, "runner_revoked", { nodeId: id });
  }
  grant(id: string, actor: string, project: string, owner: string, remove = false): void {
    const n = this.node(id);
    // The machine owner shares it; a Leader may also grant a member someone else's machine.
    if (!n || (n.ownerId !== owner && !this.config.leaders.includes(owner)) || !this.config.allowedMembers.includes(actor) ||
      !n.capabilities.projects.some(p => p.id === project))
      throw new Error(L("节点所有者/Leader、成员或项目授权不匹配", "Node owner/Leader, member or project grant does not match"));
    this.store.db.prepare(remove ? "DELETE FROM runner_grants WHERE node=? AND actor=? AND project=?" :
      "INSERT OR IGNORE INTO runner_grants VALUES(?,?,?)").run(id, actor, project);
    if (remove) for (const r of this.runs().filter(r => r.nodeId === id && active(r))) {
      const job = this.store.getJob(r.jobId)!, session = this.store.getSession(r.sessionId)!;
      if (job.senderId === actor && session.projectAlias === project) this.requestControl(r, "stop");
    }
    this.store.audit(owner, undefined, remove ? "node_grant_removed" : "node_grant_added", { nodeId: id, actor, project });
  }
  shared(n: NodeRecord): boolean {
    return (this.config.runnerBridge?.sharedNodes ?? []).includes(n.name) && this.config.leaders.includes(n.ownerId);
  }
  canUse(n: NodeRecord, actor: string, project?: string): boolean {
    if (n.revoked || !this.config.allowedMembers.includes(actor)) return false;
    if (project && !n.capabilities.projects.some(p => p.id === project)) return false;
    return n.ownerId === actor || this.shared(n) || !!this.store.query("SELECT 1 FROM runner_grants WHERE node=? AND actor=? AND project=?",
      [n.id, actor, project ?? "__discussion"])[0];
  }
  canExecute(s: Session, actor: string): boolean {
    return actor === s.initiatorId || this.config.leaders.includes(actor) || !!s.collaborators?.includes(actor);
  }
  cancelActor(sessionId: string, actor: string): void {
    for (const r of this.runs().filter(r => r.sessionId === sessionId && active(r))) {
      const job = this.store.getJob(r.jobId)!;
      if (job.senderId !== actor || job.mode !== "execute") continue;
      if (["preparing", "assigned"].includes(r.state) && !r.leaseUntil) {
        r.state = "stopped"; r.stopConfirmed = true; this.saveRun(r);
        job.status = "stopped"; job.error = L("任务执行授权已撤销", "The task's run grant was revoked"); this.store.saveJob(job);
      } else this.requestControl(r, "stop");
    }
    for (const job of this.store.jobs("queued").filter(j => j.sessionId === sessionId && j.senderId === actor && j.mode === "execute")) {
      job.status = "failed"; job.error = L("任务执行授权已撤销", "The task's run grant was revoked"); this.store.saveJob(job);
    }
  }
  available(actor: string): NodeRecord[] { return this.nodes().filter(n => this.canUse(n, actor) ||
    n.capabilities.projects.some(p => this.canUse(n, actor, p.id))); }
  select(actor: string, name?: string, project?: string): NodeRecord {
    const target = name ?? (project && this.config.runnerBridge?.projectDefaults?.[project]) ?? this.config.runnerBridge?.defaultNode;
    if (!target) throw new NodeChoiceRequired(L("请在本话题 @ 机器人明确选择一个获准节点，例如“在 Mac mini 上”；原请求已保留，尚未调用模型", "Please @ the bot in this topic and pick a granted node, for example \"on Mac mini\". Your request is kept and no model has been called yet"));
    const candidates = this.nodes().filter(n => (n.name === target || n.id === target) &&
      this.canUse(n, actor, project));
    if (candidates.length !== 1) throw new Error(candidates.length ? L("同名节点不唯一，请明确选择", "More than one node has that name; please pick one explicitly") : L("指定节点/项目未授权或未登记；请先选择可用节点", "That node/project is not granted or not registered; please pick an available node first"));
    const n = candidates[0]!;
    if (Date.now() - n.lastSeen > OFFLINE_MS || !n.capabilities.ready ||
        (project && !n.capabilities.projects.find(p => p.id === project)?.ready)) throw new Error(L("指定节点离线或隔离环境未就绪；不会换机器", "That node is offline or its sandbox is not ready; the task will not move to another machine"));
    return n;
  }
  bind(s: Session, actor: string, name?: string): NodeRecord {
    s.projectAlias ??= s.repoId;
    let n: NodeRecord;
    if (s.runnerId) {
      n = this.node(s.runnerId)!;
      if (!n || !this.canUse(n, actor, s.projectAlias)) throw new Error(L("没有该任务节点/项目的使用权", "You do not have access to this task's node/project"));
      if (name && name !== n.name && name !== n.id) throw new Error(L("已有会话固定在原节点；请另开话题选择其他机器", "This session is pinned to its original node; start a new topic to pick another machine"));
    } else {
      n = this.select(actor, name, s.projectAlias);
      s.runnerId = n.id; s.workspaceId ??= s.id;
    }
    const p = n.capabilities.projects.find(p => p.id === s.projectAlias);
    if (s.profileVersion && p?.version !== s.profileVersion) throw new Error(L("任务绑定的项目配置已改变，需要负责人核对", "The project config bound to this task has changed; the owner needs to check it"));
    s.profileVersion ??= p?.version;
    this.store.saveSession(s); return n;
  }
  /** A task that has only discussed may move once, at its first execution; afterwards it is fixed. */
  rebind(s: Session, actor: string, name: string): NodeRecord {
    if (!s.runnerId) return this.bind(s, actor, name);
    const current = this.node(s.runnerId);
    if (current && (current.name === name || current.id === name)) return this.bind(s, actor, name);
    if (this.store.jobs().some(j => j.sessionId === s.id && (j.mode === "execute" || ["queued", "running", "needs_recovery"].includes(j.status))) ||
      this.runs().some(r => r.sessionId === s.id && active(r)))
      throw new Error(L("已有会话固定在原节点；请另开话题选择其他机器", "This session is pinned to its original node; start a new topic to pick another machine"));
    const n = this.select(actor, name, s.projectAlias ?? s.repoId);
    const previous = current?.name;
    // Codex threads and Docker volumes are local to a machine: start clean on the new node.
    Object.assign(s, { runnerId: n.id, codexThreadId: undefined, profileVersion: undefined, initialized: false,
      baseCommit: undefined, branch: undefined, hooksReady: undefined });
    this.store.audit(actor, s.id, "runner_rebound", { from: previous, to: n.name });
    return this.bind(s, actor, name);
  }
  ownNodes(actor: string): NodeRecord[] { return this.nodes().filter(n => n.ownerId === actor && !n.revoked && !this.shared(n)); }
  migrateLegacy(team: NodeRecord): void {
    const aliases = new Set(this.store.allSessions().filter(s => !s.runnerId).map(s => s.projectAlias ?? s.repoId));
    for (const alias of aliases) if (alias && team.capabilities.projects.some(p => p.id === alias))
      for (const actor of this.config.allowedMembers) this.grant(team.id, actor, alias, team.ownerId);
    for (const s of this.store.allSessions().filter(s => !s.runnerId)) {
      s.runnerId = team.id; s.workspaceId = s.id; s.projectAlias ??= s.repoId;
      s.profileVersion = team.capabilities.projects.find(p => p.id === s.projectAlias)?.version;
      this.store.saveSession(s);
    }
  }
  recoverBridge(): void {
    for (const j of this.store.jobs("running")) {
      const r = this.forJob(j.id);
      if (!r || r.state === "needs_recovery") {
        j.status = "needs_recovery"; j.error = L("旧执行或节点状态待核对；请明确恢复", "The previous run or node state needs checking; please resume explicitly"); this.store.saveJob(j);
      }
    }
    for (const e of this.store.outbox("sending")) {
      e.status = "uncertain"; e.error = L("上次发送中断，先核对平台送达再补发", "The last send was interrupted; check delivery on the platform before resending"); this.store.saveOutbox(e);
    }
    this.expire();
  }
  runs(): RunRecord[] { return this.store.query("SELECT data FROM runner_runs ORDER BY rowid").map(r => decode<RunRecord>(r)!); }
  run(id: string, generation: number): RunRecord | undefined {
    return decode(this.store.query("SELECT data FROM runner_runs WHERE id=? AND generation=?", [id, generation])[0]);
  }
  forJob(id: string): RunRecord | undefined { return this.runs().filter(r => r.jobId === id).at(-1); }
  saveRun(r: RunRecord): void {
    this.store.db.prepare("INSERT INTO runner_runs VALUES(?,?,?,?,?,?,?) ON CONFLICT(id,generation) DO UPDATE SET state=excluded.state,data=excluded.data")
      .run(r.id, r.generation, r.jobId, r.sessionId, r.nodeId, r.state, JSON.stringify(r));
  }
  authorizeRecovery(j: Job, actor: string): void {
    const work = () => {
      const s = this.store.getSession(j.sessionId)!;
      const n = s.runnerId && this.node(s.runnerId);
      const previous = this.forJob(j.id);
      if (!n || !this.canUse(n, actor, s.projectAlias) || !this.canExecute(s, actor))
        throw new Error(L("恢复需要任务执行身份及原节点/项目使用权", "Resuming requires the task's run identity and access to the original node/project"));
      if (j.status !== "needs_recovery" || !previous || !previous.stopConfirmed)
        throw new Error(L("旧代次终止尚未确认，不能恢复", "Termination of the previous generation is not confirmed yet; cannot resume"));
      previous.state = "stopped"; this.saveRun(previous);
      j.status = "queued"; j.senderId = actor; j.error = undefined; j.endedAt = undefined;
      this.store.saveJob(j);
      this.store.audit(actor, s.id, "runner_recovery_authorized", { runId: previous.id, generation: previous.generation });
    };
    if (this.store.db.isTransaction) work();
    else this.store.transaction(work);
  }
  createRun(s: Session, j: Job): RunRecord {
    const previous = this.forJob(j.id);
    if (previous && active(previous)) {
      if (previous.state === "preparing" && j.contextLoaded) { previous.state = "assigned"; this.saveRun(previous); }
      return previous;
    }
    if (!s.runnerId) throw new Error(L("任务未绑定节点", "The task is not bound to a node"));
    const r: RunRecord = { id: previous?.id ?? randomUUID(), generation: (previous?.generation ?? 0) + 1,
      jobId: j.id, sessionId: s.id, nodeId: s.runnerId, state: j.contextLoaded ? "assigned" : "preparing", leaseUntil: 0,
      createdAt: Date.now(), lastSeq: 0 };
    j.runId = r.id; j.generation = r.generation; this.store.saveJob(j); this.saveRun(r); return r;
  }
  dispatchable(s: Session, j: Job): boolean {
    const n = s.runnerId && this.node(s.runnerId);
    if (!n || Date.now() - n.lastSeen > OFFLINE_MS || !n.capabilities.ready || !this.canUse(n, j.senderId, s.projectAlias) ||
      (j.mode === "execute" && !this.canExecute(s, j.senderId))) return false;
    const occupied = this.runs().filter(r => active(r));
    const executing = occupied.filter(r => r.state !== "reported");
    return executing.length < this.config.concurrency &&
      !occupied.some(r => r.sessionId === s.id) && !executing.some(r => r.nodeId === n.id);
  }
  expire(now = Date.now()): void {
    for (const r of this.runs().filter(r => r.state === "running" && r.leaseUntil < now)) {
      r.state = "needs_recovery"; r.error = L("租约失效，执行待对账；不自动重跑", "The lease expired and the run is awaiting reconciliation; it will not be rerun automatically"); this.saveRun(r);
      const j = this.store.getJob(r.jobId)!; j.status = "needs_recovery"; j.error = r.error; this.store.saveJob(j);
      this.requestControl(r, "stop");
    }
    this.store.db.prepare("UPDATE runner_pairs SET receipt=NULL WHERE expires<?").run(now);
  }
  heartbeat(n: NodeRecord, capabilities: Capabilities, running: { runId: string; generation: number }[]): { controls: Control[]; leases: { runId: string; generation: number; leaseMs: number }[] } {
    n = this.currentNode(n);
    n.capabilities = capabilities; n.lastSeen = Date.now(); this.saveNode(n);
    const leases = [];
    for (const ref of running) {
      const r = this.run(ref.runId, ref.generation);
      if (!r || r.nodeId !== n.id) throw new Error(L("拒绝续租其他节点的回合", "Refusing to renew a lease for another node's turn"));
      const j = this.store.getJob(r.jobId)!, s = this.store.getSession(r.sessionId)!;
      // Reported results are already durable and execution has ended. Upload
      // retries do not require an execution lease and never cause model reruns.
      if (r.state === "reported") continue;
      if (r.state !== "running" || r.leaseUntil < Date.now() || !this.canUse(n, j.senderId, s.projectAlias) ||
        (j.mode === "execute" && !this.canExecute(s, j.senderId))) {
        if (!terminal(r.state)) this.requestControl(r, "stop");
        continue;
      }
      r.leaseUntil = Date.now() + LEASE_MS; this.saveRun(r);
      leases.push({ runId: r.id, generation: r.generation, leaseMs: LEASE_MS });
    }
    return { controls: this.controls(n.id), leases };
  }
  claim(n: NodeRecord, free: number): Assignment | undefined {
    n = this.currentNode(n);
    this.expire();
    return this.store.transaction(() => {
      if (!n.capabilities.ready || n.revoked || free <= 0 || Date.now() - n.lastSeen > OFFLINE_MS) return;
      const outstanding = this.runs().filter(r => active(r));
      const busy = outstanding.filter(r => r.state !== "assigned" && r.state !== "reported");
      if (busy.length >= this.config.concurrency || busy.filter(r => r.nodeId === n.id).length >= n.capabilities.capacity) return;
      const r = this.runs().find(r => r.nodeId === n.id && r.state === "assigned" &&
        !outstanding.some(a => a.id !== r.id && a.state !== "assigned" && a.sessionId === r.sessionId) &&
        !this.controls(n.id).some(c => c.type === "stop" && c.runId === r.id && c.generation === r.generation));
      if (!r) return;
      const job = this.store.getJob(r.jobId)!, session = this.store.getSession(r.sessionId)!;
      if (!this.canUse(n, job.senderId, session.projectAlias) || (job.mode === "execute" && !this.canExecute(session, job.senderId)) ||
        session.archived || session.workspaceDeleted)
        throw new Error(L("领取时权限/工作区状态已改变", "Grants or workspace state changed at claim time"));
      if (session.profileVersion && n.capabilities.projects.find(p => p.id === session.projectAlias)?.version !== session.profileVersion)
        throw new Error(L("项目配置版本不匹配", "Project config version mismatch"));
      r.state = "running"; r.leaseUntil = Date.now() + LEASE_MS; this.saveRun(r);
      // Large per-turn files (the group's full record) are built at claim time, never stored in the job row.
      const files = session.kind === "group" ? this.assignmentFiles?.(session, job) : undefined;
      const defaults = this.config.runnerBridge?.defaults;
      const turn = { ...job, model: job.model ?? defaults?.model, effort: job.effort ?? defaults?.effort, ...(files?.length ? { files } : {}) };
      return { protocolVersion: 1, runId: r.id, generation: r.generation, leaseMs: LEASE_MS,
        job: turn, session, profileVersion: session.profileVersion ?? "" };
    });
  }
  requestControl(r: RunRecord, type: Control["type"], text?: string): Control {
    if (type === "steer" && (!r.turnId || r.state !== "running")) throw new Error(L("回合未运行或没有实际turn ID", "The turn is not running or has no actual turn ID"));
    const existing = this.controls(r.nodeId).find(c => c.runId === r.id && c.generation === r.generation && c.type === type && type === "stop");
    if (existing) return existing;
    const c: Control = { id: randomUUID(), runId: r.id, generation: r.generation, type, text, expectedTurnId: r.turnId };
    if (type === "stop" && ["preparing", "assigned"].includes(r.state) && !r.leaseUntil) {
      // No node has received this generation, so termination is provable locally.
      r.state = "stopped"; r.stopConfirmed = true; c.disposition = "accepted"; this.saveRun(r);
      const job = this.store.getJob(r.jobId)!;
      job.status = "stopped"; job.error = L("尚未派发的回合已取消", "The turn was cancelled before it was dispatched"); this.store.saveJob(job);
    }
    this.store.db.prepare("INSERT INTO runner_controls VALUES(?,?,?,?,?)").run(c.id, r.nodeId, r.id, r.generation, JSON.stringify(c));
    return c;
  }
  controls(id: string): Control[] {
    return this.store.query("SELECT data FROM runner_controls WHERE node=?", [id]).map(r => decode<Control>(r)!).filter(c => !c.disposition);
  }
  control(id: string): Control | undefined { return decode(this.store.query("SELECT data FROM runner_controls WHERE id=?", [id])[0]); }
  private checkRun(n: NodeRecord, id: string, generation: number): RunRecord {
    this.currentNode(n);
    const r = this.run(id, generation);
    if (!r || r.nodeId !== n.id) throw new Error(L("回合不属于该节点", "The turn does not belong to this node"));
    return r;
  }
  accept(n: NodeRecord, envelope: Envelope): { ack: number; quarantined?: boolean } {
    return this.store.transaction(() => {
      const r = this.checkRun(n, envelope.runId, envelope.generation);
      const digest = hash(JSON.stringify(envelope));
      const previous = this.store.query("SELECT hash,quarantined FROM runner_events WHERE run=? AND generation=? AND seq=?", [r.id, r.generation, envelope.seq])[0];
      if (previous) {
        if (previous.hash !== digest) throw new Error(L("相同事件序号内容不同", "Different content for the same event sequence number"));
        return { ack: r.lastSeq, ...(previous.quarantined ? { quarantined: true } : {}) };
      }
      const payload = envelope.payload;
      if (["preparing", "assigned"].includes(r.state) && payload.kind !== "control") throw new Error(L("回合尚未领取，拒绝执行事件", "The turn has not been claimed yet; rejecting run events"));
      if (this.forJob(r.jobId)?.generation !== r.generation || r.state === "needs_recovery" || terminal(r.state)) {
        // Confirmed termination is still useful for a generation waiting for recovery.
        const control = payload.kind === "control" ? this.control(payload.controlId) : undefined;
        const validControl = payload.kind === "control" && control && control.runId === r.id && control.generation === r.generation &&
          (control.type === "stop" || (this.forJob(r.jobId)?.generation === r.generation && terminal(r.state)));
        if (!validControl) {
          if (envelope.seq !== r.lastSeq + 1) throw new Error(L("补传事件必须按序", "Backfilled events must be in order"));
          this.store.db.prepare("INSERT INTO runner_events(run,generation,seq,hash,data,quarantined) VALUES(?,?,?,?,?,1)").run(r.id, r.generation, envelope.seq, digest, JSON.stringify(envelope));
          this.store.db.prepare("INSERT INTO runner_late_events(at,node,data) VALUES(?,?,?)").run(Date.now(), n.id, JSON.stringify(envelope));
          r.lastSeq = envelope.seq; this.saveRun(r);
          return { ack: r.lastSeq, quarantined: true };
        }
      }
      if (envelope.seq !== r.lastSeq + 1) throw new Error(L("事件必须按序上传；缺失事件先补传", "Events must be uploaded in order; backfill missing events first"));
      this.store.db.prepare("INSERT INTO runner_events(run,generation,seq,hash,data,quarantined) VALUES(?,?,?,?,?,0)").run(r.id, r.generation, envelope.seq, digest, JSON.stringify(envelope));
      if (payload.kind === "event") {
        if (!(payload.event.type === "text" && !payload.event.final)) this.store.event(r.jobId, payload.event);
        if (payload.event.type === "turn") r.turnId = payload.event.turnId;
        if (payload.event.type === "thread") {
          const s = this.store.getSession(r.sessionId)!;
          if (s.codexThreadId && s.codexThreadId !== payload.event.threadId) throw new Error(L("拒绝替换既有Codex thread ID", "Refusing to replace the existing Codex thread ID"));
          s.codexThreadId = payload.event.threadId; this.store.saveSession(s);
        }
      } else if (payload.kind === "result") {
        if (r.completion) throw new Error(L("回合结果重复且未使用原事件序号", "Duplicate turn result that does not reuse the original event sequence number"));
        const s = this.store.getSession(r.sessionId)!;
        if (payload.completion.checkpoint.workspaceVolume !== s.workspaceVolume || payload.completion.checkpoint.stateVolume !== s.stateVolume)
          throw new Error(L("结果试图更换持久工作区", "The result tried to change the persistent workspace"));
        if (s.codexThreadId && payload.completion.checkpoint.codexThreadId &&
          s.codexThreadId !== payload.completion.checkpoint.codexThreadId) throw new Error(L("结果试图更换Codex会话", "The result tried to change the Codex session"));
        r.completion = payload.completion; r.state = "reported";
        Object.assign(s, payload.completion.checkpoint); this.store.saveSession(s);
      } else if (payload.kind === "control") {
        const c = this.control(payload.controlId);
        if (!c || c.runId !== r.id || c.generation !== r.generation) throw new Error(L("控制回执不匹配", "Control receipt does not match"));
        if (c.type === "steer" && payload.disposition === "accepted" && payload.turnId !== c.expectedTurnId)
          throw new Error(L("插话回执turn ID不匹配", "The steering receipt turn ID does not match"));
        Object.assign(c, { disposition: payload.disposition, error: payload.error, turnId: payload.turnId });
        this.store.db.prepare("UPDATE runner_controls SET data=? WHERE id=?").run(JSON.stringify(c), c.id);
        if (c.type === "stop" && c.disposition === "accepted") {
          r.stopConfirmed = true;
          if (["running", "assigned", "preparing"].includes(r.state)) r.state = "stopped";
        }
        if (c.type === "archive" || c.type === "delete") {
          const s = this.store.getSession(r.sessionId)!;
          if (c.disposition === "accepted") { if (c.type === "archive") s.archived = true; else s.workspaceDeleted = true; }
          s.workspaceAction = undefined; this.store.saveSession(s);
        }
      }
      r.lastSeq = envelope.seq; this.finalize(r); this.saveRun(r);
      return { ack: r.lastSeq };
    });
  }
  chunk(n: NodeRecord, metadata: Chunk, data: Buffer): void {
    const r = this.checkRun(n, metadata.runId, metadata.generation);
    const totalParts = Math.ceil(metadata.artifact.bytes / CHUNK_BYTES);
    const expected = Math.min(CHUNK_BYTES, metadata.artifact.bytes - metadata.index * CHUNK_BYTES);
    if (metadata.index >= totalParts || data.length !== expected || hash(data) !== metadata.sha256) throw new Error(L("成果分块长度或哈希不匹配", "Artifact chunk length or hash does not match"));
    const old = this.store.query("SELECT hash,path FROM runner_chunks WHERE run=? AND generation=? AND artifact=? AND part=?",
      [r.id, r.generation, metadata.artifact.id, metadata.index])[0];
    const manifest = r.completion?.artifact;
    if (!manifest || manifest.id !== metadata.artifact.id || manifest.sha256 !== metadata.artifact.sha256 ||
      manifest.bytes !== metadata.artifact.bytes || manifest.name !== metadata.artifact.name) throw new Error(L("成果元数据未确认或不一致", "Artifact metadata is unconfirmed or inconsistent"));
    if (terminal(r.state)) {
      if (old?.hash === metadata.sha256 && r.completion?.artifact?.sha256 === metadata.artifact.sha256) return;
      throw new Error(L("回合已结束，不能覆盖成果", "The turn has ended; its artifact cannot be overwritten"));
    }
    if (r.state !== "running" && r.state !== "reported") throw new Error(L("回合待恢复，不能覆盖成果", "The turn is awaiting recovery; its artifact cannot be overwritten"));
    if (this.forJob(r.jobId)?.generation !== r.generation) throw new Error(L("旧代次成果", "Artifact from an old generation"));
    if (old) {
      if (old.hash !== metadata.sha256) throw new Error(L("同一分块内容不同", "Different content for the same chunk"));
      if (!existsSync(String(old.path))) writeDurableFile(String(old.path), data, this.config.dataDir);
      this.finalize(r); this.saveRun(r); return;
    }
    const dir = join(this.config.dataDir, "runner-artifacts", r.id, String(r.generation), metadata.artifact.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${metadata.index}.part`);
    writeDurableFile(path, data, this.config.dataDir);
    this.store.db.prepare("INSERT INTO runner_chunks VALUES(?,?,?,?,?,?,?)")
      .run(r.id, r.generation, metadata.artifact.id, metadata.index, metadata.sha256, data.length, path);
    this.finalize(r); this.saveRun(r);
  }
  private finalize(r: RunRecord): void {
    const c = r.completion;
    if (!c || (r.stopConfirmed && r.state !== "reported")) return;
    if (c.artifact) {
      const chunks = this.store.query("SELECT path,bytes FROM runner_chunks WHERE run=? AND generation=? AND artifact=? ORDER BY part",
        [r.id, r.generation, c.artifact.id]);
      if (chunks.length !== Math.ceil(c.artifact.bytes / CHUNK_BYTES)) return;
      const data = Buffer.concat(chunks.map(p => readFileSync(String(p.path))));
      if (data.length !== c.artifact.bytes || hash(data) !== c.artifact.sha256) throw new Error(L("完整成果SHA-256校验失败", "Full artifact SHA-256 check failed"));
      const path = join(this.config.dataDir, "runner-artifacts", r.id, String(r.generation), c.artifact.name);
      writeDurableFile(path, data, this.config.dataDir); r.artifactPath = path;
    } else if (this.store.getJob(r.jobId)?.mode === "execute" && c.result.status === "completed" && c.checkpoint.initialized) {
      c.result.status = "failed"; c.result.error = L("执行完成但没有可校验的成果", "The run finished but produced no verifiable artifact");
    }
    r.state = c.result.cleanupFailed ? "needs_recovery" : c.result.status === "completed" ? "completed" :
      c.result.status === "interrupted" ? "stopped" : "failed";
  }
}
