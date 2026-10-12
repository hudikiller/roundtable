import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { loadEnvironment } from "./config.js";
import { Store } from "./store.js";
import { Sandbox } from "./sandbox.js";
import { Feishu } from "./feishu.js";
import { checked } from "./process.js";
import { errorText, setSecrets } from "./log.js";
import type { Session, Job } from "./types.js";

async function doctor(): Promise<void> {
  const { config, secrets } = loadEnvironment();
  setSecrets([secrets.appSecret, secrets.modelKey]);
  const results: { check: string; ok: boolean; detail: unknown }[] = [];
  const check = async (name: string, work: () => Promise<unknown>) => {
    try { results.push({ check: name, ok: true, detail: await work() }); }
    catch (e) { results.push({ check: name, ok: false, detail: errorText(e) }); }
  };
  await check("node", async () => { if (!process.version.startsWith("v24.")) throw new Error("需要 Node 24"); return process.version; });
  await check("docker", async () => JSON.parse((await checked("docker", ["info", "--format", "{{json .}}"])).toString()).Driver);
  await check("task-image", async () => { await checked("docker", ["image", "inspect", config.sandbox.image]); return config.sandbox.image; });
  await check("sqlite", async () => {
    const store = new Store(join(config.dataDir, "control.sqlite"));
    try {
      return { integrity: store.query("PRAGMA integrity_check"), needsRecovery: store.jobs("needs_recovery").length,
        queued: store.jobs("queued").length, uncertainDeliveries: store.outbox("uncertain").length,
        failedDeliveries: store.outbox("failed").length };
    } finally { store.close(); }
  });
  const feishu = new Feishu(config, secrets);
  await check("feishu", () => feishu.doctor());
  await check("repositories", async () => {
    const repos = [];
    for (const repo of config.repositories) {
      const sha = (await checked("git", ["-C", repo.path, "rev-parse", `${repo.ref}^{commit}`])).toString().trim();
      repos.push({ id: repo.id, revision: sha, fixedChecks: repo.checks.length });
    }
    return repos;
  });
  results.push({ check: "model", ok: true,
    detail: "默认不调用模型。使用 --live 才执行付费的真实只读工具测试；模型列表不代表授权或兼容性。" });
  results.push({ check: "disk-budget", ok: true,
    detail: { MiB: config.sandbox.diskMiB, enforcement: "2秒监测并停止容器，不是硬磁盘配额" } });
  if (process.argv.includes("--live")) {
    const sandbox = new Sandbox(config, secrets);
    const id = randomUUID();
    const session: Session = { id, tenantId: config.tenantId, chatId: config.allowedChats[0]!,
      rootMessageId: "doctor", initiatorId: config.allowedMembers[0]!, workspaceVolume: `fc-work-${id}`,
      stateVolume: `fc-state-${id}`, initialized: false, review: "open", createdAt: Date.now() };
    const job: Job = { id: randomUUID(), sessionId: id, messageId: "doctor", senderId: session.initiatorId,
      mode: "discuss", prompt: "必须调用 shell 工具执行 pwd 和 ls -la，读取隔离空工作区，再用中文报告真实目录和可见文件。不要修改文件。",
      status: "running", createdAt: Date.now() };
    await check("model-live", async () => {
      const result = await sandbox.run(session, job, () => {});
      if (result.status !== "completed") throw new Error(result.error ?? "模型失败");
      if (!result.events.some(e => e.type === "command" && e.exitCode === 0)) throw new Error("模型未完成真实工具调用");
      return { response: result.text, commandExitCodes: result.events.filter(e => e.type === "command").map(e => e.exitCode) };
    });
    await sandbox.close();
  }
  if (process.argv.includes("--live")) {
    await mkdir(join(config.dataDir, "verification"), { recursive: true, mode: 0o700 });
    await writeFile(join(config.dataDir, "verification/model-live.json"), JSON.stringify(results, null, 2), { mode: 0o600 });
  }
  console.log(JSON.stringify(results, null, 2));
  if (results.some(r => !r.ok)) process.exitCode = 1;
}
doctor().catch(e => { console.error(errorText(e)); process.exitCode = 1; });
