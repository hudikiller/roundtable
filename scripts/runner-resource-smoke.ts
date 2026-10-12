import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadNode, sandboxConfig } from "../src/runner/config.js";
import { Sandbox } from "../src/sandbox.js";
import { startGuard } from "../src/runner/watchdog.js";
import { exec } from "../src/process.js";
import { setSecrets } from "../src/log.js";
import type { Job, Session } from "../src/types.js";

if (!process.argv.includes("--live")) throw new Error("此诊断调用真实模型；必须显式传 --live");
const { config: node, modelKey } = loadNode(), config = sandboxConfig(node);
setSecrets([node.token, modelKey, node.provider.baseUrl, ...node.projects.map(p => p.path)]);
config.sandbox.diskMiB = 16;
config.sandbox.timeoutSeconds = 90;
const id = randomUUID(), runId = randomUUID();
const session: Session = { id, tenantId: "resource-doctor", chatId: "resource-doctor", rootMessageId: "resource-doctor",
  initiatorId: node.ownerId, repoId: node.projects[0]?.id, workspaceVolume: `fc-resource-work-${id}`,
  stateVolume: `fc-resource-state-${id}`, initialized: false, review: "open", createdAt: Date.now() };
const job: Job = { id: runId, runId, generation: 1, sessionId: id, messageId: "resource-doctor",
  senderId: node.ownerId, mode: "execute", status: "running", createdAt: Date.now(),
  prompt: "这是获准的专用资源诊断工作区。只实际调用一次shell，运行 node -e 'require(\"fs\").writeFileSync(\"/workspace/budget-probe.bin\",Buffer.alloc(24*1024*1024,1))' 然后 sleep 60。不要修改其它文件，不提交推送；等待编排端终止，不自动重试。" };
const box = new Sandbox(config, { appId: "", appSecret: "", modelKey });
const guard = startGuard(node.nodeId, runId, 1, 90_000, 90_000, node.sandbox.dockerContext);
const args = (a: string[]) => node.sandbox.dockerContext ? ["--context", node.sandbox.dockerContext, ...a] : a;
try {
  const result = await box.run(session, job, () => {});
  assert.equal(result.status, "interrupted", result.error);
  assert.match(result.error ?? "", /超过磁盘预算/);
  await box.stopGeneration(id, runId, 1);
  const resources = await exec("docker", args(["ps", "-aq", "--filter", "label=app=feishu-codex-runner-v1",
    "--filter", `label=node=${node.nodeId}`, "--filter", `label=run=${runId}`, "--filter", "label=generation=1"]));
  assert.equal(resources.code, 0); assert.equal(resources.stdout.toString().trim(), "");
  const report = { kind: "real-model-isolated-resource-diagnostic-not-feishu-not-human",
    budgetMiB: 16, requestedMiB: 24, intervalSeconds: 2, terminated: true, hardDiskQuota: false };
  await mkdir(join(node.dataDir, "verification"), { recursive: true, mode: 0o700 });
  await writeFile(join(node.dataDir, "verification/disk-budget.json"), JSON.stringify(report), { mode: 0o600 });
  console.log(JSON.stringify(report));
} finally {
  await box.close();
  await box.stopGeneration(id, runId, 1);
  guard.disarm();
  for (const v of [session.workspaceVolume, session.stateVolume]) await exec("docker", args(["volume", "rm", v]));
}
