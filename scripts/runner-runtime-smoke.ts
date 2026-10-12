import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { mkdir, writeFile, readFile, mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { unzipSync } from "fflate";
import { loadEnvironment } from "../src/config.js";
import { Store } from "../src/store.js";
import { RunnerRegistry } from "../src/runner/registry.js";
import { RemoteExecutor } from "../src/runner/remote.js";
import { errorText, setSecrets } from "../src/log.js";
import type { Session, Job } from "../src/types.js";
import { checked, exec } from "../src/process.js";
import { memoryArgs } from "../src/container-resources.js";

const { config, secrets } = loadEnvironment(undefined, true);
setSecrets([secrets.appSecret]);
if (!config.runnerBridge || config.runnerBridge.feishuEnabled) throw new Error("仅允许独立无飞书消费者的技术验收配置");
const store = new Store(join(config.dataDir, "control.sqlite")), registry = new RunnerRegistry(config, store);
// Restart/crash scenarios act on these systemd units (see deploy/).
const BRIDGE_UNIT = process.env.BRIDGE_UNIT ?? "roundtable.service", RUNNER_UNIT = process.env.RUNNER_UNIT ?? "roundtable-runner.service";
const mode = process.argv[2] || "m0", name = process.argv[3] || "team-runner", runId = randomUUID();
let node = registry.nodes().find(n => n.name === name);
const nodeDeadline = Date.now() + 45_000;
while ((!node?.capabilities.ready || Date.now() - node.lastSeen > 30_000) && Date.now() < nodeDeadline) {
  await new Promise(resolve => setTimeout(resolve, 250));
  node = registry.nodes().find(n => n.name === name);
}
if (!node?.capabilities.ready || Date.now() - node.lastSeen > 30_000) { store.close(); throw new Error("节点未就绪或离线"); }
const actor = node.ownerId, evidence: Record<string, unknown> = { at: new Date().toISOString(), mode, node: name,
  runId, kind: "real-runner-real-model-synthetic-message-not-feishu-not-human", twoHumanAcceptance: "pending" };
const createdJobs: string[] = [];
function session(): Session {
  const id = randomUUID(), s: Session = { id, tenantId: config.tenantId, chatId: config.allowedChats[0]!,
    rootMessageId: `runtime_${id}`, initiatorId: actor, initiatorName: "节点技术验收",
    workspaceVolume: `fc-runner-work-${id}`, stateVolume: `fc-runner-state-${id}`,
    repoId: "feedbackdesk", initialized: false, review: "open", createdAt: Date.now() };
  registry.bind(s, actor, name); return s;
}
function queue(s: Session, prompt: string, mode: Job["mode"]): Job {
  const j: Job = { id: randomUUID(), sessionId: s.id, messageId: `runtime_${randomUUID()}`, senderId: actor, prompt,
    mode, status: "queued", contextLoaded: true, createdAt: Date.now() };
  store.insertJob(j); createdJobs.push(j.id); return j;
}
async function wait(j: Job, timeout = 240_000): Promise<Job> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const current = store.getJob(j.id)!;
    if (!["queued", "running"].includes(current.status)) {
      assert.equal(current.status, "completed", current.error);
      return current;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error("真实节点模型验收超时，保留工作区和账本");
}
async function verifyCandidate(zip: Record<string, Uint8Array>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "fc-runner-golden-"));
  try {
    await checked("git", ["clone", "--no-hardlinks", config.repositories[0]!.path, dir]);
    await checked("git", ["-C", dir, "apply", "--whitespace=nowarn", "-"], { input: Buffer.from(zip["changes.patch"]!) });
    await chmod(dir, 0o755);
    // Evaluate untrusted generated code only in a bounded container without network.
    const golden = `
import assert from "node:assert/strict";
import { importFeedback } from "/candidate/feedback.js";
const old=[{id:"1",content:"old"},{id:"2",content:"keep"}], before=JSON.stringify(old);
const incoming=[{id:"3",content:"new"},{id:"1",content:"conflict"}], incomingBefore=JSON.stringify(incoming);
assert.throws(()=>importFeedback(old,incoming),"existing conflict must fail whole batch");
assert.equal(JSON.stringify(old),before); assert.equal(JSON.stringify(incoming),incomingBefore);
assert.throws(()=>importFeedback(old,[{id:"4",content:"a"},{id:"4",content:"b"}]));
assert.equal(JSON.stringify(old),before);
const result=importFeedback(old,[{id:"1",content:"old"},{id:"3",content:"new"}]);
assert.equal(result.length,3); assert.equal(result.find(r=>r.id==="1").content,"old");
assert.equal(JSON.stringify(old),before);
result[0].content="outside-change"; assert.equal(JSON.stringify(old),before);
console.log("independent-golden:passed");
`;
    const output = await checked("docker", ["run", "--pull=never", "--rm", "--network", "none", "--read-only",
      "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--cpus", "1", ...memoryArgs(256), "--pids-limit", "64", "--tmpfs", "/tmp:rw,nosuid,nodev,size=32m",
      "--label", "app=feishu-codex-runner-acceptance", "--mount", `type=bind,src=${dir},dst=/candidate,readonly`,
      config.sandbox.image.replace(":0.1.0", ":runner-v1"), "node", "--input-type=module", "-e", golden], { timeout: 30_000 });
    assert.ok(output.toString().includes("independent-golden:passed"));
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function managedContainers(id: string, gen: number): Promise<string[]> {
  return (await checked("docker", ["ps", "-aq", "--filter", "label=app=feishu-codex-runner-v1",
    "--filter", `label=run=${id}`, "--filter", `label=generation=${gen}`])).toString().trim().split(/\s+/).filter(Boolean);
}
async function until(condition: () => boolean | Promise<boolean>, timeout = 120_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error("真实事件/进程未在期限内出现");
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}
async function actualSleep(j: Job, seconds: number): Promise<void> {
  assert.equal(name, "team-runner", "本机Docker独立观察仅适用于team-runner");
  await until(async () => {
    const r = registry.forJob(j.id); if (!r) return false;
    for (const id of await managedContainers(r.id, r.generation)) {
      const probe = await exec("docker", ["exec", id, "node", "-e",
        'const f=require("fs");let found=false;for(const id of f.readdirSync("/proc")){if(!/^\\d+$/.test(id))continue;try{const a=f.readFileSync("/proc/"+id+"/cmdline").toString().split("\\0");if((a[0]==="sleep"||a[0]?.endsWith("/sleep"))&&a.includes(process.argv[1]))found=true}catch{}}process.stdout.write(found?"sleeping":"waiting")',
        String(seconds)], { timeout: 5000 });
      if (probe.code === 0 && probe.stdout.toString() === "sleeping") return true;
    }
    return false;
  });
}
try {
  const s = session();
  if (mode === "m0") {
    const marker = `NODE_M0_${runId.replaceAll("-", "")}`;
    const a = await wait(queue(s, `只读：必须实际调用shell执行pwd和ls -la。最终回答包含 ${marker}，如实报告目录及退出码。不修改文件。`, "discuss"));
    assert.ok(store.events(a.id).some(e => e.type === "command" && e.exitCode === 0)); assert.ok(a.response?.includes(marker));
    const thread = store.getSession(s.id)!.codexThreadId;
    assert.ok(thread);
    const b = await wait(queue(store.getSession(s.id)!, "继续本任务。从此前上下文返回上一回合 NODE_M0_ 开头的完整标记，本条不再提供；再实际执行pwd，只读不修改文件。", "discuss"));
    assert.ok(b.response?.includes(marker)); assert.equal(store.getSession(s.id)!.codexThreadId, thread);
    evidence.realToolCalls = true; evidence.sameCodexThread = true; evidence.sameSession = true; evidence.jobs = [a.id, b.id];
  } else if (mode === "coding") {
    const marker = `NODE_CODE_${runId.replaceAll("-", "")}`;
    const a = await wait(queue(s, `授权执行：实现feedback.js中的importFeedback(existing,incoming)。同ID不同content必须整批失败，同批内部冲突也失败；不覆盖已有数据，不修改传入数组及对象。新增测试并实际执行node --test。不要修改index.html，不提交推送。将 ${marker} 写入proof.txt。`, "execute"));
    assert.equal(a.checksStatus, "passed"); assert.ok(a.artifactPath);
    const bytes = await readFile(a.artifactPath!);
    const zip = unzipSync(bytes);
    assert.ok(Buffer.from(zip["changes.patch"]!).toString().includes("feedback.js"));
    assert.equal(Buffer.from(zip["new-files/proof.txt"]!).toString().trim(), marker);
    const manifest = JSON.parse(Buffer.from(zip["result.json"]!).toString());
    assert.equal(manifest.baseCommit, store.getSession(s.id)!.baseCommit);
    await verifyCandidate(zip);
    const thread = store.getSession(s.id)!.codexThreadId;
    const b = await wait(queue(store.getSession(s.id)!, "仅讨论：必须实际调用shell读取proof.txt，返回完整正文，不修改代码或文件。", "discuss"));
    assert.ok(store.events(b.id).some(e => e.type === "command" && e.exitCode === 0 && e.output.includes(marker)));
    assert.equal(store.getSession(s.id)!.codexThreadId, thread);
    evidence.fixedChecksPassed = true; evidence.independentGoldenPassed = true;
    evidence.artifactSha256 = createHash("sha256").update(bytes).digest("hex");
    evidence.artifactMatchesChanges = true; evidence.uncommittedFileSurvivedContainerRelease = true;
    evidence.sameCodexThread = true; evidence.jobs = [a.id, b.id]; evidence.sessionId = s.id;
  } else if (mode === "stop") {
    const a = queue(s, "授权执行停止测试：先实际调用shell运行sleep 120，等待，不修改文件，不跳过等待。", "execute");
    await actualSleep(a, 120);
    const start = Date.now(); await new RemoteExecutor(registry).stop(s.id);
    assert.equal(registry.forJob(a.id)!.stopConfirmed, true);
    if (name === "team-runner") {
      const r = registry.forJob(a.id)!;
      assert.equal((await managedContainers(r.id, r.generation)).length, 0);
      const networks = await checked("docker", ["network", "ls", "-q",
        "--filter", `label=run=${r.id}`, "--filter", `label=generation=${r.generation}`]);
      assert.equal(networks.toString().trim(), "");
      evidence.independentDockerProcessEnd = true;
    }
    evidence.actualCommandStarted = true; evidence.stopConfirmed = true; evidence.stopMs = Date.now() - start;
    evidence.jobs = [a.id];
  } else if (mode === "steer") {
    const marker = `STEER_${runId.replaceAll("-", "")}`;
    const a = queue(s, "只读讨论：必须实际调用shell运行sleep 15，等待后报告，不修改任何文件。", "discuss");
    await actualSleep(a, 15);
    const before = registry.forJob(a.id)!;
    const steered = await new RemoteExecutor(registry).steer(s.id, a.id, `本回合最终回答必须包含 ${marker}。保持只读，不创建新回合。`);
    assert.equal(steered.turnId, before.turnId);
    const done = await wait(a); assert.ok(done.response?.includes(marker));
    assert.equal(registry.forJob(a.id)!.generation, before.generation);
    await assert.rejects(new RemoteExecutor(registry).steer(s.id, a.id, "已结束之后的插话"));
    evidence.actualTurnSteerAccepted = true; evidence.finishedTurnRejected = true; evidence.noExtraRun = true;
    evidence.jobs = [a.id];
  } else if (mode === "restart") {
    const a = queue(s, "只读：必须实际执行sleep 25，再实际pwd并报告。不修改文件。", "discuss");
    await actualSleep(a, 25);
    const before = registry.forJob(a.id)!;
    const pid = (await checked("systemctl", ["show", BRIDGE_UNIT, "-p", "MainPID", "--value"])).toString().trim();
    const restartedAt = Date.now(); await checked("systemctl", ["restart", BRIDGE_UNIT], { timeout: 15_000 });
    const nextPid = (await checked("systemctl", ["show", BRIDGE_UNIT, "-p", "MainPID", "--value"])).toString().trim();
    assert.notEqual(nextPid, pid); await wait(a);
    assert.equal(registry.forJob(a.id)!.generation, before.generation);
    const started = store.query("SELECT data FROM runner_events WHERE run=? AND generation=?", [before.id, before.generation])
      .map(row => JSON.parse(String(row.data))).filter(e => e.payload.kind === "started");
    assert.equal(started.length, 1);
    evidence.bridgeRestartMs = Date.now() - restartedAt; evidence.executionSurvivedBridgeRestart = true;
    evidence.modelNotRerun = true; evidence.jobs = [a.id];
  } else if (mode === "crash") {
    const marker = `CRASH_KEEP_${runId.replaceAll("-", "")}`;
    const a = queue(s, `授权执行：先检查crash-proof.txt；若已存在，实际cat并报告，跳过sleep；否则写入 ${marker} 后实际运行sleep 120。不要改其他文件，完成时运行node --test。`, "execute");
    await actualSleep(a, 120);
    const before = registry.forJob(a.id)!, thread = store.getSession(s.id)!.codexThreadId;
    assert.ok(thread);
    await checked("systemctl", ["kill", "--kill-who=main", "--signal=SIGKILL", RUNNER_UNIT]);
    await until(async () => (await managedContainers(before.id, before.generation)).length === 0, 30_000);
    await until(() => store.getJob(a.id)!.status === "needs_recovery", 60_000);
    const unchanged = registry.forJob(a.id)!; assert.equal(unchanged.generation, before.generation);
    await new RemoteExecutor(registry).stop(s.id);
    registry.authorizeRecovery(store.getJob(a.id)!, actor);
    const recovered = await wait(a);
    assert.equal(registry.forJob(a.id)!.generation, before.generation + 1);
    assert.equal(store.getSession(s.id)!.codexThreadId, thread);
    assert.ok(recovered.response?.includes(marker)); assert.equal(recovered.checksStatus, "passed");
    evidence.parentCrashTerminatedContainers = true; evidence.noAutomaticRerun = true;
    evidence.explicitRecoveryNewGeneration = true; evidence.uncommittedFileAndThreadPreserved = true;
    evidence.jobs = [a.id];
  } else if (mode === "page") {
    const marker = `NODE_PAGE_${runId.replaceAll("-", "")}`;
    const a = await wait(queue(s, `授权执行：只修改index.html，加入一个可见的“团队协作状态”区域，正文包含 ${marker}。不修改feedback.js或其测试，实际运行node --test。不提交推送。`, "execute"));
    assert.equal(a.checksStatus, "passed"); assert.ok(a.artifactPath);
    const bytes = await readFile(a.artifactPath!), zip = unzipSync(bytes);
    const patch = Buffer.from(zip["changes.patch"]!).toString();
    assert.ok(patch.includes("index.html") && patch.includes(marker));
    assert.ok(!patch.includes("diff --git a/feedback.js"));
    evidence.fixedChecksPassed = true; evidence.artifactSha256 = createHash("sha256").update(bytes).digest("hex");
    evidence.separatePageWorkspace = true; evidence.jobs = [a.id]; evidence.sessionId = s.id;
  } else throw new Error("支持 m0 / coding / page / stop / steer / restart / crash");
  await mkdir(join(config.dataDir, "verification"), { recursive: true, mode: 0o700 });
  await writeFile(join(config.dataDir, "verification", `runner-${name}-${mode}.json`), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(evidence, null, 2));
} catch (e) {
  evidence.failure = errorText(e);
  await mkdir(join(config.dataDir, "verification"), { recursive: true, mode: 0o700 });
  await writeFile(join(config.dataDir, "verification", `runner-${name}-${mode}-failure.json`), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  for (const id of createdJobs) {
    const j = store.getJob(id);
    if (j && ["queued", "running"].includes(j.status)) {
      await new RemoteExecutor(registry).stop(j.sessionId).catch(() => {});
      await until(() => !["queued", "running"].includes(store.getJob(id)!.status), 25_000).catch(() => {});
    }
  }
  throw e;
} finally {
  // Synthetic roots must never later be delivered when the same staging service enables Feishu.
  for (const id of createdJobs) store.db.prepare("DELETE FROM outbox WHERE job_id=?").run(id);
  store.close();
}
