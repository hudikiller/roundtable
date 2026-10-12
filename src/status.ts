import type { Session } from "./types.js";
import type { Store } from "./store.js";
import { redact } from "./log.js";

export function taskStatus(store: Store, session: Session): string {
  const jobs = store.jobs().filter(job => job.sessionId === session.id);
  const job = jobs.find(item => item.status === "running") ?? jobs.find(item => item.status === "needs_recovery") ??
    jobs.find(item => item.status === "queued") ?? jobs.at(-1);
  if (!job) return "本线程尚无任务。";
  const labels = { queued: "排队", running: "处理中", completed: "已完成", failed: "失败",
    stopped: "已停止", needs_recovery: "待明确恢复" };
  const events = store.events(job.id);
  const completed = events.findLast(event => event.type === "completed");
  const model = job.modelStatus ?? (completed?.type === "completed" ? completed.status : undefined);
  const activity = events.findLast(event => event.type === "activity");
  const outbox = store.outbox().filter(entry => entry.jobId === job.id);
  const delivered = outbox.filter(entry => entry.status === "sent").length;
  const uncertain = outbox.filter(entry => entry.status === "uncertain").length;
  const failed = outbox.filter(entry => entry.status === "failed").length;
  const pending = jobs.filter(item => item.status === "queued").length;
  const checks = job.checksStatus === "passed" ? "通过" : job.checksStatus === "failed" ? "失败" :
    activity?.type === "activity" && activity.kind === "checks" && job.status === "running" ? "执行中，尚无最终退出码" : "尚未记录固定检查通过";
  return redact(`任务 ${job.id.slice(0, 8)}：${labels[job.status]}（${job.mode === "execute" ? "授权执行" : "只读讨论"}）
模型：${model ?? "尚未结束"}
固定检查：${checks}
回复：已送达 ${delivered}，待核对 ${uncertain}，失败 ${failed}；成果${job.artifactPath ? "已生成，是否送达以附件记录为准" : "尚未生成"}
同线程排队：${pending}；人工验收：${session.review}
${activity?.type === "activity" ? `最近活动：${activity.summary.slice(0, 200)}` : "尚无工具活动记录。"}`);
}
