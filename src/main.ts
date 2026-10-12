import { openSync, readFileSync, writeFileSync, closeSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { loadEnvironment, configSchema } from "./config.js";
import { Store } from "./store.js";
import { Feishu } from "./feishu.js";
import { Sandbox } from "./sandbox.js";
import { Router } from "./router.js";
import { Jobs } from "./jobs.js";
import { setSecrets, errorText, log } from "./log.js";
import { loadPlatformContext } from "./platform-context.js";
import { RunnerRegistry } from "./runner/registry.js";
import { RemoteExecutor } from "./runner/remote.js";
import { RunnerApi } from "./runner/api.js";
import { IntentClassifier, ResponsesSummarizer } from "./intent.js";
import { GroupAgent } from "./group.js";
import { importGroupHistory } from "./history-import.js";
import { ProgressCards } from "./progress.js";

const requestedPath = process.env.FEISHU_CODEX_CONFIG || "config.json";
const isRemote = !!configSchema.parse(JSON.parse(readFileSync(requestedPath, "utf8"))).runnerBridge;
const { config, secrets } = loadEnvironment(requestedPath, isRemote);
setSecrets([secrets.appSecret, ...(isRemote ? [] : [secrets.modelKey]), ...(secrets.intentKey ? [secrets.intentKey] : [])]);
const lockPath = join(config.dataDir, "service.lock");
function lock(): number {
  try { return openSync(lockPath, "wx", 0o600); }
  catch {
    const pid = Number(readFileSync(lockPath, "utf8"));
    if (!pid || pid === process.pid) throw new Error("无效服务锁，需要管理员核对");
    try { process.kill(pid, 0); throw new Error(`本项目服务已运行 (PID ${pid})`); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      unlinkSync(lockPath);
      return openSync(lockPath, "wx", 0o600);
    }
  }
}
const fd = lock();
writeFileSync(fd, String(process.pid));
const store = new Store(join(config.dataDir, "control.sqlite"));
const registry = config.runnerBridge ? new RunnerRegistry(config, store) : undefined;
const sandbox = registry ? new RemoteExecutor(registry) : new Sandbox(config, secrets);
const api = registry ? new RunnerApi(registry) : undefined;
const feishu = new Feishu(config, secrets, e => {
  log("feishu_unrecoverable", { error: errorText(e) });
  void shutdown().then(() => process.exit(1)).catch(() => process.exit(1));
});
const intentModel = config.runnerBridge?.intentModel;
const classifier = intentModel && secrets.intentKey
  ? new IntentClassifier({ ...intentModel, key: secrets.intentKey }) : undefined;
const group = registry && config.runnerBridge?.groupAgent?.enabled
  ? new GroupAgent(config, store, registry, intentModel && secrets.intentKey ? new ResponsesSummarizer({ ...intentModel, key: secrets.intentKey }) : undefined)
  : undefined;
if (group && registry) registry.assignmentFiles = s => [{ path: ".group/history.md", content: group.history(s.tenantId, s.chatId) }];
const router = new Router(config, store, sandbox, registry, classifier, group);
const routing = new Set<Promise<void>>();
const jobs = new Jobs(config, store, sandbox, feishu, (session, job) => loadPlatformContext(feishu.channel.rawClient, config, secrets, store, session, job),
  group ? job => group.afterTurn(job) : undefined, group ? job => group.beforeDeliver(job) : undefined,
  group ? (entry, messageId) => group.afterPost(entry, messageId) : undefined,
  config.runnerBridge?.feishuEnabled ? new ProgressCards(config, store, (id, card) => feishu.updateCard(id, card)) : undefined);
let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  log("service_stopping");
  try {
    await feishu.close();
    await Promise.allSettled([...routing]);
    await Promise.all([jobs.close(), api?.close()]);
  }
  finally { store.close(); closeSync(fd); unlinkSync(lockPath); }
}
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => { void shutdown().then(() => process.exit(0)).catch(e => { console.error(errorText(e)); process.exit(1); }); });
try {
  if (registry) registry.recoverBridge();
  else { await (sandbox as Sandbox).cleanupOrphans(); store.recover(); }
  if (api) await api.start();
  if (!config.runnerBridge || config.runnerBridge.feishuEnabled)
    await feishu.connect(message => {
      const pending = router.handle(message).catch(e => log("routing_error", { error: errorText(e) }));
      routing.add(pending);
      void pending.finally(() => routing.delete(pending));
      return Promise.resolve();
    }, event => router.cardAction(event));
  jobs.start();
  if (group && config.runnerBridge?.groupAgent?.importHistory && config.runnerBridge.feishuEnabled)
    for (const chat of config.allowedChats)
      void importGroupHistory(feishu.channel.rawClient.im.message, config, secrets, store, group, config.tenantId, chat)
        .catch(e => log("group_history_import_failed", { error: errorText(e) }));
  log("service_ready", { background: config.receiveBackground, concurrency: config.concurrency });
} catch (e) {
  log("startup_failed", { error: errorText(e) });
  await shutdown();
  process.exitCode = 1;
}
