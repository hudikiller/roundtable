import { checked, exec } from "../process.js";
import type { NodeConfig } from "./config.js";
import { sandboxConfig, projectVersion } from "./config.js";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Sandbox } from "../sandbox.js";
import { BridgeClient } from "./client.js";
import { errorText, setSecrets } from "../log.js";
import type { Session, Job } from "../types.js";
import { startGuard } from "./watchdog.js";
import { memoryArgs } from "../container-resources.js";
import { L } from "../i18n.js";
export interface DoctorReport { at: string; configHash: string; checks: { name: string; ok: boolean; detail: unknown }[]; live?: boolean }
export function configHash(c: NodeConfig, modelKey: string): string {
  return createHash("sha256").update("runner-doctor-v2\0").update(JSON.stringify(c)).update("\0").update(modelKey).digest("hex");
}
export async function doctor(c: NodeConfig, modelKey: string, live = false): Promise<DoctorReport> {
  setSecrets([c.token, modelKey, c.provider.baseUrl, new URL(c.provider.baseUrl).hostname, ...c.projects.map(p => p.path)]);
  const report: DoctorReport = { at: new Date().toISOString(), configHash: configHash(c, modelKey), checks: [] };
  const check = async (name: string, work: () => Promise<unknown>) => {
    try { report.checks.push({ name, ok: true, detail: await work() }); }
    catch (e) { report.checks.push({ name, ok: false, detail: errorText(e) }); }
  };
  const dockerArgs = (a: string[]) => c.sandbox.dockerContext ? ["--context", c.sandbox.dockerContext, ...a] : a;
  await check("node24", async () => { if (!process.version.startsWith("v24.")) throw new Error(L("需要Node24", "Node 24 is required")); return process.version; });
  await check("docker", async () => {
    const raw = JSON.parse((await checked("docker", dockerArgs(["info", "--format", "{{json .}}"]))).toString());
    if (raw.OSType !== "linux" || raw.MemTotal < (c.sandbox.memoryMiB + 256) * 1024 * 1024 || raw.NCPU < Math.ceil(c.sandbox.cpus))
      throw new Error(L("Docker必须是有足够CPU/内存的Linux隔离环境", "Docker must be an isolated Linux environment with enough CPU and memory"));
    return { os: raw.OSType, arch: raw.Architecture, driver: raw.Driver, cgroup: raw.CgroupVersion };
  });
  await check("image-and-isolation", async () => {
    const result = await checked("docker", dockerArgs(["run", "--pull=never", "--rm", "--read-only", "--user", "1000:1000",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--network", "none",
      ...memoryArgs(c.sandbox.memoryMiB),
      "--cpus", String(c.sandbox.cpus), "--pids-limit", String(c.sandbox.pids),
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m", c.sandbox.image, "sh", "-c",
      `codex --version && node -e 'const fs=require("fs"),a=require("assert/strict");a.equal(process.arch,${JSON.stringify(process.arch)});a.equal(process.getuid(),1000);a.equal(fs.existsSync("/var/run/docker.sock"),false);a.throws(()=>fs.writeFileSync("/etc/probe","x"));a.equal(fs.readFileSync("/sys/fs/cgroup/memory.max","utf8").trim(),String(${c.sandbox.memoryMiB}*1048576));a.equal(fs.readFileSync("/sys/fs/cgroup/memory.swap.max","utf8").trim(),"0");a.equal(fs.readFileSync("/sys/fs/cgroup/pids.max","utf8").trim(),String(${c.sandbox.pids}));const cpu=fs.readFileSync("/sys/fs/cgroup/cpu.max","utf8").trim().split(/\\s+/).map(Number);a.equal(cpu[0]/cpu[1],${c.sandbox.cpus});console.log("isolation:passed")'`]));
    if (!result.toString().includes("0.153.4")) throw new Error(L("任务镜像必须使用Codex0.153.4", "The task image must use Codex 0.153.4"));
    return L("Codex0.153.4，非root、只读根目录、资源限制通过", "Codex 0.153.4, non-root, read-only root filesystem and resource limits passed");
  });
  await check("memory-enforcement", async () => {
    const name = `fc-doctor-memory-${randomUUID()}`;
    try {
      const result = await exec("docker", dockerArgs(["run", "--pull=never", "--name", name,
        "--label", "app=feishu-codex-runner-v1", "--label", `node=${c.nodeId}`, "--label", "purpose=doctor",
        "--read-only", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--network", "none", ...memoryArgs(64), "--pids-limit", "32", "--cpus", "1",
        c.sandbox.image, "node", "-e",
        'const f=require("fs"),a=require("assert/strict"),c=require("crypto"),b=[];a.equal(f.readFileSync("/sys/fs/cgroup/memory.swap.max","utf8").trim(),"0");for(let i=0;i<32;i++)b.push(c.randomFillSync(Buffer.alloc(4*1024*1024)));console.log(b.reduce((n,x)=>n+x[0],0));']),
      { timeout: 20_000 });
      const killed = (await checked("docker", dockerArgs(["inspect", "--format", "{{.State.OOMKilled}}", name]))).toString().trim();
      if (result.code !== 137 || killed !== "true") throw new Error(L("实际内存超限未被OOM终止；节点不得接单", "Exceeding the memory limit did not trigger an OOM kill; this node must not take tasks"));
      return { limitMiB: 64, boundedAllocationMiB: 128, oomKilled: true, swapDisabled: true };
    } finally { await exec("docker", dockerArgs(["rm", "-f", name])); }
  });
  await check("projects", async () => {
    for (const p of c.projects) await checked("git", ["-C", p.path, "rev-parse", `${p.ref}^{commit}`]);
    return c.projects.map(p => ({ id: p.id, version: projectVersion(c, p.id), checks: p.checks.length }));
  });
  await check("task-entrypoint-readable", async () => {
    await checked("docker", dockerArgs(["run", "--pull=never", "--rm", "--read-only", "--network", "none",
      "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      ...memoryArgs(128), "--pids-limit", "32", "--cpus", "1", c.sandbox.image,
      "node", "-e", 'const f=require("fs");for(const p of ["/app/entrypoint.mjs","/app/proxy.mjs"])f.readFileSync(p)']));
    return L("非root用户可以读取镜像执行与代理入口", "A non-root user can read the image entrypoint and proxy");
  });
  await check("bridge-tls-and-auth", async () => {
    const client = new BridgeClient(c.bridgeUrl, c.caFile, c.token);
    await client.poll(0, 0); return L("TLS主机名、私有CA及节点凭据通过", "TLS hostname, private CA and node credentials passed");
  });
  report.checks.push({ name: "disk-budget", ok: true, detail: L("2秒监测，非硬配额；不自动清理未验收工作区", "Checked every 2 seconds, not a hard quota; workspaces not yet accepted are never cleaned up automatically") });
  if (live) await check("model-live", async () => {
    const id = randomUUID(), app = sandboxConfig(c);
    app.sandbox.timeoutSeconds = Math.min(app.sandbox.timeoutSeconds, 90);
    const box = new Sandbox(app, { appId: "", appSecret: "", modelKey });
    const s: Session = { id, tenantId: "doctor", chatId: "doctor", rootMessageId: "doctor", initiatorId: c.ownerId,
      workspaceVolume: `fc-doctor-work-${id}`, stateVolume: `fc-doctor-state-${id}`, initialized: false, review: "open", createdAt: Date.now() };
    const jobId = randomUUID();
    const j: Job = { id: jobId, runId: jobId, generation: 1, sessionId: id, messageId: "doctor", senderId: c.ownerId, mode: "discuss",
      status: "running", createdAt: Date.now(), prompt: L("必须实际调用shell执行pwd和ls -la，再报告真实隔离目录。只读，不修改文件。", "You must actually call the shell to run pwd and ls -la, then report the real isolated directory. Read only; do not modify any files.") };
    const guard = startGuard(c.nodeId, j.id, 1, 90_000, 90_000, c.sandbox.dockerContext);
    try {
      const r = await box.run(s, j, () => {});
      if (r.status !== "completed" || !r.events.some(e => e.type === "command" && e.exitCode === 0))
        throw new Error(r.error ?? L("兼容provider未完成真实工具调用", "The compatible provider did not complete a real tool call"));
      report.live = true; return { toolCalls: r.events.filter(e => e.type === "command").length, completed: true };
    } finally {
      await box.close();
      guard.disarm();
      for (const v of [s.workspaceVolume, s.stateVolume]) await exec("docker", dockerArgs(["volume", "rm", v]));
    }
  });
  await mkdir(c.dataDir, { recursive: true, mode: 0o700 });
  await writeFile(join(c.dataDir, live ? "doctor-live.json" : "doctor.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  return report;
}
export async function ready(c: NodeConfig, modelKey: string): Promise<boolean> {
  try {
    const reports = await Promise.all(["doctor.json", "doctor-live.json"].map(async f => JSON.parse(await readFile(join(c.dataDir, f), "utf8")) as DoctorReport));
    return reports.every(r => r.configHash === configHash(c, modelKey) &&
      r.checks.some(x => x.name === "memory-enforcement" && x.ok) &&
      r.checks.filter(x => x.name !== "bridge-tls-and-auth").every(x => x.ok)) && reports[1]?.live === true;
  } catch { return false; }
}
