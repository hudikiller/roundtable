import type { AppConfig } from "./config.js";
import type { CardControls, Job, OutboxEntry, RunEvent } from "./types.js";
import type { Store } from "./store.js";
import { toCard } from "./feishu.js";
import { errorText, log, redact } from "./log.js";

interface Progress {
  startedAt: number;
  plan: { step: string; status: "pending" | "inProgress" | "completed" }[];
  commands: { command: string; state: "running" | "ok" | "failed" }[];
  files: Set<string>;
  checks: { command: string; ok: boolean }[];
  final?: Job["status"];
  last: number;
  timer?: NodeJS.Timeout;
  chain: Promise<void>;
  broken?: boolean;
}
const UPDATE_MS = 3000;
const mark = { pending: "⬜", inProgress: "🔄", completed: "✅" } as const;
const elapsed = (ms: number) => { const s = Math.round(ms / 1000); return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`; };

/**
 * Claude Tag-style live checklist: the task's acknowledgement card is edited in place while the turn
 * runs (Codex plan steps, commands, files, checks), then finalised with a coloured header.
 */
export class ProgressCards {
  private jobs = new Map<string, Progress>();
  constructor(readonly config: AppConfig, readonly store: Store,
    private update: (messageId: string, card: string) => Promise<void>, private now = () => Date.now()) {}
  private state(job: Job): Progress {
    let p = this.jobs.get(job.id);
    if (!p) { p = { startedAt: this.now(), plan: [], commands: [], files: new Set(), checks: [], last: 0, chain: Promise.resolve() }; this.jobs.set(job.id, p); }
    return p;
  }
  started(job: Job): void { this.state(job); this.schedule(job); }
  event(job: Job, event: RunEvent): void {
    const p = this.state(job);
    if (event.type === "plan") p.plan = event.steps;
    else if (event.type === "activity" && event.kind === "command") p.commands.push({ command: event.summary, state: "running" });
    else if (event.type === "command" && !event.id.startsWith("check-")) {
      const running = p.commands.findLast(c => c.state === "running" && (event.command.includes(c.command) || c.command.includes(event.command)));
      const state = event.exitCode === 0 && event.status === "completed" ? "ok" as const : "failed" as const;
      if (running) running.state = state; else p.commands.push({ command: event.command, state });
    } else if (event.type === "files") for (const path of event.paths) p.files.add(path);
    else if (event.type === "command" && event.id.startsWith("check-")) p.checks.push({ command: event.command, ok: event.exitCode === 0 && event.status === "completed" });
    else return;
    if (p.commands.length > 30) p.commands.splice(0, p.commands.length - 30);
    this.schedule(job);
  }
  finished(job: Job): void {
    const p = this.jobs.get(job.id);
    if (!p) return;
    p.final = job.status;
    if (p.timer) clearTimeout(p.timer);
    p.timer = undefined;
    this.flush(job, true);
  }
  private schedule(job: Job): void {
    const p = this.state(job);
    if (p.timer || p.final) return;
    p.timer = setTimeout(() => { p.timer = undefined; this.flush(job, false); }, Math.max(0, p.last + UPDATE_MS - this.now()));
  }
  /** The acknowledgement card this task replies under, once Feishu has confirmed delivery. */
  private ack(job: Job): OutboxEntry | undefined {
    return this.store.outbox("sent").find(e => e.jobId === job.id && e.purpose === "acknowledgement" && !!e.sentMessageId);
  }
  render(job: Job, ack: OutboxEntry): string {
    const p = this.state(job);
    const done = p.final, running = !done;
    const states: Partial<Record<Job["status"], string>> = { completed: "已完成", failed: "失败", stopped: "已停止", needs_recovery: "待恢复" };
    const head = (ack.text ?? "").replace(/\n?状态：排队\s*$/m, "").trim();
    const lines = [head, `状态：${running ? `进行中（已用时 ${elapsed(this.now() - p.startedAt)}）` : `${states[done!] ?? done}（用时 ${elapsed(this.now() - p.startedAt)}）`}`];
    if (p.plan.length) lines.push("", "**计划**", ...p.plan.map(s => `${mark[s.status]} ${s.step}`));
    const recent = p.commands.slice(-6);
    if (recent.length) lines.push("", "**最近操作**", ...recent.map(c => `${c.state === "ok" ? "✅" : c.state === "failed" ? "❌" : "⏳"} \`${redact(c.command).replace(/`/g, "'").slice(0, 120)}\``));
    if (p.files.size) lines.push("", `**改动文件**：${[...p.files].slice(0, 12).map(f => `\`${f.replace(/^\/workspace\//, "")}\``).join("、")}${p.files.size > 12 ? ` 等 ${p.files.size} 个` : ""}`);
    if (p.checks.length) lines.push("", "**固定检查**", ...p.checks.map(c => `${c.ok ? "✅" : "❌"} \`${c.command}\``));
    const template = !done ? "blue" as const : done === "completed" ? "green" as const : done === "stopped" ? "grey" as const : "red" as const;
    const title = `${job.mode === "execute" ? "执行" : "讨论"}${running ? "中" : states[done!] ?? ""} · 任务 ${job.id.slice(0, 8)}`;
    const controls: CardControls | undefined = ack.controls ? { ...ack.controls, stop: running && ack.controls.stop } : undefined;
    return toCard(lines.join("\n"), { title, template }, controls);
  }
  private flush(job: Job, final: boolean): void {
    const p = this.state(job);
    p.chain = p.chain.then(async () => {
      if (p.broken) return;
      const ack = this.ack(job);
      if (!ack?.sentMessageId) { if (!final) this.schedule(job); return; } // retried until the card exists
      p.last = this.now();
      try { await this.update(ack.sentMessageId, this.render(job, ack)); }
      catch (e) { p.broken = true; log("progress_card_failed", { jobId: job.id, error: errorText(e) }); }
      if (final) this.jobs.delete(job.id);
    });
  }
}
