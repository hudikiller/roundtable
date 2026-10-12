import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import type { Session, RunResult } from "../types.js";
import { SteeringError } from "../types.js";
import { Sandbox } from "../sandbox.js";
import { errorText, log, redact, setSecrets } from "../log.js";
import { BridgeClient, NodeAuthenticationError } from "./client.js";
import { NodeJournal, type LocalRun } from "./journal.js";
import { nodeCapabilities, projectVersion, sandboxConfig, type NodeConfig } from "./config.js";
import { checkpoint, safeEvent, CHUNK_BYTES, ARTIFACT_BYTES, type Assignment, type Control, type Envelope } from "./protocol.js";
import { startGuard, type LeaseGuard } from "./watchdog.js";
import { nodeLock } from "./lock.js";
import { L } from "../i18n.js";

interface ActiveRun { assignment: Assignment; session: Session; guard: LeaseGuard; done: Promise<void>; safeToDisarm: boolean }
export class RunnerDaemon {
  readonly journal: NodeJournal;
  readonly sandbox: Sandbox;
  readonly client: BridgeClient;
  private active = new Map<string, ActiveRun>();
  private closing = false;
  private uploading = false;
  private heartBusy = false;
  private pendingControls = new Set<string>();
  private interval?: NodeJS.Timeout;
  private uploadInterval?: NodeJS.Timeout;
  private loop?: Promise<void>;
  private unlock: () => void;
  constructor(readonly config: NodeConfig, modelKey: string, private ready = false) {
    setSecrets([config.token, modelKey, config.provider.baseUrl, new URL(config.provider.baseUrl).hostname,
      ...config.projects.map(p => p.path)]);
    this.unlock = nodeLock(config.dataDir);
    this.journal = new NodeJournal(config.dataDir);
    this.sandbox = new Sandbox(sandboxConfig(config), { appId: "", appSecret: "", modelKey });
    this.client = new BridgeClient(config.bridgeUrl, config.caFile, config.token);
  }
  private key(id: string, gen: number): string { return `${id}:${gen}`; }
  async start(): Promise<void> {
    for (const r of this.journal.runs().filter(r => ["running", "intent"].includes(r.state))) {
      await this.sandbox.stopGeneration(r.assignment?.session.id ?? "", r.runId, r.generation);
      r.state = "uncertain";
      const s = r.assignment && (this.journal.session(r.assignment.session.id) ?? r.assignment.session);
      if (s) {
        r.completion = { result: { status: "failed", text: "", cleanupFailed: true, error: L("Runner重启，旧执行已终止；需负责人明确恢复", "Runner restarted and the old run was terminated; the owner must explicitly resume it") },
          checkpoint: checkpoint(s) };
        this.journal.complete(r);
      } else this.journal.save(r);
    }
    this.interval = setInterval(() => { void this.heartbeat(); }, 10_000);
    this.uploadInterval = setInterval(() => { void this.upload(); }, 100);
    await this.heartbeat();
    this.loop = this.pollLoop();
  }
  private async heartbeat(): Promise<void> {
    if (this.closing || this.heartBusy) return;
    this.heartBusy = true;
    const started = performance.now();
    try {
      const response = await this.client.heartbeat(nodeCapabilities(this.config, this.ready),
        [...this.active.values()].map(a => ({ runId: a.assignment.runId, generation: a.assignment.generation })));
      const spent = performance.now() - started;
      for (const lease of response.leases) this.active.get(this.key(lease.runId, lease.generation))?.guard.renew(Math.max(1, lease.leaseMs - spent - 5000));
      for (const c of response.controls) void this.control(c);
    } catch (e) {
      if (e instanceof NodeAuthenticationError) { this.ready = false; await this.stopActive(); }
      log("runner_heartbeat_error", { error: errorText(e) });
    } finally { this.heartBusy = false; }
  }
  private async pollLoop(): Promise<void> {
    while (!this.closing) {
      const started = performance.now();
      try {
        const response = await this.client.poll(this.ready ? Math.max(0, this.config.capacity - this.active.size) : 0);
        for (const c of response.controls) void this.control(c);
        if (response.assignment) this.accept(response.assignment, Math.max(1, response.assignment.leaseMs - (performance.now() - started) - 5000));
      } catch (e) {
        if (e instanceof NodeAuthenticationError) { this.ready = false; await this.stopActive(); }
        log("runner_poll_error", { error: errorText(e) });
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
  private accept(a: Assignment, leaseMs: number): void {
    if (a.protocolVersion !== 1 || a.session.runnerId !== this.config.nodeId) throw new Error(L("派发协议或节点不匹配", "Dispatch protocol or node mismatch"));
    if (a.profileVersion && projectVersion(this.config, a.session.projectAlias ?? "") !== a.profileVersion) throw new Error(L("项目配置版本不匹配", "Project config version mismatch"));
    if (this.active.size >= this.config.capacity || [...this.active.values()].some(r => r.session.id === a.session.id)) throw new Error(L("节点或会话容量已满", "Node or session capacity is full"));
    if (!this.journal.begin(a)) return; // Never launch a previously recorded run.
    const own = this.journal.session(a.session.id);
    if (own && (own.workspaceVolume !== a.session.workspaceVolume || own.stateVolume !== a.session.stateVolume ||
      (a.session.codexThreadId && own.codexThreadId && a.session.codexThreadId !== own.codexThreadId))) {
      const r = this.journal.get(a.runId, a.generation)!;
      r.state = "uncertain"; r.completion = { result: { status: "failed", text: "", cleanupFailed: true,
        error: L("本地会话映射与派发冲突，需人工核对", "The local session mapping conflicts with the dispatch; needs a manual check") }, checkpoint: checkpoint(a.session) };
      this.journal.complete(r); return;
    }
    const s: Session = { ...a.session, ...(own ? { ...checkpoint(own),
      hooksReady: (own as Session & { hooksReady?: boolean }).hooksReady } : {}) };
    this.journal.saveSession(s);
    const guard = startGuard(this.config.nodeId, a.runId, a.generation, leaseMs,
      this.config.sandbox.timeoutSeconds * 1000, this.config.sandbox.dockerContext);
    const entry: ActiveRun = { assignment: a, session: s, guard, done: Promise.resolve(), safeToDisarm: false };
    this.active.set(this.key(a.runId, a.generation), entry);
    entry.done = this.execute(entry).catch(e => {
      this.ready = false;
      log("runner_execute_error", { error: errorText(e) });
    }).finally(() => {
      if (entry.safeToDisarm) guard.disarm();
      this.active.delete(this.key(a.runId, a.generation));
    });
  }
  private async flushUntil(e: Envelope): Promise<void> {
    while (!this.closing && !this.journal.acknowledged(e)) {
      await this.upload(); await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (this.closing || this.journal.get(e.runId, e.generation)?.quarantined) throw new Error(L("回合不再获得Bridge确认", "This turn is no longer acknowledged by the Bridge"));
  }
  private async execute(a: ActiveRun): Promise<void> {
    const assignment = a.assignment, job = { ...assignment.job, runId: assignment.runId, generation: assignment.generation },
      r = this.journal.get(assignment.runId, assignment.generation)!;
    let result: RunResult;
    // A model the owner has not allowed never starts: a plain failure, not an uncertain execution.
    const denied = job.model && this.config.allowedModels && !this.config.allowedModels.includes(job.model)
      ? L(`这台机器未开放模型 ${job.model}，未调用模型`, `Model ${job.model} is not enabled on this machine; the model was not called`) : undefined;
    if (denied) result = { status: "failed", text: "", events: [], error: denied };
    else try {
      const intent = this.journal.append(r.runId, r.generation, { kind: "started" });
      await this.flushUntil(intent);
      if (a.guard.stopped) throw new Error(L("执行启动前租约已失效", "The lease expired before the run started"));
      r.state = "running"; this.journal.save(r);
      result = await this.sandbox.run(a.session, job, event => {
        if (event.type === "text" && !event.final) return;
        if (event.type === "thread") {
          if (a.session.codexThreadId && a.session.codexThreadId !== event.threadId) throw new Error(L("Codex恢复返回了不同会话", "Codex resume returned a different session"));
          a.session.codexThreadId = event.threadId;
        }
        this.journal.saveSession(a.session);
        this.journal.append(r.runId, r.generation, { kind: "event", event: safeEvent(event) });
      });
      if (a.guard.stopped) { result.status = "failed"; result.cleanupFailed = true; result.error = L("租约/节点故障触发本机看门狗；需明确恢复", "A lease/node failure triggered the local watchdog; needs an explicit resume"); }
      const checks = result.events.filter(e => e.type === "command").filter(e => e.id.startsWith("check-"));
      job.testSummary = checks.map(e => `${e.command}: exit=${e.exitCode ?? "unknown"} (${e.status})`).join("\n") || L("未运行固定检查", "No fixed checks were run");
      if (checks.some(e => e.exitCode !== 0 || e.status !== "completed") && result.status === "completed") {
        result.status = "failed"; result.error = L("固定检查失败", "Fixed checks failed");
      }
    } catch (e) {
      await this.sandbox.stopGeneration(a.session.id, r.runId, r.generation);
      result = { status: "failed", text: "", events: [], cleanupFailed: true, error: errorText(e) };
    }
    this.journal.saveSession(a.session);
    let artifactPath: string | undefined;
    try { artifactPath = await this.sandbox.artifacts(a.session, job, result); }
    catch (e) { result.status = "failed"; result.error = L(`成果导出失败：${errorText(e)}`, `Artifact export failed: ${errorText(e)}`); }
    try {
      await this.sandbox.stopGeneration(a.session.id, r.runId, r.generation);
      a.safeToDisarm = true;
    } catch (e) {
      this.ready = false; result.status = "failed"; result.cleanupFailed = true;
      result.error = L(`执行资源结束未确认：${errorText(e)}`, `Could not confirm the run resources were released: ${errorText(e)}`);
    }
    r.completion = { result: { status: result.status, text: redact(result.text), error: result.error, cleanupFailed: result.cleanupFailed },
      checkpoint: checkpoint(a.session) };
    if (artifactPath) {
      const bytes = await readFile(artifactPath);
      if (bytes.length > ARTIFACT_BYTES) throw new Error(L("成果超过24MiB", "Artifact exceeds 24 MiB"));
      r.completion.artifact = { id: randomUUID(), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
        name: `codex-${job.id.slice(0, 8)}.zip` };
      r.artifactPath = artifactPath;
    }
    r.state = result.cleanupFailed ? "uncertain" : "complete";
    const completionEvent = this.journal.complete(r);
    // Model and check containers have already terminated; upload is durable and can resume independently.
    if (a.safeToDisarm) a.guard.disarm();
    await this.flushUntil(completionEvent);
    await this.uploadArtifact(r);
  }
  private async uploadArtifact(r: LocalRun): Promise<void> {
    if (!r.artifactPath || !r.completion?.artifact || r.quarantined) return;
    const bytes = await readFile(r.artifactPath), artifact = r.completion.artifact;
    const indices = Array.from({ length: Math.ceil(bytes.length / CHUNK_BYTES) }, (_, i) => i)
      .filter(i => !this.journal.hasChunk(r.runId, r.generation, i));
    for (let start = 0; start < indices.length; start += 4) await Promise.all(indices.slice(start, start + 4).map(async index => {
      await this.client.chunk({ runId: r.runId, generation: r.generation, artifact, index },
        bytes.subarray(index * CHUNK_BYTES, Math.min(bytes.length, (index + 1) * CHUNK_BYTES)));
      this.journal.chunkAck(r.runId, r.generation, index);
    }));
  }
  private async upload(): Promise<void> {
    if (this.closing || this.uploading) return;
    this.uploading = true;
    try {
      for (let i = 0; i < 20; i++) {
        const e = this.journal.pending(); if (!e) break;
        const reply = await this.client.event(e);
        this.journal.ack(e.runId, e.generation, reply.ack, !!reply.quarantined);
      }
      for (const r of this.journal.runs().filter(r => r.artifactPath && !r.quarantined && !this.active.has(this.key(r.runId, r.generation))))
        await this.uploadArtifact(r);
    } catch (e) { log("runner_upload_error", { error: errorText(e) }); }
    finally { this.uploading = false; }
  }
  private async control(c: Control): Promise<void> {
    if (this.pendingControls.has(c.id)) return;
    const old = this.journal.control(c.id);
    if (old?.state === "complete") return;
    this.pendingControls.add(c.id);
    this.journal.saveControl(c, "intent");
    let disposition: "accepted" | "rejected" | "uncertain" = "accepted", error: string | undefined, turnId: string | undefined;
    try {
      const r = this.journal.get(c.runId, c.generation), a = this.active.get(this.key(c.runId, c.generation));
      if (c.type === "stop") {
        await this.sandbox.stopGeneration(a?.session.id ?? r?.assignment?.session.id ?? "", c.runId, c.generation);
        if (a) await a.done;
      } else if (c.type === "steer") {
        if (old?.state === "intent") { disposition = "uncertain"; throw new Error(L("Runner在插话确认期间重启，不自动重发", "Runner restarted while the steering message was being confirmed; it will not be resent automatically")); }
        if (!a || this.sandbox.turnId(a.session.id) !== c.expectedTurnId) { disposition = "rejected"; throw new Error(L("指定回合已结束或turn ID不匹配", "The target turn has ended or the turn ID does not match")); }
        const response = await this.sandbox.steer(a.session.id, a.assignment.job.id, c.text ?? "");
        turnId = response.turnId;
      } else {
        const s = r?.assignment && this.journal.session(r.assignment.session.id);
        if (!s || [...this.active.values()].some(x => x.session.id === s.id)) throw new Error(L("工作区未知或仍在运行", "Workspace is unknown or still running"));
        if (c.type === "delete") { await this.sandbox.deleteWorkspace(s); s.workspaceDeleted = true; }
        else s.archived = true;
        this.journal.saveSession(s);
      }
    } catch (e) {
      if (e instanceof SteeringError) disposition = e.disposition;
      else if (disposition === "accepted") disposition = "rejected";
      error = errorText(e);
    }
    Object.assign(c, { disposition, error, turnId }); this.journal.completeControl(c);
    this.pendingControls.delete(c.id);
  }
  private async stopActive(): Promise<void> {
    for (const a of this.active.values()) await this.sandbox.stopGeneration(a.session.id, a.assignment.runId, a.assignment.generation);
  }
  async close(): Promise<void> {
    this.closing = true;
    this.client.close();
    if (this.interval) clearInterval(this.interval);
    if (this.uploadInterval) clearInterval(this.uploadInterval);
    await this.stopActive(); await Promise.allSettled([...this.active.values()].map(a => a.done));
    await this.loop?.catch(() => {});
    while (this.uploading || this.heartBusy || this.pendingControls.size) await new Promise(resolve => setTimeout(resolve, 50));
    this.journal.close();
    this.unlock();
  }
}
