import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadEnvironment } from "../src/config.js";
import { Sandbox } from "../src/sandbox.js";
import { checked as processChecked, exec as processExec } from "../src/process.js";
import { loadNode, sandboxConfig } from "../src/runner/config.js";
import { setSecrets } from "../src/log.js";
import type { Session } from "../src/types.js";
import { memoryArgs } from "../src/container-resources.js";
import { startGuard } from "../src/runner/watchdog.js";

const environment = process.env.FEISHU_RUNNER_CONFIG ? (() => {
  const { config: node, modelKey } = loadNode();
  return { config: sandboxConfig(node), secrets: { appId: "", appSecret: "", modelKey } };
})() : loadEnvironment();
const { config, secrets } = environment;
function args(cmd: string, argv: string[]): string[] {
  return cmd === "docker" && config.sandbox.dockerContext ? ["--context", config.sandbox.dockerContext, ...argv] : argv;
}
const checked = (cmd: string, argv: string[], opts?: Parameters<typeof processChecked>[2]) => processChecked(cmd, args(cmd, argv), opts);
const exec = (cmd: string, argv: string[], opts?: Parameters<typeof processExec>[2]) => processExec(cmd, args(cmd, argv), opts);
setSecrets([secrets.appSecret, secrets.modelKey]);
const sandbox = new Sandbox(config, secrets), id = randomUUID();
const session: Session = { id, tenantId: config.tenantId, chatId: config.allowedChats[0]!,
  rootMessageId: "sandbox-check", initiatorId: config.allowedMembers[0]!, repoId: config.defaultRepo,
  workspaceVolume: `fc-work-${id}`, stateVolume: `fc-state-${id}`, initialized: false, review: "open", createdAt: Date.now() };
const net = `fc-test-net-${id}`, proxy = `fc-test-proxy-${id}`;
const safe = ["--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
  "--user", "1000:1000", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m"];
const labels = ["--label", `app=${config.sandbox.nodeId ? "feishu-codex-runner-v1" : "feishu-codex"}`,
  ...(config.sandbox.nodeId ? ["--label", `node=${config.sandbox.nodeId}`] : []), "--label", `session=${id}`];
const results: Record<string, unknown> = { kind: "real-docker-no-model" };
let phase = "snapshot";
try {
  await sandbox.initialize(session, "execute");
  phase = "filesystem";
  const ro = await checked("docker", ["run", "--rm", ...labels, ...safe, "--network", "none",
    "--cpus", "2", ...memoryArgs(4096), "--pids-limit", "256",
    "--mount", `type=volume,src=${session.workspaceVolume},dst=/workspace,readonly`,
    config.sandbox.image, "node", "-e", `
      const fs=require("fs"),assert=require("assert/strict");
      assert.equal(process.getuid(),1000);
      assert.equal(fs.existsSync("/var/run/docker.sock"),false);
      assert.throws(()=>fs.writeFileSync("/etc/task-write","x"));
      assert.throws(()=>fs.writeFileSync("/workspace/task-write","x"));
      const limits={
        memory:fs.readFileSync("/sys/fs/cgroup/memory.max","utf8").trim(),
        swap:fs.readFileSync("/sys/fs/cgroup/memory.swap.max","utf8").trim(),
        pids:fs.readFileSync("/sys/fs/cgroup/pids.max","utf8").trim(),
        cpu:fs.readFileSync("/sys/fs/cgroup/cpu.max","utf8").trim()
      };
      assert.equal(limits.memory,"4294967296");
      assert.equal(limits.swap,"0");
      assert.equal(limits.pids,"256");
      assert.equal(limits.cpu,"200000 100000");
      console.log(JSON.stringify({uid:process.getuid(),readonly:true,limits}));
    `]);
  results.filesystemAndResources = JSON.parse(ro.toString());
  phase = "persistence";
  await checked("docker", ["run", "--rm", ...labels, ...safe, "--network", "none",
    "--mount", `type=volume,src=${session.workspaceVolume},dst=/workspace`,
    config.sandbox.image, "node", "-e", 'require("fs").writeFileSync("/workspace/persistence.txt","persistent")']);
  const persisted = await checked("docker", ["run", "--rm", ...labels, ...safe, "--network", "none",
    "--mount", `type=volume,src=${session.workspaceVolume},dst=/workspace,readonly`,
    config.sandbox.image, "cat", "/workspace/persistence.txt"]);
  assert.equal(persisted.toString(), "persistent"); results.persistence = true;
  phase = "network";
  await checked("docker", ["network", "create", "--internal", ...labels, net]);
  await checked("docker", ["run", "-d", "--name", proxy, ...labels, ...safe,
    "--network", "bridge", "-e", 'ALLOWED_HOSTS=["registry.npmjs.org"]',
    "-e", `PINNED_ADDRESSES=${JSON.stringify(config.sandbox.egressAddresses ?? {})}`,
    config.sandbox.image, "node", "/app/proxy.mjs"]);
  await checked("docker", ["network", "connect", "--alias", "egress", net, proxy]);
  const network = await checked("docker", ["run", "--rm", ...labels, ...safe, "--network", net,
    config.sandbox.image, "node", "-e", `
      const net=require("net"),assert=require("assert/strict");
      function probe(host,port,payload) { return new Promise(resolve=>{
        const socket=net.connect({host,port});let data="";
        const t=setTimeout(()=>{socket.destroy();resolve(data||"blocked")},2000);
        socket.on("error",()=>{clearTimeout(t);resolve("blocked")});
        socket.on("connect",()=>{if(payload)socket.write(payload);else{clearTimeout(t);socket.destroy();resolve("connected")}});
        socket.on("data",chunk=>{data+=chunk;clearTimeout(t);socket.destroy();resolve(data)});
      });}
      (async()=>{
        const direct=await probe("1.1.1.1",443);
        assert.equal(direct,"blocked");
        const denied=await probe("egress",3128,"CONNECT example.org:443 HTTP/1.1\\r\\nHost: example.org\\r\\n\\r\\n");
        assert.match(denied,/403/);
        const metadata=await probe("egress",3128,"CONNECT 169.254.169.254:443 HTTP/1.1\\r\\n\\r\\n");
        assert.match(metadata,/403/);
        const allowed=await probe("egress",3128,"CONNECT registry.npmjs.org:443 HTTP/1.1\\r\\nHost: registry.npmjs.org\\r\\n\\r\\n");
        assert.match(allowed,/200 Connection Established/);
        console.log(JSON.stringify({directBlocked:true,unlistedBlocked:true,metadataBlocked:true,allowlistConnect:true}));
      })().catch(e=>{console.error(e.message);process.exit(1)});
    `], { timeout: 20_000 });
  results.network = JSON.parse(network.toString());
  phase = "memory-oom";
  const memoryName = `fc-memory-test-${id}`;
  const exhausted = await exec("docker", ["run", "--name", memoryName, ...labels, ...safe, "--network", "none",
    ...memoryArgs(64), "--pids-limit", "32", "--cpus", "1",
    config.sandbox.image, "node", "-e", 'const c=require("crypto"),a=[];for(let i=0;i<32;i++)a.push(c.randomFillSync(Buffer.alloc(4*1024*1024)));console.log(a.reduce((n,b)=>n+b[0],0));'], { timeout: 20_000 });
  assert.notEqual(exhausted.code, 0);
  assert.equal((await checked("docker", ["inspect", "--format", "{{.State.OOMKilled}}", memoryName])).toString().trim(), "true");
  results.actualMemoryLimitTerminated = true;
  phase = "pids-enforcement";
  const processes = await checked("docker", ["run", "--rm", ...labels, ...safe, "--network", "none",
    ...memoryArgs(128), "--pids-limit", "32", "--cpus", "1", config.sandbox.image, "node", "-e", `
      const {spawn}=require("child_process"),assert=require("assert/strict");
      let denied=0;const pending=[];
      for(let i=0;i<48;i++)pending.push(new Promise(resolve=>{
        const child=spawn("sleep",["5"],{stdio:"ignore"});
        child.on("error",e=>{assert.equal(e.code,"EAGAIN");denied++;resolve()});
        child.on("spawn",()=>child.kill("SIGTERM"));child.on("exit",resolve);
      }));
      Promise.all(pending).then(()=>{assert.ok(denied>0);console.log(JSON.stringify({pidsLimit:32,denied}))});
    `], { timeout: 20_000 });
  results.actualProcessLimit = JSON.parse(processes.toString());
  if (config.sandbox.nodeId) {
    phase = "lease-watchdog";
    const runId = randomUUID(), leaseName = `fc-lease-test-${id}`, leaseNet = `fc-lease-net-${id}`;
    const runLabels = [...labels, "--label", `run=${runId}`, "--label", "generation=1"];
    await checked("docker", ["network", "create", "--internal", ...runLabels, leaseNet]);
    await checked("docker", ["run", "-d", "--name", leaseName, ...runLabels, ...safe,
      "--network", leaseNet, ...memoryArgs(128), "--pids-limit", "32", "--cpus", "1",
      config.sandbox.image, "node", "-e", 'require("child_process").spawn("sleep",["300"]);setInterval(()=>{},1000)']);
    const guard = startGuard(config.sandbox.nodeId, runId, 1, 750, 5000, config.sandbox.dockerContext);
    const until = Date.now() + 30_000;
    while ((await exec("docker", ["inspect", leaseName])).code === 0 && Date.now() < until)
      await new Promise(resolve => setTimeout(resolve, 250));
    assert.notEqual((await exec("docker", ["inspect", leaseName])).code, 0);
    while ((await exec("docker", ["network", "inspect", leaseNet])).code === 0 && Date.now() < until)
      await new Promise(resolve => setTimeout(resolve, 250));
    assert.notEqual((await exec("docker", ["network", "inspect", leaseNet])).code, 0);
    guard.disarm();
    results.expiredLeaseTerminatedContainersAndNetwork = true;
  }
  phase = "stop-background";
  const stopName = `fc-stop-test-${id}`;
  await checked("docker", ["run", "-d", "--name", stopName, ...labels, ...safe, "--network", "none",
    config.sandbox.image, "node", "-e", 'require("child_process").spawn("sh",["-c","sleep 300 & wait"],{stdio:"ignore"});setInterval(()=>{},1000)']);
  await sandbox.stop(id);
  assert.notEqual((await exec("docker", ["inspect", stopName])).code, 0);
  results.stopWithBackgroundChild = true;
  await mkdir(join(config.dataDir, "verification"), { recursive: true, mode: 0o700 });
  await writeFile(join(config.dataDir, "verification/sandbox.json"), JSON.stringify(results, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ nodeId: config.sandbox.nodeId, ...results }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ phase, ...results, error: error instanceof Error ? error.message : "unknown" }));
  throw error;
} finally {
  await sandbox.stop(id);
  await exec("docker", ["rm", "-f", proxy]);
  await exec("docker", ["network", "rm", net]);
  const remaining = await exec("docker", ["network", "ls", "-q", "--filter", `label=session=${id}`,
    "--filter", `label=app=${config.sandbox.nodeId ? "feishu-codex-runner-v1" : "feishu-codex"}`]);
  for (const network of remaining.stdout.toString().trim().split(/\s+/).filter(Boolean))
    await exec("docker", ["network", "rm", network]);
  for (const volume of [session.workspaceVolume, session.stateVolume]) await exec("docker", ["volume", "rm", volume]);
}
