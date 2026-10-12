import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { configSchema } from "../src/config.js";
import { Store } from "../src/store.js";
import { RunnerRegistry } from "../src/runner/registry.js";
import { NodeJournal } from "../src/runner/journal.js";
import { RemoteExecutor } from "../src/runner/remote.js";
import { RunnerApi } from "../src/runner/api.js";
import { BridgeClient } from "../src/runner/client.js";
import { createTls } from "../src/runner/tls.js";
import { configHash, ready } from "../src/runner/doctor.js";
import { nodeConfigSchema } from "../src/runner/config.js";
import { nodeLock } from "../src/runner/lock.js";
import { checkpoint, artifactSchema, CHUNK_BYTES, type Capabilities, type NodeRecord, type Envelope, type ArtifactInfo } from "../src/runner/protocol.js";
import { Router } from "../src/router.js";
import { Jobs } from "../src/jobs.js";
import type { Intent, IntentNode } from "../src/intent.js";
import { GroupAgent } from "../src/group.js";
import { toCard } from "../src/feishu.js";
import { ProgressCards } from "../src/progress.js";
import { importGroupHistory } from "../src/history-import.js";
import type { Session, Job, IncomingMessage, RunEvent, OutboxEntry } from "../src/types.js";

const capabilities: Capabilities = { protocolVersion: 1, os: "test", arch: "test", ready: true, capacity: 1,
  projects: [{ id: "feedbackdesk", version: "a".repeat(64), ready: true, profileLabel: "project API" }] };
function env() {
  const dir = mkdtempSync(join(tmpdir(), "fc-runner-"));
  const config = configSchema.parse({ tenantId: "t", allowedChats: ["chat"], allowedMembers: ["alice", "bob", "leader"],
    leaders: ["leader"], receiveBackground: true, threadFollowups: "members", naturalExecution: true,
    provider: { baseUrl: "https://example.org/v1", model: "test" }, defaultRepo: "feedbackdesk",
    repositories: [{ id: "feedbackdesk", path: dir }], dataDir: dir,
    runnerBridge: { keyFile: join(dir, "key"), certFile: join(dir, "cert"), enrollmentKeyFile: join(dir, "enrollment"),
      defaultNode: "team-runner", feishuEnabled: false } });
  const store = new Store(join(dir, "control.sqlite")), registry = new RunnerRegistry(config, store, randomBytes(32));
  function node(name = "team-runner", owner = "alice") {
    const code = registry.pair(owner, name); const enrolled = registry.enroll(code, randomUUID(), structuredClone(capabilities));
    return { ...enrolled, code };
  }
  function session(n: NodeRecord, owner = "alice"): Session {
    const id = randomUUID();
    const s: Session = { id, tenantId: "t", chatId: "chat", rootMessageId: `om_${id}`, initiatorId: owner,
      runnerId: n.id, repoId: "feedbackdesk", projectAlias: "feedbackdesk", profileVersion: "a".repeat(64),
      workspaceVolume: `work-${id}`, stateVolume: `state-${id}`, initialized: false, review: "open", createdAt: Date.now() };
    store.saveSession(s); store.addAliases(s, [s.rootMessageId]); return s;
  }
  function job(s: Session, actor = "alice", prepared = true): Job {
    const j: Job = { id: randomUUID(), sessionId: s.id, messageId: `om_${randomUUID()}`, senderId: actor,
      mode: "execute", prompt: "测试", status: "running", contextLoaded: prepared, createdAt: Date.now() };
    store.insertJob(j); return j;
  }
  return { dir, config, store, registry, node, session, job, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const digest = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

test("配对码单次消费，相同请求丢回执可重取同一节点，凭据不明文落库", () => {
  const e = env();
  try {
    const code = e.registry.pair("alice", "mac-mini"), requestId = randomUUID();
    const a = e.registry.enroll(code, requestId, capabilities), b = e.registry.enroll(code, requestId, capabilities);
    assert.equal(a.node.id, b.node.id); assert.equal(a.token, b.token); assert.equal(e.registry.nodes().length, 1);
    assert.throws(() => e.registry.enroll(code, randomUUID(), capabilities), /已消费/);
    assert.ok(!JSON.stringify(e.store.query("SELECT * FROM runner_pairs")).includes(a.token));
    assert.ok(!JSON.stringify(e.store.query("SELECT * FROM runner_nodes")).includes(a.token));
    e.store.db.prepare("UPDATE runner_pairs SET expires=0").run();
    assert.throws(() => e.registry.enroll(code, requestId, capabilities), /过期/);
  } finally { e.close(); }
});
test("撤销后，已认证旧心跳不能复活凭据，重新配对保留节点ID", () => {
  const e = env();
  try {
    const n = e.node("mac-mini"); const stale = e.registry.authenticate(n.token);
    e.registry.revoke(n.node.id, "alice");
    assert.throws(() => e.registry.heartbeat(stale, capabilities, []), /撤销/);
    assert.throws(() => e.registry.authenticate(n.token), /撤销/);
    const again = e.node("mac-mini"); assert.equal(again.node.id, n.node.id); assert.notEqual(again.token, n.token);
  } finally { e.close(); }
});
test("撤销未领取节点任务立即取消，重配不会领取旧代次", () => {
  const e = env();
  try {
    const n = e.node("mac-mini"), s = e.session(n.node), j = e.job(s), r = e.registry.createRun(s, j);
    e.registry.revoke(n.node.id, "alice");
    assert.equal(e.registry.run(r.id, r.generation)!.state, "stopped");
    assert.equal(e.store.getJob(j.id)!.status, "stopped");
    const again = e.node("mac-mini");
    assert.equal(e.registry.claim(again.node, 1), undefined);
    assert.equal(e.registry.dispatchable(e.session(again.node), e.job(e.session(again.node))), true);
  } finally { e.close(); }
});
test("节点、项目和任务执行角色取交集，Leader不能绕过私人节点授权", () => {
  const e = env();
  try {
    const n = e.node("mac-mini"), s = e.session(n.node), j = e.job(s, "bob");
    e.registry.createRun(s, j);
    assert.equal(e.registry.dispatchable(s, j), false);
    e.registry.grant(n.node.id, "bob", "feedbackdesk", "alice");
    assert.throws(() => e.registry.claim(n.node, 1), /权限/);
    s.collaborators = ["bob"]; e.store.saveSession(s);
    assert.equal(e.registry.claim(n.node, 1)?.job.id, j.id);
    assert.throws(() => e.registry.bind(s, "leader"), /使用权/);
    s.collaborators = []; e.store.saveSession(s); e.registry.cancelActor(s.id, "bob");
    assert.ok(e.registry.controls(n.node.id).some(c => c.type === "stop"));
  } finally { e.close(); }
});
test("原子领取按全局2、节点1、同会话串行限制", () => {
  const e = env();
  try {
    const a = e.node("mac-mini").node, b = e.node("macbook-air").node, c = e.node().node;
    const sa = e.session(a), ja = e.job(sa); e.registry.createRun(sa, ja);
    const sa2 = e.session(a), ja2 = e.job(sa2); e.registry.createRun(sa2, ja2);
    const sb = e.session(b), jb = e.job(sb); e.registry.createRun(sb, jb);
    const sc = e.session(c), jc = e.job(sc); e.registry.createRun(sc, jc);
    assert.equal(e.registry.claim(a, 1)?.job.id, ja.id); assert.equal(e.registry.claim(a, 1), undefined);
    assert.equal(e.registry.claim(b, 1)?.job.id, jb.id); assert.equal(e.registry.claim(c, 1), undefined);
    assert.equal(e.registry.claim(b, 1), undefined);
  } finally { e.close(); }
});
test("未领取不能上传执行事件，其他节点不能续租或上传", () => {
  const e = env();
  try {
    const a = e.node("mac-mini").node, b = e.node("macbook-air").node, s = e.session(a), j = e.job(s);
    const r = e.registry.createRun(s, j);
    const ev: Envelope = { runId: r.id, generation: r.generation, seq: 1, payload: { kind: "started" } };
    assert.throws(() => e.registry.accept(a, ev), /尚未领取/);
    e.registry.claim(a, 1);
    assert.throws(() => e.registry.accept(b, ev), /不属于/);
    assert.throws(() => e.registry.heartbeat(b, capabilities, [{ runId: r.id, generation: r.generation }]), /其他节点/);
  } finally { e.close(); }
});
test("重复事件只落库一次，相同seq异内容拒绝，过期thread事件隔离不覆盖会话", async () => {
  const e = env();
  try {
    const n = e.node().node, s = e.session(n), j = e.job(s), r = e.registry.createRun(s, j); e.registry.claim(n, 1);
    const event: Envelope = { runId: r.id, generation: 1, seq: 1, payload: { kind: "event", event: { type: "thread", threadId: "original-thread" } } };
    assert.equal(e.registry.accept(n, event).ack, 1); assert.equal(e.registry.accept(n, event).ack, 1);
    assert.equal(e.store.events(j.id).length, 1);
    assert.throws(() => e.registry.accept(n, { ...event, payload: { kind: "started" } }), /内容不同/);
    const live = e.registry.run(r.id, 1)!; live.leaseUntil = 1; e.registry.saveRun(live); e.registry.expire();
    const late = { ...event, seq: 2, payload: { kind: "event" as const, event: { type: "thread" as const, threadId: "wrong-late-thread" } } };
    assert.equal(e.registry.accept(n, late).quarantined, true);
    assert.equal(e.registry.accept(n, late).quarantined, true, "隔离回执丢失后的重试也必须标记隔离");
    const executor = new RemoteExecutor(e.registry), observed: RunEvent[] = [];
    s.codexThreadId = "original-thread";
    assert.equal((await executor.run(s, j, x => observed.push(x))).cleanupFailed, true);
    assert.ok(!JSON.stringify(observed).includes("wrong-late-thread"));
    assert.equal(e.store.getSession(s.id)!.codexThreadId, "original-thread");
  } finally { e.close(); }
});
test("已报告成果断联只等待补传，不占其他任务执行槽且不重跑模型", () => {
  const e = env();
  try {
    const n = e.node().node, s = e.session(n), j = e.job(s), r = e.registry.createRun(s, j);
    e.registry.claim(n, 1);
    const bytes = Buffer.alloc(17, 8), artifact: ArtifactInfo = { id: randomUUID(), sha256: digest(bytes), bytes: bytes.length, name: "result.zip" };
    e.registry.accept(n, { runId: r.id, generation: 1, seq: 1, payload: { kind: "result", completion: {
      result: { status: "completed", text: "done" }, checkpoint: checkpoint(s), artifact } } });
    const pending = e.registry.run(r.id, 1)!; pending.leaseUntil = 1; e.registry.saveRun(pending); e.registry.expire();
    assert.equal(e.registry.run(r.id, 1)!.state, "reported");
    assert.equal(e.registry.claim(n, 1), undefined, "不能重新领取已完成模型的回合");
    const other = e.session(n), next = e.job(other);
    assert.equal(e.registry.dispatchable(other, next), true);
    e.registry.createRun(other, next); assert.equal(e.registry.claim(n, 1)?.job.id, next.id);
    e.registry.chunk(n, { runId: r.id, generation: 1, artifact, index: 0, sha256: digest(bytes) }, bytes);
    assert.equal(e.registry.run(r.id, 1)!.state, "completed");
  } finally { e.close(); }
});
test("完成结果后迟到停止确认保留已完成状态和成果", () => {
  const e = env();
  try {
    const n = e.node().node, s = e.session(n), j = e.job(s), r = e.registry.createRun(s, j); j.mode = "discuss"; e.store.saveJob(j);
    e.registry.claim(n, 1); const control = e.registry.requestControl(e.registry.run(r.id, 1)!, "stop");
    e.registry.accept(n, { runId: r.id, generation: 1, seq: 1, payload: { kind: "result", completion: {
      result: { status: "completed", text: "finished before stop" }, checkpoint: checkpoint(s) } } });
    assert.equal(e.registry.run(r.id, 1)!.state, "completed");
    e.registry.accept(n, { runId: r.id, generation: 1, seq: 2, payload: { kind: "control", controlId: control.id, disposition: "accepted" } });
    assert.equal(e.registry.run(r.id, 1)!.state, "completed");
    assert.equal(e.registry.run(r.id, 1)!.completion!.result.text, "finished before stop");
    assert.equal(e.registry.run(r.id, 1)!.stopConfirmed, true);
  } finally { e.close(); }
});
test("不确定执行须确认旧代次终止并显式授权，飞书恢复事务使用新代次而保留原会话", async () => {
  const e = env();
  try {
    const n = e.node().node, s = e.session(n), j = e.job(s), r = e.registry.createRun(s, j);
    e.registry.claim(n, 1);
    const current = e.registry.run(r.id, 1)!; current.leaseUntil = 1; e.registry.saveRun(current); e.registry.expire();
    const uncertain = e.store.getJob(j.id)!;
    assert.throws(() => e.registry.authorizeRecovery(uncertain, "alice"), /尚未确认/);
    const stop = e.registry.controls(n.id).find(c => c.type === "stop")!;
    e.registry.accept(n, { runId: r.id, generation: 1, seq: 1, payload: { kind: "control", controlId: stop.id, disposition: "accepted" } });
    assert.throws(() => e.registry.authorizeRecovery(uncertain, "leader"), /使用权/);
    const router = new Router(e.config, e.store, new RemoteExecutor(e.registry), e.registry);
    await router.handle({ tenantId: "t", chatId: "chat", senderId: "alice", senderName: "A", senderType: "user",
      messageId: `om_${randomUUID()}`, rootId: s.rootMessageId, text: "恢复", mentionedBot: true, mentions: [], createdAt: Date.now() });
    const recovered = e.store.getJob(j.id)!; assert.equal(recovered.status, "queued");
    assert.equal(e.registry.dispatchable(s, recovered), true);
    const next = e.registry.createRun(s, recovered);
    assert.equal(next.id, r.id); assert.equal(next.generation, 2);
    assert.equal(e.registry.claim(n, 1)?.session.workspaceVolume, s.workspaceVolume);
    const late: Envelope = { runId: r.id, generation: 1, seq: 2,
      payload: { kind: "event", event: { type: "thread", threadId: "late-old-generation" } } };
    assert.equal(e.registry.accept(n, late).quarantined, true);
    assert.equal(e.store.getSession(s.id)!.codexThreadId, undefined);
  } finally { e.close(); }
});
test("恢复完成只用新代次检查，旧失败检查保留证据但不污染新结果", async () => {
  const e = env();
  try {
    const n = e.node().node, s = e.session(n), j = e.job(s), r = e.registry.createRun(s, j); e.registry.claim(n, 1);
    e.registry.accept(n, { runId: r.id, generation: 1, seq: 1, payload: { kind: "event", event: {
      type: "command", id: "check-old", command: "node --test", exitCode: 1, output: "old failed", status: "completed" } } });
    const old = e.registry.run(r.id, 1)!; old.leaseUntil = 1; e.registry.saveRun(old); e.registry.expire();
    const stop = e.registry.controls(n.id)[0]!;
    e.registry.accept(n, { runId: r.id, generation: 1, seq: 2, payload: { kind: "control", controlId: stop.id, disposition: "accepted" } });
    const recover = e.store.getJob(j.id)!; e.registry.authorizeRecovery(recover, "alice");
    const next = e.registry.createRun(s, recover); e.registry.claim(n, 1);
    e.registry.accept(n, { runId: next.id, generation: 2, seq: 1, payload: { kind: "event", event: {
      type: "command", id: "check-new", command: "node --test", exitCode: 0, output: "new passed", status: "completed" } } });
    e.registry.accept(n, { runId: next.id, generation: 2, seq: 2, payload: { kind: "result", completion: {
      result: { status: "completed", text: "new result" }, checkpoint: checkpoint(s) } } });
    const result = await new RemoteExecutor(e.registry).run(s, recover, () => {});
    assert.deepEqual(result.events.filter(e => e.type === "command").map(e => e.exitCode), [0]);
    assert.equal(e.store.events(j.id).filter(e => e.type === "command").length, 2);
  } finally { e.close(); }
});
test("成果校验完整SHA后才完成，末块响应丢失可重传，崩溃后的重复块能补finalize", () => {
  const e = env();
  try {
    const n = e.node().node, s = e.session(n), j = e.job(s), r = e.registry.createRun(s, j); e.registry.claim(n, 1);
    const bytes = Buffer.alloc(CHUNK_BYTES + 17, 7);
    const artifact: ArtifactInfo = { id: randomUUID(), sha256: digest(bytes), bytes: bytes.length, name: "result.zip" };
    e.registry.accept(n, { runId: r.id, generation: 1, seq: 1, payload: { kind: "result", completion: {
      result: { status: "completed", text: "done" }, checkpoint: { ...checkpoint(s), initialized: true }, artifact } } });
    const chunk = (index: number) => {
      const part = bytes.subarray(index * CHUNK_BYTES, Math.min(bytes.length, (index + 1) * CHUNK_BYTES));
      e.registry.chunk(n, { runId: r.id, generation: 1, artifact, index, sha256: digest(part) }, part);
    };
    chunk(1); assert.equal(e.registry.run(r.id, 1)!.state, "reported");
    chunk(0); const complete = e.registry.run(r.id, 1)!; assert.equal(complete.state, "completed");
    assert.ok(readFileSync(complete.artifactPath!).equals(bytes));
    chunk(0); // Lost final upload acknowledgement.
    complete.state = "reported"; complete.artifactPath = undefined; e.registry.saveRun(complete);
    chunk(0); assert.equal(e.registry.run(r.id, 1)!.state, "completed");
    assert.throws(() => e.registry.chunk(n, { runId: r.id, generation: 1, artifact, index: 0, sha256: "0".repeat(64) }, bytes.subarray(0, CHUNK_BYTES)), /哈希/);
    for (const name of [".", "..", "../x.zip", "/tmp/x.zip"]) assert.equal(artifactSchema.safeParse({ ...artifact, name }).success, false);
  } finally { e.close(); }
});
test("本地完成与结果事件原子落库；落事件失败回滚完成状态", () => {
  const dir = mkdtempSync(join(tmpdir(), "fc-journal-")), journal = new NodeJournal(dir);
  try {
    const id = randomUUID();
    journal.save({ runId: id, generation: 1, state: "intent" });
    const r = journal.get(id, 1)!; r.state = "complete";
    r.completion = { result: { status: "completed", text: "done" }, checkpoint: {
      initialized: false, workspaceVolume: "work", stateVolume: "state" } };
    journal.db.exec("CREATE TRIGGER abort_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    assert.throws(() => journal.complete(r), /failure/);
    assert.equal(journal.get(id, 1)!.state, "intent"); assert.equal(journal.pending(), undefined);
    journal.db.exec("DROP TRIGGER abort_event"); const ev = journal.complete(r);
    assert.equal(journal.get(id, 1)!.state, "complete"); assert.equal(journal.pending()!.payload.kind, "result");
    journal.ack(id, 1, ev.seq); assert.equal(journal.pending(), undefined);
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});
test("背景加载失败会释放preparing预留，不阻塞同节点后续任务", async () => {
  const e = env();
  try {
    const n = e.node().node, s = e.session(n), j = e.job(s, "alice", false); j.status = "queued"; e.store.saveJob(j);
    const executor = new RemoteExecutor(e.registry);
    const jobs = new Jobs(e.config, e.store, executor, { reply: async () => ({ messageId: "sent" }) }, async () => { throw new Error("context-failure"); });
    await jobs.tick();
    for (let i = 0; i < 50 && e.store.getJob(j.id)!.status !== "failed"; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(e.registry.forJob(j.id)!.state, "failed");
    const next = e.job(e.session(n)); assert.equal(e.registry.dispatchable(e.store.getSession(next.sessionId)!, next), true);
    await jobs.close();
  } finally { e.close(); }
});
test("旧会话迁到team-runner但卷、基准、实际thread ID不变", () => {
  const e = env();
  try {
    const n = e.node().node, s = e.session(n); s.runnerId = undefined; s.codexThreadId = "legacy-thread"; s.baseCommit = "b".repeat(40);
    e.store.saveSession(s); const work = s.workspaceVolume, state = s.stateVolume;
    e.registry.migrateLegacy(n); const migrated = e.store.getSession(s.id)!;
    assert.equal(migrated.runnerId, n.id); assert.equal(migrated.workspaceVolume, work); assert.equal(migrated.stateVolume, state);
    assert.equal(migrated.codexThreadId, "legacy-thread"); assert.equal(migrated.baseCommit, "b".repeat(40));
    assert.equal(e.registry.canUse(n, "bob", "feedbackdesk"), true, "旧团队项目的使用权限应保留");
    assert.throws(() => e.registry.bind(migrated, "alice", "mac-mini"), /原节点/);
  } finally { e.close(); }
});
test("明确节点优先，其次项目默认，无默认询问且UUID能消除同名歧义", () => {
  const e = env();
  try {
    const team = e.node().node, mini = e.node("mac-mini").node;
    e.config.runnerBridge!.projectDefaults = { feedbackdesk: "mac-mini" };
    assert.equal(e.registry.select("alice", undefined, "feedbackdesk").id, mini.id);
    assert.equal(e.registry.select("alice", team.id, "feedbackdesk").id, team.id);
    e.config.runnerBridge!.defaultNode = undefined; e.config.runnerBridge!.projectDefaults = undefined;
    assert.throws(() => e.registry.select("alice", undefined, "feedbackdesk"), /明确选择/);
    const other = e.node("mac-mini", "bob").node; e.registry.grant(other.id, "alice", "feedbackdesk", "bob");
    assert.throws(() => e.registry.select("alice", "mac-mini", "feedbackdesk"), /不唯一/);
    assert.equal(e.registry.select("alice", mini.id, "feedbackdesk").id, mini.id);
  } finally { e.close(); }
});
test("询问节点后持久保留原执行请求与附件，选择节点不丢需求或替换作者", async () => {
  const e = env();
  try {
    e.config.runnerBridge!.defaultNode = undefined;
    const mini = e.node("mac-mini").node, root = `om_${randomUUID()}`;
    const message = (actor: string, text: string, id = `om_${randomUUID()}`): IncomingMessage => ({
      tenantId: "t", chatId: "chat", messageId: id, rootId: id === root ? undefined : root,
      senderId: actor, senderName: actor, senderType: "user", mentionedBot: true, mentions: [], text, createdAt: Date.now(),
    });
    const original = { ...message("alice", "执行 读取Markdown附件并实现整批冲突失败", root),
      resources: [{ type: "file" as const, fileKey: "approved-file", fileName: "requirements.md" }] };
    let router = new Router(e.config, e.store, new RemoteExecutor(e.registry), e.registry);
    await router.handle(original);
    const s = e.store.allSessions()[0]!;
    assert.equal(s.pendingNodeRequest?.message.messageId, root); assert.equal(s.runnerId, undefined);
    assert.equal(e.store.jobs().length, 0); assert.match(e.store.outbox().at(-1)!.text!, /原请求已保留/);
    router = new Router(e.config, e.store, new RemoteExecutor(e.registry), e.registry);
    await router.handle(message("bob", "在 Mac mini 上"));
    await router.handle(message("leader", "在 Mac mini 上"));
    assert.equal(e.store.jobs().length, 0); assert.equal(e.store.getSession(s.id)!.runnerId, undefined);
    const chosen = message("alice", "在 Mac mini 上");
    await router.handle(chosen); await router.handle(chosen);
    const job = e.store.jobs()[0]!;
    assert.equal(e.store.jobs().length, 1); assert.equal(job.messageId, root); assert.equal(job.senderId, "alice");
    assert.equal(job.mode, "execute"); assert.match(job.prompt, /整批冲突失败/);
    assert.deepEqual(job.resourceMessageIds, [root]); assert.equal(job.readAttachments, true);
    assert.equal(e.store.getSession(s.id)!.runnerId, mini.id);
    assert.equal(e.store.getSession(s.id)!.pendingNodeRequest, undefined);
  } finally { e.close(); }
});
test("“用 Python”等普通请求不被误解析为节点；未知节点的“在 X 上”仍明确拒绝，不换机器", async () => {
  const e = env();
  try {
    const team = e.node().node, mini = e.node("mac-mini").node;
    const router = new Router(e.config, e.store, new RemoteExecutor(e.registry), e.registry);
    const ask = async (text: string) => {
      const id = `om_${randomUUID()}`;
      await router.handle({ tenantId: "t", chatId: "chat", messageId: id, senderId: "alice", senderName: "alice",
        senderType: "user", mentionedBot: true, mentions: [], text, createdAt: Date.now() });
      return { session: e.store.allSessions().find(s => s.rootMessageId === id), reply: e.store.outbox().at(-1)!.text! };
    };
    const plain = await ask("用 Python 写一个导入脚本的思路");
    assert.equal(plain.session?.runnerId, team.id);
    assert.match(e.store.jobs().find(j => j.sessionId === plain.session!.id)!.prompt, /用 Python 写一个导入脚本/);
    const named = await ask("用 mac-mini 分析导入规则");
    assert.equal(named.session?.runnerId, mini.id);
    assert.match(e.store.jobs().find(j => j.sessionId === named.session!.id)!.prompt, /当前请求：\n分析导入规则$/);
    const alias = await ask("在我的 Mac mini 上 分析页面");
    assert.equal(alias.session?.runnerId, mini.id);
    const unknown = await ask("在 mac-studio 上 执行 修改导入");
    assert.equal(unknown.session, undefined); assert.match(unknown.reply, /未授权或未登记/);
    assert.equal(e.store.jobs().length, 3);
  } finally { e.close(); }
});
test("等待节点时停止清除原请求，后续空选择不能恢复已取消的执行", async () => {
  const e = env();
  try {
    e.config.runnerBridge!.defaultNode = undefined; e.node("mac-mini");
    const router = new Router(e.config, e.store, new RemoteExecutor(e.registry), e.registry), root = `om_${randomUUID()}`;
    const msg = (text: string, first = false): IncomingMessage => ({ tenantId: "t", chatId: "chat",
      messageId: first ? root : `om_${randomUUID()}`, rootId: first ? undefined : root,
      senderId: "alice", senderName: "alice", senderType: "user", mentionedBot: text !== "停止", mentions: [], text, createdAt: Date.now() });
    await router.handle(msg("执行 修改导入", true)); await router.handle(msg("停止"));
    const s = e.store.allSessions()[0]!;
    assert.equal(s.pendingNodeRequest, undefined); await router.handle(msg("在 Mac mini 上"));
    assert.equal(e.store.jobs().length, 0); assert.equal(e.store.getSession(s.id)!.pendingNodeRequest, undefined);
  } finally { e.close(); }
});
test("归档在派发控制前失败会清除pending，旧会话不被永久锁死", async () => {
  const e = env();
  try {
    const n = e.node().node, s = e.session(n), j = e.job(s); j.status = "completed"; e.store.saveJob(j);
    const router = new Router(e.config, e.store, new RemoteExecutor(e.registry), e.registry);
    await router.handle({ tenantId: "t", chatId: "chat", senderId: "alice", senderName: "A", senderType: "user",
      messageId: `om_${randomUUID()}`, rootId: s.rootMessageId, text: "归档", mentionedBot: true, mentions: [], createdAt: Date.now() });
    assert.equal(e.store.getSession(s.id)!.workspaceAction, undefined);
    assert.equal(e.registry.controls(n.id).length, 0);
  } finally { e.close(); }
});
test("未来数据库版本拒绝降级迁移", () => {
  const e = env();
  try {
    e.store.db.exec("PRAGMA user_version=3");
    assert.throws(() => new RunnerRegistry(e.config, e.store, randomBytes(32)), /拒绝降级/);
    assert.equal(e.store.query("PRAGMA user_version")[0]!.user_version, 3);
  } finally { e.close(); }
});
test("真实TLS API：可信CA+节点身份成功，错误CA和撤销凭据失败", async () => {
  const e = env(); let api: RunnerApi | undefined;
  try {
    const tls = await createTls(join(e.dir, "tls")); e.config.runnerBridge!.certFile = tls.certFile; e.config.runnerBridge!.keyFile = tls.keyFile;
    api = new RunnerApi(e.registry); const port = await api.start(0), url = `https://127.0.0.1:${port}`;
    const code = e.registry.pair("alice", "mac-mini"), requestId = randomUUID();
    const pair = await new BridgeClient(url, tls.caFile).enroll(code, requestId, capabilities);
    const client = new BridgeClient(url, tls.caFile, pair.token);
    assert.equal((await client.poll(0, 0)).assignment, undefined);
    const wrong = await createTls(join(e.dir, "wrong-tls"));
    await assert.rejects(new BridgeClient(url, wrong.caFile, pair.token).poll(0, 0));
    e.registry.revoke(pair.node.id, "alice"); await assert.rejects(client.poll(0, 0), /撤销/);
  } finally { await api?.close(); e.close(); }
});
test("模型Key或节点配置改变使原live诊断标记失效", () => {
  const c = nodeConfigSchema.parse({ nodeId: randomUUID(), name: "mac-mini", ownerId: "alice",
    bridgeUrl: "https://127.0.0.1:19443", caFile: "/tmp/ca.pem", dataDir: "/tmp/node", token: "n".repeat(40),
    provider: { baseUrl: "https://example.org/v1", model: "test", label: "test" }, sandbox: {} });
  assert.notEqual(configHash(c, "old-key"), configHash(c, "new-key"));
  assert.notEqual(configHash(c, "old-key"), configHash({ ...c, capacity: 2 }, "old-key"));
});
test("缺少实际内存超限验证的旧诊断不能使节点接单", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fc-doctor-readiness-"));
  const c = nodeConfigSchema.parse({ nodeId: randomUUID(), name: "mac-mini", ownerId: "alice",
    bridgeUrl: "https://127.0.0.1:19443", caFile: "/tmp/ca.pem", dataDir: dir, token: "n".repeat(40),
    provider: { baseUrl: "https://example.org/v1", model: "test", label: "test" }, sandbox: {} });
  const report = { at: new Date().toISOString(), configHash: configHash(c, "key"),
    checks: [{ name: "image-and-isolation", ok: true, detail: "limits readable" }], live: true };
  const save = () => { for (const f of ["doctor.json", "doctor-live.json"]) writeFileSync(join(dir, f), JSON.stringify(report)); };
  try {
    save(); assert.equal(await ready(c, "key"), false);
    report.checks.push({ name: "memory-enforcement", ok: false, detail: "limit ineffective" });
    save(); assert.equal(await ready(c, "key"), false);
    report.checks.at(-1)!.ok = true;
    save(); assert.equal(await ready(c, "key"), true);
    assert.equal(await ready(c, "changed-key"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("节点重复启动在恢复账本前拒绝，不会杀掉已有执行", () => {
  const dir = mkdtempSync(join(tmpdir(), "fc-node-lock-"));
  try {
    const release = nodeLock(dir);
    assert.throws(() => nodeLock(dir), /已经运行/);
    release(); const again = nodeLock(dir); again();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("HTTPS长轮询及keepalive关闭有界，不在关库后继续处理", async () => {
  const e = env(); let api: RunnerApi | undefined;
  try {
    const tls = await createTls(join(e.dir, "tls")); Object.assign(e.config.runnerBridge!, tls);
    api = new RunnerApi(e.registry); const port = await api.start(0);
    const n = e.node(), client = new BridgeClient(`https://127.0.0.1:${port}`, tls.caFile, n.token);
    const poll = client.poll(0).catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 50));
    const start = Date.now(); await api.close(); assert.ok(Date.now() - start < 4000);
    await poll; api = undefined;
  } finally { await api?.close(); e.close(); }
});
test("新版真@才建回合，已有话题免@进度/停止，无背景权限时仍可控制", async () => {
  const e = env();
  try {
    const n = e.node().node, s = e.session(n), j = e.job(s);
    let stopped = 0; const router = new Router(e.config, e.store, { stop: async () => { stopped++; } }, e.registry);
    const msg = (text: string, at: boolean): IncomingMessage => ({ tenantId: "t", chatId: "chat", senderId: "alice", senderName: "A",
      senderType: "user", messageId: `om_${randomUUID()}`, rootId: s.rootMessageId, text, mentionedBot: at, mentions: [], createdAt: Date.now() });
    const before = e.store.jobs().length; await router.handle(msg("补充需求不覆盖旧数据", false)); assert.equal(e.store.jobs().length, before);
    e.config.receiveBackground = false;
    await router.handle(msg("进度", false)); assert.equal(e.store.jobs().length, before);
    await router.handle(msg("停止", false)); assert.equal(stopped, 1); assert.equal(e.store.getJob(j.id)!.status, "stopped");
    const other = { ...msg("停止", false), senderId: "bob" }; await router.handle(other); assert.equal(stopped, 1);
  } finally { e.close(); }
});
function topic(e: ReturnType<typeof env>, classifier?: { classify: (text: string, nodes: IntentNode[]) => Promise<Intent> }) {
  const router = new Router(e.config, e.store, new RemoteExecutor(e.registry), e.registry, classifier);
  const send = async (sender: string, text: string, opts: { root?: string; at?: boolean; mentions?: { id: string; name?: string }[] } = {}) => {
    const id = `om_${randomUUID()}`;
    await router.handle({ tenantId: "t", chatId: "chat", messageId: id, rootId: opts.root, threadId: opts.root ? `omt_${opts.root}` : undefined,
      senderId: sender, senderName: sender, senderType: "user", mentionedBot: opts.at ?? true, mentions: opts.mentions ?? [], text, createdAt: Date.now() });
    return id;
  };
  const replies = () => e.store.outbox().map(x => x.text ?? "");
  const sessionOf = (root: string) => e.store.findSession("t", "chat", [root]);
  const jobsOf = (root: string) => e.store.jobs().filter(j => j.sessionId === sessionOf(root)?.id);
  return { router, send, replies, sessionOf, jobsOf };
}
const intent = (value: Partial<Intent>): Intent => ({ kind: "chat", control: null, content: null, machine: null, ownMachine: false,
  project: null, deliverMarkdown: false, readAttachments: false, attachmentKinds: [], attachmentOwnerOnly: false, groupContext: false,
  memoryAction: null, autoReply: null, topicQuiet: null, topic: null, model: null, effort: null, modelScope: null, ...value });

test("话题内免@接续同一会话且讨论不发回执；主群免@只作背景，主群引用话题消息视为对该话题的修正", async () => {
  const e = env();
  try {
    e.node("team-runner", "leader");
    const t = topic(e), root = await t.send("alice", "解释导入逻辑");
    assert.equal(t.jobsOf(root).length, 1);
    const first = t.jobsOf(root)[0]!; first.status = "completed"; e.store.saveJob(first);
    const acks = t.replies().length;
    await t.send("bob", "那重复 ID 怎么处理？", { root, at: false });
    assert.equal(t.jobsOf(root).length, 2); assert.equal(t.jobsOf(root)[1]!.senderId, "bob");
    assert.equal(t.replies().length, acks, "讨论接续直接由回答回复，不再发收到回执");
    await t.send("bob", "执行 修复导入", { root, at: false });
    assert.equal(t.jobsOf(root).length, 2); assert.match(t.replies().at(-1)!, /只有任务发起人或 Leader/);
    const before = e.store.jobs().length;
    await t.send("alice", "主群里随便聊聊", { at: false });
    assert.equal(e.store.jobs().length, before);
    t.jobsOf(root).forEach(j => { j.status = "completed"; e.store.saveJob(j); });
    await t.router.handle({ tenantId: "t", chatId: "chat", messageId: `om_${randomUUID()}`, rootId: root, replyToMessageId: root,
      senderId: "alice", senderName: "alice", senderType: "user", mentionedBot: false, mentions: [], text: "引用回复补充：冲突时列出全部 ID", createdAt: Date.now() });
    assert.equal(e.store.jobs().length, before + 1); assert.match(t.jobsOf(root).at(-1)!.prompt, /列出全部 ID/);
  } finally { e.close(); }
});
test("自然语言授权以@为准：主人或Leader可授权，未@或无权限明确拒绝", async () => {
  const e = env();
  try {
    e.node("team-runner", "leader"); const air = e.node("macbook-air", "bob").node, mini = e.node("mac-mini", "alice").node;
    const t = topic(e, { classify: async text => /撤销|取消/.test(text) ? intent({ kind: "revoke", machine: "mac-mini" })
      : /Air/.test(text) ? intent({ kind: "grant", machine: "macbook-air" }) : intent({ kind: "grant", ownMachine: true }) });
    await t.send("alice", "把我的电脑给 @bob 用一下", { mentions: [{ id: "bob", name: "bob" }] });
    assert.equal(e.registry.canUse(mini, "bob", "feedbackdesk"), true);
    assert.match(t.replies().at(-1)!, /已允许 <at user_id="bob"><\/at> 使用 mac-mini/);
    await t.send("alice", "把我的电脑给小蓝用一下");
    assert.match(t.replies().at(-1)!, /请 @ 要授权的成员/);
    await t.send("alice", "让 @leader 也能用 Air", { mentions: [{ id: "leader", name: "leader" }] });
    assert.equal(e.registry.canUse(air, "leader", "feedbackdesk"), false); assert.match(t.replies().at(-1)!, /只有机器主人/);
    await t.send("leader", "让 @alice 也能用 Air", { mentions: [{ id: "alice", name: "alice" }] });
    assert.equal(e.registry.canUse(air, "alice", "feedbackdesk"), true, "Leader 可以把他人机器授权给成员");
    await t.send("alice", "取消 @bob 用我 Mac mini 的权限", { mentions: [{ id: "bob", name: "bob" }] });
    assert.equal(e.registry.canUse(mini, "bob", "feedbackdesk"), false);
    assert.equal(e.store.jobs().length, 0, "授权语句不创建模型回合");
  } finally { e.close(); }
});
test("“在我电脑上”选择本人机器；未指定机器默认服务器；先讨论后执行可迁移一次并携带讨论", async () => {
  const e = env();
  try {
    const team = e.node("team-runner", "leader").node, air = e.node("macbook-air", "bob").node;
    const t = topic(e, { classify: async text => intent({ kind: /修复/.test(text) ? "task" : "chat",
      ownMachine: /我电脑|我的电脑/.test(text), machine: /团队沙箱/.test(text) ? "team-runner" : null }) });
    const own = await t.send("bob", "在我电脑上执行 修复导入冲突");
    assert.equal(t.sessionOf(own)!.runnerId, air.id); assert.equal(t.jobsOf(own)[0]!.mode, "execute");
    const none = await t.send("alice", "在我电脑上看看导入");
    assert.equal(t.sessionOf(none), undefined); assert.match(t.replies().at(-1)!, /还没有登记自己的电脑/);
    const root = await t.send("bob", "导入逻辑有什么问题");
    const s = t.sessionOf(root)!; assert.equal(s.runnerId, team.id);
    const first = t.jobsOf(root)[0]!; first.status = "completed"; first.response = "会覆盖旧数据"; e.store.saveJob(first);
    s.codexThreadId = "server-thread"; s.initialized = true; e.store.saveSession(s);
    await t.send("bob", "在我电脑上执行 修复这个问题", { root, at: false });
    const moved = t.sessionOf(root)!;
    assert.equal(moved.runnerId, air.id); assert.equal(moved.codexThreadId, undefined); assert.equal(moved.initialized, false);
    assert.match(t.jobsOf(root)[1]!.prompt, /<previous-discussion>[\s\S]*会覆盖旧数据/);
    const second = t.jobsOf(root)[1]!; second.status = "completed"; e.store.saveJob(second);
    await t.send("bob", "在团队沙箱上继续", { root, at: false });
    assert.equal(t.sessionOf(root)!.runnerId, air.id); assert.match(t.replies().at(-1)!, /固定在原节点/);
  } finally { e.close(); }
});
test("意图识别失败时不执行任何有副作用的操作；精确“停止”不经模型仍可停止", async () => {
  const e = env();
  try {
    e.node("team-runner", "leader"); const mini = e.node("mac-mini").node;
    let calls = 0, fail = false;
    const t = topic(e, { classify: async () => { calls++; if (fail) throw new Error("offline"); return intent({ kind: "task" }); } });
    const root = await t.send("alice", "修复导入冲突");
    assert.equal(t.jobsOf(root).length, 1);
    fail = true;
    await t.send("alice", "授权 @bob 使用我的 Mac mini", { mentions: [{ id: "bob", name: "bob" }] });
    assert.match(t.replies().at(-1)!, /暂时无法理解/); assert.equal(e.registry.canUse(mini, "bob", "feedbackdesk"), false);
    await t.send("alice", "在 Mac mini 上 分析页面");
    assert.match(t.replies().at(-1)!, /暂时无法理解/); assert.equal(e.store.jobs().length, 1);
    const before = calls;
    await t.send("alice", "停止", { root, at: false });
    assert.equal(calls, before, "精确停止不调用意图模型");
    assert.equal(t.jobsOf(root)[0]!.status, "stopped");
  } finally { e.close(); }
});
test("AI 路由：控制、协作者、删除确认、附件与群背景标记都来自意图结果", async () => {
  const e = env();
  try {
    e.node("team-runner", "leader");
    let next = intent({ kind: "chat", groupContext: true, deliverMarkdown: true, readAttachments: true, attachmentKinds: ["file"] });
    const t = topic(e, { classify: async () => next });
    const root = await t.send("alice", "总结一下我们刚才说的，整理成文档");
    const job = t.jobsOf(root)[0]!;
    assert.equal(job.contextScope, "chat"); assert.equal(job.deliverAsMarkdown, true); assert.deepEqual(job.attachmentKinds, ["file"]);
    job.status = "completed"; e.store.saveJob(job);
    next = intent({ kind: "control", control: "allow_collaborator" });
    await t.send("alice", "让 @bob 也能推进这个任务", { root, at: false, mentions: [{ id: "bob", name: "bob" }] });
    assert.deepEqual(t.sessionOf(root)!.collaborators, ["bob"]);
    next = intent({ kind: "control", control: "status" });
    await t.send("bob", "现在怎么样了", { root, at: false });
    assert.match(t.replies().at(-1)!, /执行节点：team-runner/);
    next = intent({ kind: "control", control: "delete_request" });
    await t.send("alice", "把这个任务的工作区删掉吧", { root, at: false });
    const code = /确认删除 ([0-9a-f-]{36})/.exec(t.replies().at(-1)!)![1]!;
    next = intent({ kind: "control", control: "delete_confirm", content: "wrong" });
    await t.send("alice", "确认", { root, at: false });
    assert.match(t.replies().at(-1)!, /删除确认无效/);
    next = intent({ kind: "control", control: "delete_confirm", content: null });
    await t.send("alice", `好的，确认删除 ${code}`, { root, at: false });
    assert.equal(e.store.query("SELECT COUNT(*) AS n FROM audit WHERE action='delete_confirmed' AND session_id=?", [t.sessionOf(root)!.id])[0]!.n, 1);
    assert.equal(e.store.jobs().length, 1, "控制与管理动作不创建模型回合");
  } finally { e.close(); }
});
function groupEnv() {
  const e = env();
  e.config.runnerBridge!.groupAgent = { enabled: true, node: "team-runner", feedBudgetChars: 60_000, historyMaxBytes: 4 * 1024 * 1024,
    importHistory: true, pauseAfter: 100, ackEmoji: "OnIt", webSearch: true };
  e.node("team-runner", "leader");
  return e;
}
test("主群 Agent：顶层 @ 交给群会话并看到全部主群消息，回答进提问话题，话题随后独立接续", async () => {
  const e = groupEnv();
  try {
    const group = new GroupAgent(e.config, e.store, e.registry);
    const router = new Router(e.config, e.store, new RemoteExecutor(e.registry), e.registry, undefined, group);
    const send = async (text: string, opts: { at?: boolean; root?: string; sender?: string } = {}) => {
      const id = `om_${randomUUID()}`;
      await router.handle({ tenantId: "t", chatId: "chat", messageId: id, rootId: opts.root, threadId: opts.root ? `omt_${opts.root}` : undefined,
        senderId: opts.sender ?? "alice", senderName: opts.sender ?? "alice", senderType: "user", mentionedBot: opts.at ?? true,
        mentions: [], text, createdAt: Date.now() });
      return id;
    };
    for (let i = 1; i <= 30; i++) await send(`讨论第${i}条：导入要整批失败`, { at: false, sender: i % 2 ? "alice" : "bob" });
    const replies = e.store.outbox().length;
    const ask = await send("总结一下我们说的");
    const job = e.store.jobs().at(-1)!, groupSession = e.store.getSession(job.sessionId)!;
    assert.equal(groupSession.kind, "group"); assert.equal(job.replyTo, ask);
    assert.match(job.prompt, /讨论第1条/); assert.match(job.prompt, /讨论第30条/, "不受最近 20 条限制");
    const added = e.store.outbox().slice(replies);
    assert.deepEqual(added.map(x => [x.purpose, x.emoji, x.target.messageId]), [["reaction", "OnIt", ask]], "不发文字回执，只在提问消息上点表情");
    const topic = e.store.getSession(job.topicSessionId!)!;
    assert.equal(topic.rootMessageId, ask); assert.equal(topic.kind, undefined);
    job.status = "completed"; job.response = "结论：整批失败，alice 负责实现"; job.endedAt = Date.now(); e.store.saveJob(job);
    group.afterTurn(job);
    assert.match(e.store.getSession(topic.id)!.seedContext!, /整批失败/);
    await send("那测试谁来写？", { root: ask, at: false, sender: "bob" });
    const followup = e.store.jobs().at(-1)!;
    assert.equal(followup.sessionId, topic.id); assert.match(followup.prompt, /<group-answer>[\s\S]*alice 负责实现/);
    assert.equal(e.store.getSession(topic.id)!.seedContext, undefined, "首个话题回合消费后清除");
    followup.status = "completed"; followup.response = "bob 写测试"; followup.endedAt = Date.now(); e.store.saveJob(followup);
    await send("新的一条主群消息", { at: false });
    const next = await group.feed("t", "chat");
    assert.doesNotMatch(next.text, /讨论第1条/, "游标之前的消息不重复补给");
    assert.match(next.text, /新的一条主群消息/); assert.match(next.topics, /那测试谁来写/);
  } finally { e.close(); }
});
test("主群 Agent：Jobs 把群会话回答投递到提问话题并归属话题会话；领取时附带完整记录", async () => {
  const e = groupEnv();
  try {
    const group = new GroupAgent(e.config, e.store, e.registry);
    e.registry.assignmentFiles = s => [{ path: ".group/history.md", content: group.history(s.tenantId, s.chatId) }];
    const g = group.ensure("t", "chat", "alice");
    const topic: Session = { id: randomUUID(), tenantId: "t", chatId: "chat", rootMessageId: "om_ask", initiatorId: "alice",
      workspaceVolume: "w", stateVolume: "s", initialized: false, review: "open", createdAt: Date.now() };
    e.store.saveSession(topic); e.store.addAliases(topic, ["om_ask"]);
    e.store.insertMessage({ tenantId: "t", chatId: "chat", messageId: "om_main", senderId: "bob", senderName: "bob", senderType: "user",
      text: "主群里说过的话", mentionedBot: false, mentions: [], createdAt: Date.now() });
    const job: Job = { id: randomUUID(), sessionId: g.id, messageId: "om_ask", senderId: "alice", mode: "discuss", prompt: "q",
      status: "queued", createdAt: Date.now(), contextLoaded: true, replyTo: "om_ask", topicSessionId: topic.id };
    e.store.insertJob(job);
    e.registry.createRun(g, job);
    const assignment = e.registry.claim(e.registry.node(g.runnerId!)!, 1)!;
    assert.match(assignment.job.files![0]!.content, /主群里说过的话/);
    assert.equal(e.store.getJob(job.id)!.files, undefined, "完整记录不写入任务行");
    const delivered: OutboxEntry[] = [];
    const runner = { run: async () => ({ status: "completed" as const, text: "群回答", events: [] }), stop: async () => {},
      artifacts: async () => undefined, close: async () => {} };
    const jobs = new Jobs({ ...e.config, runnerBridge: { ...e.config.runnerBridge!, feishuEnabled: true } }, e.store, runner,
      { reply: async entry => { delivered.push(entry); return { messageId: "om_bot", threadId: "omt_ask" }; } }, undefined, j => group.afterTurn(j));
    const fresh = e.store.getJob(job.id)!; fresh.runId = undefined; fresh.generation = undefined; e.store.saveJob(fresh);
    jobs.start();
    for (let i = 0; i < 40 && !delivered.length; i++) await new Promise(r => setTimeout(r, 50));
    await jobs.close();
    assert.equal(delivered[0]?.target.messageId, "om_ask"); assert.equal(delivered[0]?.sessionId, topic.id);
    assert.equal(e.store.findSession("t", "chat", ["omt_ask"])?.id, topic.id, "机器人回复的话题映射到话题会话");
    assert.match(e.store.getSession(topic.id)!.seedContext!, /群回答/);
  } finally { e.close(); }
});
test("主群 Agent：积压超预算时近期原文保留、更早消息压成要点；历史导入完整翻页且不回灌背景", async () => {
  const e = groupEnv();
  try {
    e.config.runnerBridge!.groupAgent!.feedBudgetChars = 4000;
    const group = new GroupAgent(e.config, e.store, e.registry, { summarize: async (text, max) => `要点：共${text.split("\n").length}行`.slice(0, max) });
    for (let i = 0; i < 200; i++) e.store.insertMessage({ tenantId: "t", chatId: "chat", messageId: `om_${i}`, senderId: "alice", senderName: "alice",
      senderType: "user", text: `第${i}条 ${"x".repeat(40)}`, mentionedBot: false, mentions: [], createdAt: Date.now() + i });
    const feed = await group.feed("t", "chat");
    assert.match(feed.text, /要点：共\d+行/); assert.match(feed.text, /第199条/); assert.doesNotMatch(feed.text, /第0条 /);
    const pages: Record<string, { items: unknown[]; has_more: boolean; page_token?: string }[]> = {
      chat: [{ items: [{ message_id: "h1", chat_id: "chat", msg_type: "text", body: { content: JSON.stringify({ text: "历史 @_user_1" }) },
        mentions: [{ key: "@_user_1", id: "bob", name: "小蓝" }], sender: { id: "alice", sender_type: "user" }, create_time: "1000", thread_id: "th1" }],
        has_more: true, page_token: "p2" },
        { items: [{ message_id: "h2", chat_id: "chat", msg_type: "text", body: { content: JSON.stringify({ text: "外人" }) },
          sender: { id: "outsider", sender_type: "user" }, create_time: "1001" }], has_more: false }],
      thread: [{ items: [{ message_id: "h3", chat_id: "chat", msg_type: "text", body: { content: JSON.stringify({ text: "话题回复" }) },
        sender: { id: "bob", sender_type: "user" }, create_time: "1002", root_id: "h1", thread_id: "th1" }], has_more: false }],
    };
    const calls: string[] = [];
    const lister = { list: async ({ params }: { params: { container_id_type: string; page_token?: string } }) => {
      calls.push(`${params.container_id_type}:${params.page_token ?? ""}`);
      const list = pages[params.container_id_type]!; return { code: 0, data: list[params.page_token ? 1 : 0] };
    } } as unknown as Parameters<typeof importGroupHistory>[0];
    const result = await importGroupHistory(lister, e.config, { appId: "app", appSecret: "", modelKey: "" }, e.store, group, "t", "chat");
    assert.equal(result.imported, 2); assert.deepEqual(calls, ["chat:", "chat:p2", "thread:"]);
    const row = e.store.query("SELECT used,data FROM inbound WHERE message_id='h1'")[0]!;
    assert.equal(row.used, 1); assert.match(String(row.data), /历史 @小蓝/);
    assert.match(group.history("t", "chat"), /↳话题 h1[\s\S]*话题回复/);
    assert.equal((await importGroupHistory(lister, e.config, { appId: "app", appSecret: "", modelKey: "" }, e.store, group, "t", "chat")).imported, 0, "只导入一次");
  } finally { e.close(); }
});
test("主群 Agent：话题里的成员回复与机器人控制回复进入补给，回执除外；系统快照列出授权", async () => {
  const e = groupEnv();
  try {
    const group = new GroupAgent(e.config, e.store, e.registry);
    const air = e.node("macbook-air", "alice").node;
    const topic: Session = { id: randomUUID(), tenantId: "t", chatId: "chat", rootMessageId: "om_grant", initiatorId: "alice",
      workspaceVolume: "w", stateVolume: "s", initialized: false, review: "open", createdAt: Date.now() };
    e.store.saveSession(topic); e.store.addAliases(topic, ["om_grant"]);
    e.store.insertMessage({ tenantId: "t", chatId: "chat", messageId: "om_grant", senderId: "alice", senderName: "alice", senderType: "user",
      text: "节点授权 macbook air 给 bob", mentionedBot: true, mentions: [], createdAt: Date.now() - 3000 });
    e.store.insertMessage({ tenantId: "t", chatId: "chat", messageId: "om_reply", rootId: "om_grant", threadId: "omt_grant", senderId: "alice",
      senderName: "alice", senderType: "user", text: "把我的 macbook air 授权给 @bob", mentionedBot: false, mentions: [], createdAt: Date.now() - 2000 });
    for (const [purpose, text] of [["acknowledgement", "收到，任务 1234"], ["control", "已允许 @bob 使用 macbook-air 的项目 feedbackdesk"]] as const) {
      const id = e.store.enqueueReply({ sessionId: topic.id, purpose, target: { tenantId: "t", chatId: "chat", messageId: "om_grant" }, text });
      const entry = e.store.outbox().find(x => x.id === id)!; entry.status = "sent"; entry.sentMessageId = `om_bot_${purpose}`; e.store.saveOutbox(entry);
    }
    e.registry.grant(air.id, "bob", "feedbackdesk", "alice");
    const feed = await group.feed("t", "chat");
    assert.match(feed.text, /节点授权 macbook air 给 bob/);
    assert.match(feed.topics, /## 话题[\s\S]*把我的 macbook air 授权给[\s\S]*已允许 @bob 使用 macbook-air/);
    assert.doesNotMatch(feed.topics, /收到，任务 1234/);
    const state = group.systemState("t", "chat");
    assert.match(state, /macbook-air：登记人 成员\(alice\)[^\n]*授权：成员\(bob\)\/feedbackdesk/);
    assert.match(state, /team-runner：[^\n]*团队共享/);
    e.store.insertMessage({ tenantId: "t", chatId: "chat", messageId: "om_bot_control", rootId: "om_grant", threadId: "omt_grant", senderId: "app",
      senderName: "app", senderType: "bot", text: "已允许 @bob 使用 macbook-air 的项目 feedbackdesk", mentionedBot: false, mentions: [], createdAt: Date.now() });
    assert.equal(group.history("t", "chat").split("已允许 @bob").length - 1, 1, "导入的机器人消息与发送记录去重");
  } finally { e.close(); }
});
function proactiveEnv(decide: (text: string) => { action: "none" | "reply" | "handoff"; topic: string | null }, route?: (text: string) => Intent) {
  const e = groupEnv();
  const group = new GroupAgent(e.config, e.store, e.registry);
  let calls = 0;
  const classifier = { classify: async (text: string) => route ? route(text) : intent({}),
    proactive: async (text: string) => { calls++; return decide(text); } };
  const router = new Router(e.config, e.store, new RemoteExecutor(e.registry), e.registry, classifier, group);
  const send = async (text: string, opts: { at?: boolean; root?: string; sender?: string } = {}) => {
    const id = `om_${randomUUID()}`;
    await router.handle({ tenantId: "t", chatId: "chat", messageId: id, rootId: opts.root, threadId: opts.root ? `omt_${opts.root}` : undefined,
      senderId: opts.sender ?? "alice", senderName: opts.sender ?? "alice", senderType: "user", mentionedBot: opts.at ?? false,
      mentions: [], text, createdAt: Date.now() });
    return id;
  };
  return { e, group, router, send, calls: () => calls };
}
test("主动说话：none 不动作，reply 由群会话在该消息下的话题里简短回复，handoff 转给进行中任务且主群不说话", async () => {
  const p = proactiveEnv(text => text.includes("部署") ? { action: "reply", topic: null } : text.includes("导入") ? { action: "handoff", topic: "om_task" } : { action: "none", topic: null });
  const { e } = p;
  try {
    const task: Session = { id: randomUUID(), tenantId: "t", chatId: "chat", rootMessageId: "om_task", initiatorId: "alice",
      runnerId: e.registry.nodes()[0]!.id, projectAlias: "feedbackdesk", workspaceVolume: "w", stateVolume: "s", initialized: false, review: "open", createdAt: Date.now() };
    e.store.saveSession(task); e.store.addAliases(task, ["om_task"]);
    e.store.insertJob({ id: randomUUID(), sessionId: task.id, messageId: "om_task", senderId: "alice", mode: "execute", prompt: "当前请求：\n修复导入",
      status: "completed", createdAt: Date.now(), endedAt: Date.now() });
    const jobs = e.store.jobs().length;
    await p.send("中午吃什么");
    assert.equal(e.store.jobs().length, jobs); assert.equal(e.store.outbox().length, 0);
    const ask = await p.send("部署脚本在哪个目录？");
    const reply = e.store.jobs().at(-1)!;
    assert.equal(reply.unprompted, true); assert.equal(reply.replyTo, ask); assert.equal(e.store.getSession(reply.sessionId)!.kind, "group");
    assert.match(reply.prompt, /answer 填 NO_REPLY/); assert.ok(reply.outputSchema); assert.equal(e.store.outbox().length, 0, "主动回复不点表情");
    const extra = await p.send("导入时还要记录冲突的 ID");
    const handoff = e.store.jobs().at(-1)!;
    assert.equal(handoff.sessionId, task.id); assert.equal(handoff.mode, "execute", "负责人补充已完成的执行任务：接着执行");
    assert.equal(handoff.unprompted, undefined); assert.match(handoff.prompt, /记录冲突的 ID/);
    assert.equal(e.store.query("SELECT used FROM inbound WHERE message_id=?", [extra])[0]!.used, 1);
    const sent = e.store.outbox();
    assert.ok(sent.every(x => x.target.messageId === "om_task" || (x.purpose === "reaction" && x.target.messageId === extra)), "主群只点表情，说明发在任务话题里");
    assert.match(sent.find(x => x.purpose === "acknowledgement")!.text!, /收到主群补充[\s\S]*继续执行/);
    const bob = await p.send("导入时还要记录冲突的 ID 和时间", { sender: "bob" });
    assert.equal(e.store.jobs().at(-1)!.id, handoff.id, "没有执行权的人补充不自动执行");
    assert.match(e.store.outbox().at(-1)!.text!, /<at user_id="alice"><\/at> 主群里 <at user_id="bob"><\/at> 补充/); void bob;
  } finally { e.close(); }
});
test("主动说话：约 100 条未参与后暂停逐条判断，被 @ 后恢复；“只在被 @ 时回复”立即生效", async () => {
  const p = proactiveEnv(() => ({ action: "none", topic: null }), text => /只在被/.test(text) ? intent({ kind: "settings", autoReply: "mention_only" })
    : /恢复/.test(text) ? intent({ kind: "settings", autoReply: "conservative" }) : intent({}));
  const { e } = p;
  try {
    e.config.runnerBridge!.groupAgent!.pauseAfter = 10;
    for (let i = 0; i < 15; i++) await p.send(`闲聊 ${i}`);
    assert.equal(p.calls(), 10, "超过阈值后只入库不调模型");
    assert.equal(e.store.query("SELECT COUNT(*) AS n FROM inbound WHERE data LIKE '%闲聊%'")[0]!.n, 15, "消息照样全部入库");
    await p.send("你好", { at: true });
    await p.send("又一条闲聊");
    assert.equal(p.calls(), 11, "被 @ 后恢复逐条判断");
    await p.send("以后只在被 @ 时回复", { at: true });
    assert.match(e.store.outbox().at(-1)!.text!, /只在被 @ 时回复/);
    await p.send("闲聊不该触发判断");
    assert.equal(p.calls(), 11);
    await p.send("恢复主动回复吧", { at: true });
    await p.send("再来一条");
    assert.equal(p.calls(), 12);
  } finally { e.close(); }
});
test("群记忆可用自然语言增删查并进入群会话提示；话题可静默为仅 @ 接续", async () => {
  let next = intent({});
  const p = proactiveEnv(() => ({ action: "none", topic: null }), () => next);
  const { e } = p;
  try {
    next = intent({ kind: "memory", memoryAction: "add", content: "周报一律用表格" });
    await p.send("记住：周报一律用表格", { at: true });
    assert.match(e.store.outbox().at(-1)!.text!, /已记住（第 1 条）/);
    next = intent({ kind: "memory", memoryAction: "list" });
    await p.send("你记得这个群什么", { at: true });
    assert.match(e.store.outbox().at(-1)!.text!, /1\. 周报一律用表格/);
    next = intent({ kind: "chat" });
    const ask = await p.send("帮我写本周周报", { at: true });
    assert.match(e.store.jobs().at(-1)!.prompt, /<group-memory[\s\S]*周报一律用表格/);
    next = intent({ kind: "settings", topicQuiet: true });
    await p.send("这个话题别再自动回复了", { root: ask });
    const topicId = e.store.findSession("t", "chat", [ask])!.id;
    assert.equal(e.store.getSession(topicId)!.quiet, true);
    const before = e.store.jobs().length;
    next = intent({ kind: "chat" });
    await p.send("随口一句", { root: ask });
    assert.equal(e.store.jobs().length, before, "静默话题里未 @ 的消息不建回合");
    await p.send("这个还是要回答一下", { root: ask, at: true });
    assert.equal(e.store.jobs().length, before + 1);
    next = intent({ kind: "memory", memoryAction: "remove", content: "1" });
    await p.send("忘掉第1条", { at: true });
    assert.match(e.store.outbox().at(-1)!.text!, /已忘掉：周报一律用表格/);
  } finally { e.close(); }
});
test("未被要求的回合若模型输出 NO_REPLY 则不投递任何消息", async () => {
  const e = groupEnv();
  try {
    const s: Session = { id: randomUUID(), tenantId: "t", chatId: "chat", rootMessageId: "om_q", initiatorId: "alice",
      workspaceVolume: "w", stateVolume: "s", initialized: false, review: "open", createdAt: Date.now() };
    e.store.saveSession(s);
    e.store.insertJob({ id: randomUUID(), sessionId: s.id, messageId: "om_q", senderId: "alice", mode: "discuss", prompt: "p",
      status: "queued", createdAt: Date.now(), contextLoaded: true, unprompted: true });
    const runner = { run: async () => ({ status: "completed" as const, text: "NO_REPLY", events: [] }), stop: async () => {},
      artifacts: async () => undefined, close: async () => {} };
    const jobs = new Jobs(e.config, e.store, runner, { reply: async () => ({ messageId: "x" }) });
    jobs.start();
    for (let i = 0; i < 40 && e.store.jobs()[0]!.status !== "completed"; i++) await new Promise(r => setTimeout(r, 50));
    await jobs.close();
    assert.equal(e.store.jobs()[0]!.status, "completed"); assert.equal(e.store.outbox().length, 0);
  } finally { e.close(); }
});
test("总结与分工：群会话 JSON 回答渲染为正文与 @ 分工，事实写入群记忆，非成员负责人被丢弃；非 JSON 原样投递", () => {
  const e = groupEnv();
  try {
    const group = new GroupAgent(e.config, e.store, e.registry);
    const g = group.ensure("t", "chat", "alice");
    const job: Job = { id: randomUUID(), sessionId: g.id, messageId: "om_q", senderId: "alice", mode: "discuss", prompt: "p",
      status: "completed", createdAt: Date.now(), outputSchema: {}, response: JSON.stringify({ answer: "结论：重复 ID 整批失败。",
        remember: ["导入规则：重复 ID 整批失败"], assignments: [{ title: "实现导入规则", owner_open_id: "bob", request: "改 feedback.js 并补测试" },
          { title: "外人任务", owner_open_id: "ou_stranger", request: "x" }] }) };
    group.beforeDeliver(job);
    assert.match(job.response!, /^结论：重复 ID 整批失败。[\s\S]*1\. 实现导入规则 —— <at user_id="bob"><\/at>：改 feedback.js 并补测试/);
    assert.doesNotMatch(job.response!, /外人任务/); assert.match(job.response!, /按这个分工开话题/);
    assert.match(group.memoryText("t", "chat"), /导入规则：重复 ID 整批失败/);
    assert.equal(group.state("t", "chat")!.assignments!.length, 1);
    const plain: Job = { ...job, id: randomUUID(), response: "普通文本回答" };
    group.beforeDeliver(plain); assert.equal(plain.response, "普通文本回答");
  } finally { e.close(); }
});
test("按分工开话题：仅发起人或 Leader，可为每项发群消息并建立负责人所有的话题会话，负责人可在话题里直接执行", async () => {
  let next = intent({ kind: "start_assignments" });
  const p = proactiveEnv(() => ({ action: "none", topic: null }), () => next);
  const { e, group } = p;
  try {
    group.saveState("t", "chat", { sessionId: "", cursor: 0, topicsAt: 0,
      assignments: [{ title: "实现导入规则", owner: "bob", request: "改 feedback.js 并补测试", by: "alice", at: Date.now() }] });
    await p.send("按这个分工开话题", { at: true, sender: "bob" });
    assert.match(e.store.outbox().at(-1)!.text!, /只有发起这次分工的人或 Leader/);
    await p.send("按这个分工开话题", { at: true, sender: "alice" });
    const post = e.store.outbox().find(x => x.purpose === "post")!;
    assert.match(post.text!, /【分工】实现导入规则[\s\S]*<at user_id="bob"><\/at>/); assert.equal(post.post!.initiatorId, "bob");
    group.afterPost(post, "om_assigned");
    const topic = e.store.findSession("t", "chat", ["om_assigned"])!;
    assert.equal(topic.initiatorId, "bob"); assert.match(topic.seedContext!, /实现导入规则/);
    next = intent({ kind: "task" });
    await p.send("开始吧，按要求改", { root: "om_assigned", sender: "bob" });
    const job = e.store.jobs().at(-1)!;
    assert.equal(job.sessionId, topic.id); assert.equal(job.mode, "execute"); assert.match(job.prompt, /<group-answer>[\s\S]*实现导入规则/);
  } finally { e.close(); }
});
test("主群 @ 机器人点名要修正某个话题：意图给出 topic 后消息进入该话题会话，而不是新开话题", async () => {
  let seen: { tasks?: { topic: string; title: string }[] } = {};
  const p = proactiveEnv(() => ({ action: "none", topic: null }));
  const { e, group } = p;
  try {
    const task: Session = { id: randomUUID(), tenantId: "t", chatId: "chat", rootMessageId: "om_import", initiatorId: "alice", title: "导入逻辑", repoId: "feedbackdesk",
      runnerId: e.registry.nodes()[0]!.id, projectAlias: "feedbackdesk", workspaceVolume: "w", stateVolume: "s", initialized: false, review: "open", createdAt: Date.now() };
    e.store.saveSession(task); e.store.addAliases(task, ["om_import"]);
    const router = new Router(e.config, e.store, new RemoteExecutor(e.registry), e.registry,
      { classify: async (_t: string, _n: IntentNode[], ctx?: { tasks?: { topic: string; title: string }[] }) => { seen = ctx ?? {}; return intent({ kind: "task", topic: "om_import" }); } }, group);
    const id = `om_${randomUUID()}`;
    await router.handle({ tenantId: "t", chatId: "chat", messageId: id, senderId: "alice", senderName: "alice", senderType: "user",
      mentionedBot: true, mentions: [], text: "修正一下导入逻辑那个话题：冲突时列出全部 ID", createdAt: Date.now() });
    assert.equal(seen.tasks?.[0]?.title, "导入逻辑", "意图识别能看到已有任务标题");
    const job = e.store.jobs().at(-1);
    assert.ok(job, `未生成任务；机器人回复：${e.store.outbox().map(x => x.text).join(" | ")}`);
    assert.equal(job!.sessionId, task.id); assert.equal(job!.mode, "execute");
    assert.equal(e.store.findSession("t", "chat", [id])?.id, task.id, "主群消息并入该话题");
    assert.ok(e.store.outbox().some(x => x.purpose === "reaction" && x.target.messageId === id));
  } finally { e.close(); }
});
test("飞书卡片：文本 @ 转为卡片 @，执行结果带状态色标题", () => {
  const card = JSON.parse(toCard('**结论** <at user_id="ou_1"></at>', { title: "执行完成 · 任务 1", template: "green" }));
  assert.equal(card.schema, "2.0"); assert.equal(card.header.template, "green");
  assert.equal(card.body.elements[0].content, "**结论** <at id=ou_1></at>");
  assert.equal(JSON.parse(toCard("纯回答")).header, undefined);
});
test("默认模型与思考强度在领取时下发；任务自带的模型优先", () => {
  const e = env();
  try {
    e.config.runnerBridge!.defaults = { model: "gpt-6.1-sol", effort: "medium" };
    const n = e.node().node, s = e.session(n), j = e.job(s); e.registry.createRun(s, j);
    const a = e.registry.claim(n, 1)!;
    assert.equal(a.job.model, "gpt-6.1-sol"); assert.equal(a.job.effort, "medium");
    const s2 = e.session(n), j2 = e.job(s2); j2.model = "gpt-6-astra"; e.store.saveJob(j2);
    e.store.getJob(j.id)!; const r = e.registry.forJob(j.id)!; r.state = "completed"; e.registry.saveRun(r);
    e.registry.createRun(s2, j2);
    assert.equal(e.registry.claim(n, 1)!.job.model, "gpt-6-astra");
  } finally { e.close(); }
});
test("A：发任务时一句话选模型，按“这次 / 本话题 / 全群”生效；非 Leader 不能改全群默认", async () => {
  let next = intent({});
  const p = proactiveEnv(() => ({ action: "none", topic: null }), () => next);
  const { e, group } = p;
  try {
    next = intent({ kind: "task", model: "gpt-6-astra", effort: "high", modelScope: "topic" });
    const root = await p.send("用 Astra、高强度，修复导入冲突", { at: true });
    const s = e.store.findSession("t", "chat", [root])!;
    assert.equal(s.model, "gpt-6-astra"); assert.equal(s.effort, "high");
    const first = e.store.jobs().at(-1)!; assert.equal(first.model, "gpt-6-astra"); assert.equal(first.effort, "high");
    assert.match(e.store.outbox().find(x => x.purpose === "acknowledgement")!.text!, /模型：GPT-6 Astra · 思考强度 高/);
    first.status = "completed"; e.store.saveJob(first);
    next = intent({ kind: "task", effort: "xhigh", modelScope: "turn" });
    await p.send("这次想深一点再改", { root });
    const second = e.store.jobs().at(-1)!;
    assert.equal(second.effort, "xhigh"); assert.equal(second.model, "gpt-6-astra"); assert.equal(e.store.getSession(s.id)!.effort, "high", "“这次”不改话题设置");
    next = intent({ kind: "settings", model: "gpt-6-astra", modelScope: "group" });
    await p.send("以后群里默认用 Astra", { at: true, sender: "bob" });
    assert.match(e.store.outbox().at(-1)!.text!, /只有 Leader/); assert.deepEqual(group.defaults("t", "chat"), {});
    await p.send("以后群里默认用 Astra", { at: true, sender: "leader" });
    assert.equal(group.defaults("t", "chat").model, "gpt-6-astra");
  } finally { e.close(); }
});
test("B/C：“设置”在主群给出本群默认卡片、在话题给出本话题卡片；卡片下拉与按钮按原权限生效", async () => {
  let next = intent({ kind: "settings" });
  const p = proactiveEnv(() => ({ action: "none", topic: null }), () => next);
  const { e, router, group } = p;
  try {
    await p.send("设置", { at: true });
    const groupCard = e.store.outbox().at(-1)!;
    assert.equal(groupCard.controls?.scope, "group"); assert.equal(groupCard.controls?.target, "chat");
    next = intent({ kind: "task" });
    const root = await p.send("修复导入冲突", { at: true });
    const s = e.store.findSession("t", "chat", [root])!;
    assert.equal(e.store.outbox().find(x => x.purpose === "acknowledgement")!.controls?.stop, true, "回执卡片带停止按钮与模型选择");
    const click = (who: string, value: object, extra: { option?: string; formValue?: Record<string, unknown> } = {}) =>
      router.cardAction({ messageId: "om_card", chatId: "chat", operator: { openId: who }, action: { value, ...extra } });
    assert.match(JSON.stringify(await click("bob", { a: "model", scope: "topic", target: s.id }, { option: "gpt-6-astra" })), /只有任务负责人/);
    assert.match(JSON.stringify(await click("alice", { a: "model", scope: "topic", target: s.id }, { option: "gpt-6-astra" })), /success/);
    assert.equal(e.store.getSession(s.id)!.model, "gpt-6-astra");
    assert.match(JSON.stringify(await click("alice", { a: "effort", scope: "group", target: "chat" }, { option: "high" })), /只有 Leader/);
    await click("leader", { a: "effort", scope: "group", target: "chat" }, { option: "high" });
    assert.equal(group.defaults("t", "chat").effort, "high");
    assert.match(JSON.stringify(await click("alice", { a: "model", scope: "topic", target: s.id }, { option: "gpt-9" })), /不支持/);
    const job = e.store.jobs().at(-1)!; job.status = "completed"; job.checksStatus = "passed"; e.store.saveJob(job);
    assert.match(JSON.stringify(await click("alice", { a: "reject", scope: "topic", target: s.id })), /请先在输入框填写退回意见/);
    await click("alice", { a: "accept", scope: "topic", target: s.id });
    for (let i = 0; i < 20 && e.store.getSession(s.id)!.review !== "accepted"; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(e.store.getSession(s.id)!.review, "accepted"); assert.match(e.store.outbox().at(-1)!.text!, /已记录真人接受/);
    await click("alice", { a: "reject", scope: "topic", target: s.id }, { formValue: { feedback: "冲突时要列出全部 ID" } });
    for (let i = 0; i < 20 && e.store.getSession(s.id)!.review !== "rejected"; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(e.store.getSession(s.id)!.review, "rejected");
  } finally { e.close(); }
});
test("卡片结构：模型/强度下拉、停止按钮、接受/退回表单都带回调值", () => {
  const card = JSON.parse(toCard("正文", undefined, { scope: "topic", target: "s1", models: [{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol" }],
    model: "gpt-6.1-sol", effort: "medium", stop: true, review: true }));
  const [, columns, stop, form] = card.body.elements;
  assert.equal(columns.columns[0].elements[0].initial_option, "gpt-6.1-sol");
  assert.deepEqual(columns.columns[1].elements[0].behaviors[0].value, { a: "effort", scope: "topic", target: "s1" });
  assert.equal(stop.behaviors[0].value.a, "stop");
  assert.deepEqual(form.elements.map((x: { name: string }) => x.name), ["feedback", "accept", "reject"]);
});
test("边做边打勾：回执卡片原地更新计划、命令、文件与检查，3 秒内合并，结束后变色并去掉停止按钮", async () => {
  const e = groupEnv();
  try {
    let clock = 1_000_000;
    const updates: { id: string; card: Record<string, any> }[] = [];
    const progress = new ProgressCards(e.config, e.store, async (id, card) => { updates.push({ id, card: JSON.parse(card) }); }, () => clock);
    const job = { id: randomUUID(), mode: "execute", status: "running" } as Job;
    progress.started(job);
    await new Promise(r => setTimeout(r, 10));
    assert.equal(updates.length, 0, "回执卡片送达前不更新");
    const ackId = e.store.enqueueReply({ jobId: job.id, purpose: "acknowledgement", target: { tenantId: "t", chatId: "chat", messageId: "om_root" },
      text: "收到，已授权按本线程需求修改代码并运行检查。任务 x。\n执行节点：team-runner\n状态：排队",
      controls: { scope: "topic", target: "s1", models: [{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol" }], stop: true } });
    const ack = e.store.outbox().find(x => x.id === ackId)!; ack.status = "sent"; ack.sentMessageId = "om_card"; e.store.saveOutbox(ack);
    progress.event(job, { type: "plan", steps: [{ step: "读代码", status: "completed" }, { step: "改实现", status: "inProgress" }, { step: "跑测试", status: "pending" }] });
    progress.event(job, { type: "activity", kind: "command", summary: "node --test" });
    progress.event(job, { type: "command", id: "c1", command: "node --test", exitCode: 0, output: "", status: "completed" });
    progress.event(job, { type: "files", id: "f1", paths: ["/workspace/feedback.js"], status: "completed" });
    clock += 3000; await new Promise(r => setTimeout(r, 3100));
    assert.equal(updates.length, 1, "3 秒内的多次变化合并为一次更新");
    const live = updates[0]!;
    assert.equal(live.id, "om_card"); assert.equal(live.card.header.template, "blue");
    const body = live.card.body.elements[0].content as string;
    assert.match(body, /✅ 读代码[\s\S]*🔄 改实现[\s\S]*⬜ 跑测试/); assert.match(body, /✅ `node --test`/); assert.match(body, /`feedback.js`/);
    assert.doesNotMatch(body, /状态：排队/); assert.match(body, /状态：进行中/);
    assert.ok(live.card.body.elements.some((x: { tag: string; behaviors?: { value: { a: string } }[] }) => x.tag === "button" && x.behaviors?.[0]?.value.a === "stop"));
    progress.event(job, { type: "command", id: "check-1-0", command: "node --test", exitCode: 0, output: "", status: "completed" });
    job.status = "completed"; clock += 1000; progress.finished(job);
    await new Promise(r => setTimeout(r, 20));
    const done = updates.at(-1)!;
    assert.equal(done.card.header.template, "green"); assert.match(done.card.header.title.content, /执行已完成/);
    assert.match(done.card.body.elements[0].content, /\*\*固定检查\*\*\n✅ `node --test`/);
    assert.ok(!done.card.body.elements.some((x: { tag: string }) => x.tag === "button"), "结束后去掉停止按钮");
  } finally { e.close(); }
});
