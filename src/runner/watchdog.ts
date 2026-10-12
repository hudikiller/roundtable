import { createInterface } from "node:readline";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { exec } from "../process.js";
import { ContainerTermination } from "../container-termination.js";

export interface LeaseGuard { renew(ms: number): void; disarm(): void; stopped: boolean }
export function startGuard(nodeId: string, runId: string, generation: number, leaseMs: number, maxMs: number,
  dockerContext?: string): LeaseGuard {
  const path = fileURLToPath(new URL("./watchdog.js", import.meta.url));
  const child = spawn(process.execPath, [path, "--guard", nodeId, runId, String(generation), String(leaseMs), String(maxMs), dockerContext ?? ""],
    { stdio: ["pipe", "pipe", "pipe"], detached: true, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  const guard: LeaseGuard = { stopped: false,
    renew(ms) { if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(JSON.stringify({ renew: ms }) + "\n"); },
    disarm() { if (!child.stdin.destroyed && !child.stdin.writableEnded) { child.stdin.write(JSON.stringify({ disarm: true }) + "\n"); child.stdin.end(); } },
  };
  child.stdin.on("error", () => { guard.stopped = true; });
  child.stdout.on("data", b => { if (String(b).includes("lease_stopped")) guard.stopped = true; });
  child.stderr.resume();
  child.on("error", () => { guard.stopped = true; });
  child.on("exit", code => { if (code !== 0) guard.stopped = true; });
  return guard;
}

async function guardMain(): Promise<void> {
  const [, , , nodeId, runId, gen, initial, duration, context] = process.argv;
  if (!nodeId || !runId || !/^[a-f0-9-]{36}$/.test(nodeId) || !/^[a-f0-9-]{36}$/.test(runId) || !/^\d+$/.test(gen ?? ""))
    throw new Error("看门狗参数不合法");
  const args = (a: string[]) => context ? ["--context", context, ...a] : a;
  let deadline = performance.now() + Number(initial), wallDeadline = Date.now() + Number(initial), disarmed = false, stopping = false;
  const started = performance.now(), wallStarted = Date.now();
  const filters = ["--filter", "label=app=feishu-codex-runner-v1", "--filter", `label=node=${nodeId}`,
    "--filter", `label=run=${runId}`, "--filter", `label=generation=${gen}`];
  const term = new ContainerTermination((_c, a, o) => exec("docker", args(a), o));
  const stop = async () => {
    if (stopping || disarmed) return;
    stopping = true;
    try {
      // A launcher may still be completing an in-flight docker request after the parent exits.
      for (let pass = 0; pass < 20; pass++) {
        const containers = await exec("docker", args(["ps", "-aq", ...filters]), { timeout: 5000 });
        if (containers.code !== 0) throw new Error("看门狗无法访问Docker");
        for (const id of containers.stdout.toString().trim().split(/\s+/).filter(Boolean)) await term.remove(id);
        const networks = await exec("docker", args(["network", "ls", "-q", ...filters]), { timeout: 5000 });
        if (networks.code !== 0) throw new Error("看门狗无法查询网络");
        for (const id of networks.stdout.toString().trim().split(/\s+/).filter(Boolean)) {
          const removed = await exec("docker", args(["network", "rm", id]));
          if (removed.code !== 0 && !/not found|No such network/i.test(removed.stderr)) throw new Error("看门狗网络终止未确认");
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      console.log("lease_stopped"); process.exit(2);
    } catch { process.exit(3); }
  };
  const input = createInterface({ input: process.stdin });
  input.on("line", line => {
    try {
      const value = JSON.parse(line);
      if (value.disarm) { disarmed = true; process.exit(0); }
      if (Number.isFinite(value.renew) && value.renew > 0 && !stopping) {
        deadline = performance.now() + Math.min(value.renew, 60_000);
        wallDeadline = Date.now() + Math.min(value.renew, 60_000);
      }
    } catch { void stop(); }
  });
  input.on("close", () => { if (!disarmed) void stop(); });
  setInterval(() => {
    if (performance.now() >= deadline || Date.now() >= wallDeadline ||
      performance.now() - started >= Number(duration) || Date.now() - wallStarted >= Number(duration)) void stop();
  }, 250);
}
if (process.argv[2] === "--guard") void guardMain().catch(() => process.exit(3));
