import type { Job, Session, Runner, RunEvent, RunResult } from "../types.js";
import { SteeringError } from "../types.js";
import { RunnerRegistry } from "./registry.js";
import { terminal } from "./protocol.js";
import { L } from "../i18n.js";

export class RemoteExecutor implements Runner {
  readonly remote = true;
  private closed = false;
  constructor(readonly registry: RunnerRegistry) {}
  reserve(s: Session, j: Job): void { this.registry.createRun(s, j); }
  releaseReservation(j: Job, reason: string): void {
    const r = this.registry.forJob(j.id);
    if (r?.state === "preparing") { r.state = "failed"; r.error = reason; r.stopConfirmed = true; this.registry.saveRun(r); }
  }
  canDispatch(s: Session, j: Job): boolean { return this.registry.dispatchable(s, j); }
  async run(s: Session, j: Job, onEvent: (e: RunEvent) => void): Promise<RunResult> {
    const n = s.runnerId && this.registry.node(s.runnerId);
    if (!n || !this.registry.canUse(n, j.senderId, s.projectAlias)) throw new Error(L("任务节点/项目未授权", "This task's node/project is not granted"));
    const existing = this.registry.forJob(j.id);
    const run = existing && j.runId === existing.id && j.generation === existing.generation
      ? (existing.state === "preparing" ? this.registry.createRun(s, j) : existing) : this.registry.createRun(s, j);
    let seq = 0;
    while (!this.closed) {
      this.registry.expire();
      const r = this.registry.run(run.id, run.generation)!;
      const rows = this.registry.store.query("SELECT seq,data FROM runner_events WHERE run=? AND generation=? AND seq>? AND quarantined=0 ORDER BY seq",
        [r.id, r.generation, seq]);
      for (const row of rows) {
        seq = Number(row.seq);
        const envelope = JSON.parse(String(row.data));
        if (envelope.payload.kind === "event") onEvent(envelope.payload.event);
      }
      if (r.state === "needs_recovery") return { status: "failed", text: "", events: [],
        cleanupFailed: true, error: r.error ?? L("节点执行待恢复", "Node run is waiting to be recovered") };
      if (terminal(r.state)) {
        const current = this.registry.store.getSession(s.id)!;
        for (const k of ["codexThreadId", "workspaceVolume", "stateVolume", "initialized", "baseCommit", "branch"] as const)
          (s as unknown as Record<string, unknown>)[k] = current[k];
        if (r.completion) {
          const events = this.registry.store.query("SELECT data FROM runner_events WHERE run=? AND generation=? AND quarantined=0 ORDER BY seq",
            [r.id, r.generation]).map(row => JSON.parse(String(row.data)))
            .filter(e => e.payload.kind === "event").map(e => e.payload.event as RunEvent);
          return { ...r.completion.result, events };
        }
        return { status: "interrupted", text: "", events: [], error: L("执行已确认停止", "Run confirmed stopped") };
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(L("Bridge退出，执行保留在节点并等待对账", "Bridge exited; the run stays on the node until it is reconciled"));
  }
  async stop(sessionId: string): Promise<void> {
    const runs = this.registry.runs().filter(r => r.sessionId === sessionId && !r.stopConfirmed &&
      !["completed", "failed", "stopped"].includes(r.state));
    for (const r of runs) {
      if (["assigned", "preparing"].includes(r.state) && !r.leaseUntil) {
        r.state = "stopped"; r.stopConfirmed = true; this.registry.saveRun(r);
        const job = this.registry.store.getJob(r.jobId)!; job.status = "stopped"; this.registry.store.saveJob(job); continue;
      }
      const c = this.registry.requestControl(r, "stop");
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const ack = this.registry.control(c.id);
        if (ack?.disposition === "accepted") break;
        if (ack?.disposition) throw new Error(ack.error ?? L("节点未确认停止", "The node did not confirm the stop"));
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!this.registry.run(r.id, r.generation)?.stopConfirmed) throw new Error(L("停止请求已保存，节点结束尚未确认", "Stop request saved; the node has not confirmed it finished yet"));
    }
    for (const r of this.registry.runs().filter(r => r.sessionId === sessionId && r.state === "needs_recovery" && r.stopConfirmed)) {
      r.state = "stopped"; this.registry.saveRun(r);
    }
  }
  async steer(sessionId: string, jobId: string, text: string): Promise<{ turnId: string }> {
    const r = this.registry.forJob(jobId);
    if (!r || r.sessionId !== sessionId || r.state !== "running" || !r.turnId)
      throw new SteeringError(L("没有正在运行的已确认回合", "No confirmed turn is running"), "rejected");
    const c = this.registry.requestControl(r, "steer", text), deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const ack = this.registry.control(c.id);
      if (ack?.disposition === "accepted" && ack.turnId) return { turnId: ack.turnId };
      if (ack?.disposition) throw new SteeringError(ack.error ?? L("插话未应用", "The steering message was not applied"), ack.disposition === "rejected" ? "rejected" : "uncertain");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new SteeringError(L("插话回执超时，不自动重发", "Timed out waiting for the steering receipt; it will not be resent automatically"), "uncertain");
  }
  async artifacts(_s: Session, j: Job): Promise<string | undefined> { return this.registry.forJob(j.id)?.artifactPath; }
  async manage(sessionId: string, action: "archive" | "delete"): Promise<void> {
    const r = this.registry.runs().filter(r => r.sessionId === sessionId).at(-1);
    if (!r || !terminal(r.state)) throw new Error(L("任务未完成或工作区尚未登记", "The task is not finished or its workspace is not registered yet"));
    const c = this.registry.requestControl(r, action), deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const ack = this.registry.control(c.id);
      if (ack?.disposition === "accepted") return;
      if (ack?.disposition) throw new Error(ack.error ?? L("工作区操作未完成", "The workspace operation did not complete"));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(L("请求已保存，节点尚未确认；不能显示已归档/删除", "Request saved, but the node has not confirmed it yet; it cannot be shown as archived/deleted"));
  }
  async close(): Promise<void> { this.closed = true; }
}
