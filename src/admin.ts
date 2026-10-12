import { join, resolve } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { backup } from "node:sqlite";
import { loadEnvironment } from "./config.js";
import { Store } from "./store.js";
import { errorText, setSecrets } from "./log.js";
import { Sandbox } from "./sandbox.js";
import { RunnerRegistry } from "./runner/registry.js";
import { RemoteExecutor } from "./runner/remote.js";
import { L } from "./i18n.js";

async function admin(): Promise<void> {
  const { config, secrets } = loadEnvironment();
  setSecrets([secrets.appSecret, secrets.modelKey]);
  const store = new Store(join(config.dataDir, "control.sqlite"));
  const args = process.argv.slice(2), cmd = args.shift();
  try {
    if (cmd === "status") {
      console.log(JSON.stringify({ serviceLock: existsSync(join(config.dataDir, "service.lock")),
        jobs: store.jobs().map(j => ({ id: j.id, mode: j.mode, status: j.status, checks: j.testSummary, error: j.error })),
        outbox: store.outbox().reduce((a, e) => { a[e.status] = (a[e.status] ?? 0) + 1; return a; }, {} as Record<string, number>),
        reviews: store.allSessions().map(s => ({ id: s.id, review: s.review })) }, null, 2));
    } else if (cmd === "recover") {
      const [id, actor] = args;
      const job = id ? store.getJob(id) : undefined;
      if (!job || job.status !== "needs_recovery") throw new Error(L("用法：npm run recover -- <完整任务ID> <发起人或Leader的open_id>", "Usage: npm run recover -- <full task ID> <open_id of the initiator or a Leader>"));
      const session = store.getSession(job.sessionId)!;
      if (!actor || (actor !== session.initiatorId && !config.leaders.includes(actor))) throw new Error(L("恢复需要发起人或 Leader 身份", "Recovery requires the initiator or a Leader"));
      if (config.runnerBridge) {
        const registry = new RunnerRegistry(config, store);
        registry.bind(session, actor);
        await new RemoteExecutor(registry).stop(session.id);
        registry.authorizeRecovery(job, actor);
      } else {
        await new Sandbox(config, secrets).stop(session.id);
        job.status = "queued"; job.error = undefined; store.saveJob(job);
      }
      store.audit(actor, session.id, "admin_explicit_recovery", { jobId: job.id });
      console.log(L("已授权接续现有工作区。", "Authorized to continue in the existing workspace."));
    } else if (cmd === "outbox") {
      const [id, operation, messageId] = args;
      const entry = store.outbox().find(e => e.id === id);
      if (!entry || !["uncertain", "failed"].includes(entry.status))
        throw new Error(L("用法：npm run outbox:resolve -- <完整ID> retry | delivered <已核对的平台消息ID>", "Usage: npm run outbox:resolve -- <full ID> retry | delivered <verified platform message ID>"));
      if (operation === "retry") {
        entry.status = "pending"; entry.attempts = 0; entry.nextAttemptAt = Date.now();
      } else if (operation === "delivered" && messageId) {
        entry.status = "sent"; entry.sentMessageId = messageId;
      } else throw new Error(L("先核对实际平台消息，再指定 retry 或 delivered <message_id>", "Check the actual platform message first, then specify retry or delivered <message_id>"));
      store.saveOutbox(entry);
      store.audit("local-admin", entry.sessionId, "delivery_manually_reconciled", { outboxId: id, operation, messageId });
      console.log(L("已记录管理员核对结果，未重新执行模型。", "Recorded the admin reconciliation; the model was not re-run."));
    } else if (cmd === "backup") {
      const dir = resolve(args[0] || join(config.dataDir, "backups"));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, `control-${Date.now()}.sqlite`);
      await backup(store.db, file);
      console.log(L(`控制数据库一致性备份：${file}\n工作区卷与成果需在停服后另行备份，详见 README。`, `Consistent control database backup: ${file}\nBack up workspace volumes and results separately after stopping the service; see README.`));
    } else throw new Error(L("未知管理命令", "Unknown admin command"));
  } finally { store.close(); }
}
admin().catch(e => { console.error(errorText(e)); process.exitCode = 1; });
