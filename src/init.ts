import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { configSchema, type AppConfig } from "./config.js";
import { nodeConfigSchema, nodeCapabilities, type NodeConfig } from "./runner/config.js";
import { Store } from "./store.js";
import { RunnerRegistry } from "./runner/registry.js";

/** Everything the setup wizard collects; the rest uses safe defaults. */
export interface InitAnswers {
  root: string;
  appId: string;
  appSecret: string;
  baseUrl: string;
  intentModel: string;
  intentKey: string;
  codingModel: string;
  codingKey: string;
  effort: "low" | "medium" | "high" | "xhigh";
  tenantId: string;
  chatId: string;
  leader: string;
  members: string[];
  projectId: string;
  projectPath: string;
  port: number;
}

export function bridgeConfig(a: InitAnswers): AppConfig {
  const data = join(a.root, "data");
  return configSchema.parse({
    tenantId: a.tenantId, allowedChats: [a.chatId],
    allowedMembers: [...new Set([a.leader, ...a.members])], leaders: [a.leader],
    receiveBackground: true, threadFollowups: "mention", replyMode: "thread", naturalExecution: true, cutoffTime: Date.now(),
    // Bridge mode never calls this provider; real models are configured on Runners.
    provider: { baseUrl: "https://unused.invalid/v1", model: "node-only" },
    repositories: [{ id: a.projectId, path: a.projectPath, ref: "HEAD", checks: [["node", "--test"]] }],
    defaultRepo: a.projectId, dataDir: "./data", concurrency: 2,
    runnerBridge: {
      port: a.port, certFile: join(data, "tls/bridge.crt"), keyFile: join(data, "tls/bridge.key"),
      enrollmentKeyFile: join(data, "enrollment.key"), defaultNode: "team-runner", sharedNodes: ["team-runner"], feishuEnabled: true,
      intentModel: { baseUrl: a.baseUrl, model: a.intentModel, keyEnv: "BRIDGE_MODEL_API_KEY" },
      defaults: { model: a.codingModel, effort: a.effort },
      models: [...new Map([[a.codingModel, { id: a.codingModel, label: a.codingModel }], [a.intentModel, { id: a.intentModel, label: a.intentModel }]]).values()],
      groupAgent: { enabled: true, node: "team-runner" },
    },
  });
}

/** Runner template for the shared server node, before pairing assigns its identity. */
export function runnerTemplate(a: InitAnswers): Omit<NodeConfig, "nodeId" | "token"> {
  const staged = nodeConfigSchema.parse({
    bridgeUrl: `https://127.0.0.1:${a.port}`, caFile: join(a.root, "data/tls/ca.crt"),
    nodeId: "00000000-0000-4000-8000-000000000000", token: "pending".repeat(8),
    name: "team-runner", ownerId: a.leader, dataDir: join(a.root, "runner/state"), capacity: 1,
    provider: { baseUrl: a.baseUrl, model: a.codingModel, label: "团队服务器" }, modelKeyEnv: "CODEX_MODEL_API_KEY",
    projects: [{ id: a.projectId, path: a.projectPath, ref: "HEAD", checks: [["node", "--test"]] }],
    sandbox: { image: "feishu-codex-task:runner-v1", egressHosts: ["registry.npmjs.org"] },
  });
  const { nodeId: _id, token: _token, ...template } = staged;
  return template;
}

function secretFile(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Write config.json and .env for the Bridge; refuses to overwrite an existing deployment. */
export function writeBridge(a: InitAnswers): { configFile: string; envFile: string } {
  const configFile = join(a.root, "config.json"), envFile = join(a.root, ".env");
  if (existsSync(configFile)) throw new Error("config.json 已存在，向导不会覆盖现有部署");
  secretFile(configFile, `${JSON.stringify({ ...bridgeConfig(a), dataDir: "./data" }, null, 2)}\n`);
  secretFile(envFile, `FEISHU_APP_ID=${a.appId}\nFEISHU_APP_SECRET=${a.appSecret}\nBRIDGE_MODEL_API_KEY=${a.intentKey}\n`);
  return { configFile, envFile };
}

/**
 * Register the local team-runner directly in the Bridge database (same machine, trusted),
 * then write its runner.json and .env. Equivalent to `runner:admin pair` + `runner:setup`.
 */
export function pairLocalRunner(a: InitAnswers): { runnerFile: string; nodeId: string } {
  const dir = join(a.root, "runner"), runnerFile = join(dir, "runner.json");
  if (existsSync(runnerFile)) throw new Error("runner/runner.json 已存在，向导不会重复配对");
  const config = { ...bridgeConfig(a), dataDir: join(a.root, "data") };
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const store = new Store(join(config.dataDir, "control.sqlite"));
  try {
    const registry = new RunnerRegistry(config, store);
    const template = runnerTemplate(a);
    const staged = nodeConfigSchema.parse({ ...template, nodeId: "00000000-0000-4000-8000-000000000000", token: "pending".repeat(8) });
    const { node, token } = registry.enroll(registry.pair(a.leader, "team-runner"), randomUUID(), nodeCapabilities(staged, false));
    const runner = nodeConfigSchema.parse({ ...template, nodeId: node.id, token });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    secretFile(runnerFile, `${JSON.stringify(runner, null, 2)}\n`);
    secretFile(join(dir, ".env"), `CODEX_MODEL_API_KEY=${a.codingKey}\n`);
    return { runnerFile, nodeId: node.id };
  } finally { store.close(); }
}

/** systemd units with this checkout's absolute paths. */
export function systemdUnits(root: string, node = process.execPath): Record<string, string> {
  const abs = resolve(root);
  return {
    "roundtable.service": `[Unit]\nDescription=Roundtable Bridge\nAfter=network-online.target docker.service\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${abs}\nEnvironment=FEISHU_CODEX_CONFIG=${abs}/config.json\nExecStart=${node} ${abs}/dist/src/main.js\nRestart=on-failure\nRestartSec=5\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n`,
    "roundtable-runner.service": `[Unit]\nDescription=Roundtable Runner (team-runner)\nAfter=network-online.target docker.service roundtable.service\nRequires=docker.service\n\n[Service]\nType=simple\nWorkingDirectory=${abs}\nEnvironment=FEISHU_RUNNER_CONFIG=${abs}/runner/runner.json\nExecStart=${node} ${abs}/dist/src/runner/cli.js run\nRestart=on-failure\nRestartSec=5\nKillMode=process\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n`,
  };
}
