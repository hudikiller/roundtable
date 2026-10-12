import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { nodeConfigSchema, loadNode, nodeCapabilities } from "./config.js";
import { BridgeClient } from "./client.js";
import { doctor, ready } from "./doctor.js";
import { RunnerDaemon } from "./daemon.js";
import { errorText, setSecrets } from "../log.js";

async function main(): Promise<void> {
  const [operation, ...args] = process.argv.slice(2);
  const file = resolve(process.env.FEISHU_RUNNER_CONFIG || "runner.json");
  if (operation === "setup") {
    // Credentials arrive via stdin (one-time code), never argv or chat.
    const input: Buffer[] = [];
    for await (const chunk of process.stdin) input.push(Buffer.from(chunk));
    const { code, ...template } = JSON.parse(Buffer.concat(input).toString());
    const staged = nodeConfigSchema.parse({ nodeId: "00000000-0000-4000-8000-000000000000", token: "pending".repeat(8), ...template });
    const pendingFile = file + ".enrollment";
    let requestId = randomUUID();
    if (existsSync(pendingFile)) {
      const prior = JSON.parse(readFileSync(pendingFile, "utf8"));
      if (prior.completed && existsSync(file)) {
        const saved = nodeConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
        if (saved.name !== staged.name || saved.ownerId !== staged.ownerId || saved.bridgeUrl !== staged.bridgeUrl)
          throw new Error("已有配对配置不同；使用新的配置目录，不能隐式重配节点");
        console.log(JSON.stringify({ paired: true, alreadyPaired: true, nodeId: saved.nodeId, name: saved.name }));
        return;
      }
      if (prior.code !== code) throw new Error("存在待核对配对回执；先确认或清理旧请求");
      requestId = prior.requestId;
    } else {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(pendingFile, JSON.stringify({ code, requestId }), { mode: 0o600 });
    }
    const response = await new BridgeClient(staged.bridgeUrl, staged.caFile).enroll(code, requestId, nodeCapabilities(staged, false));
    const config = nodeConfigSchema.parse({ ...staged, nodeId: response.node.id, token: response.token, ownerId: response.node.ownerId, name: response.node.name });
    writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 }); chmodSync(file, 0o600);
    writeFileSync(pendingFile, JSON.stringify({ requestId, completed: true }), { mode: 0o600 });
    console.log(JSON.stringify({ paired: true, nodeId: config.nodeId, name: config.name, configFile: file }));
    return;
  }
  const { config, modelKey } = loadNode(file);
  setSecrets([config.token, modelKey, config.provider.baseUrl, ...config.projects.map(p => p.path)]);
  if (operation === "doctor") {
    const result = await doctor(config, modelKey, args.includes("--live"));
    console.log(JSON.stringify(result, null, 2));
    if (result.checks.some(c => !c.ok)) process.exitCode = 1;
    return;
  }
  if (operation !== "run") throw new Error("使用 runner:setup / runner:doctor / runner");
  const free = await doctor(config, modelKey);
  const canRun = free.checks.filter(c => c.name !== "bridge-tls-and-auth").every(c => c.ok) && await ready(config, modelKey);
  const daemon = new RunnerDaemon(config, modelKey, canRun);
  let stopping = false;
  const shutdown = async () => { if (stopping) return; stopping = true; await daemon.close(); process.exit(0); };
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { void shutdown(); });
  await daemon.start();
  console.log(JSON.stringify({ runnerReady: canRun, name: config.name, nodeId: config.nodeId }));
}
main().catch(e => { console.error(errorText(e)); process.exitCode = 1; });
