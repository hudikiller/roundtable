import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeConfig, runnerTemplate, writeBridge, pairLocalRunner, systemdUnits, type InitAnswers } from "../src/init.js";
import { nodeConfigSchema } from "../src/runner/config.js";
import { configSchema } from "../src/config.js";
import { Store } from "../src/store.js";
import { RunnerRegistry } from "../src/runner/registry.js";

function answers(root: string): InitAnswers {
  return { root, locale: "zh", appId: "cli_test", appSecret: "secret-x", baseUrl: "https://provider.example/v1", intentModel: "fast-1", intentKey: "k-intent",
    codingModel: "code-1", codingKey: "k-code", effort: "medium", tenantId: "tenant-1", chatId: "oc_group", leader: "ou_lead",
    members: ["ou_lead", "ou_mate"], projectId: "feedbackdesk", projectPath: join(root, "data/fixture-repo"), port: 9443 };
}

test("一键初始化：生成的 Bridge 配置合法，主群 Agent、意图模型与默认模型就绪，成员去重", () => {
  const root = mkdtempSync(join(tmpdir(), "rt-init-"));
  try {
    const c = bridgeConfig(answers(root));
    assert.deepEqual(c.allowedMembers, ["ou_lead", "ou_mate"]); assert.deepEqual(c.leaders, ["ou_lead"]);
    assert.equal(c.runnerBridge?.groupAgent?.enabled, true); assert.equal(c.runnerBridge?.intentModel?.model, "fast-1");
    assert.deepEqual(c.runnerBridge?.defaults, { model: "code-1", effort: "medium" });
    assert.deepEqual(c.runnerBridge?.models.map(m => m.id), ["code-1", "fast-1"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("一键初始化：配置与密钥文件权限 600，绝不覆盖现有部署", () => {
  const root = mkdtempSync(join(tmpdir(), "rt-init-"));
  try {
    const { configFile, envFile } = writeBridge(answers(root));
    assert.equal(statSync(configFile).mode & 0o777, 0o600); assert.equal(statSync(envFile).mode & 0o777, 0o600);
    configSchema.parse(JSON.parse(readFileSync(configFile, "utf8")));
    assert.match(readFileSync(envFile, "utf8"), /FEISHU_APP_SECRET=secret-x\nBRIDGE_MODEL_API_KEY=k-intent/);
    assert.throws(() => writeBridge(answers(root)), /不会覆盖/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("一键初始化：本机登记 team-runner，生成可用的节点凭据，Bridge 能认证，重复运行拒绝", () => {
  const root = mkdtempSync(join(tmpdir(), "rt-init-"));
  try {
    const a = answers(root);
    const { runnerFile, nodeId } = pairLocalRunner(a);
    const runner = nodeConfigSchema.parse(JSON.parse(readFileSync(runnerFile, "utf8")));
    assert.equal(runner.nodeId, nodeId); assert.equal(runner.ownerId, "ou_lead"); assert.equal(runner.provider.model, "code-1");
    assert.equal(statSync(runnerFile).mode & 0o777, 0o600);
    assert.match(readFileSync(join(root, "runner/.env"), "utf8"), /CODEX_MODEL_API_KEY=k-code/);
    const store = new Store(join(root, "data/control.sqlite"));
    try {
      const registry = new RunnerRegistry({ ...bridgeConfig(a), dataDir: join(root, "data") }, store);
      const node = registry.authenticate(runner.token);
      assert.equal(node.name, "team-runner"); assert.equal(registry.shared(node), true, "Leader 登记的 team-runner 对成员共享");
    } finally { store.close(); }
    assert.throws(() => pairLocalRunner(a), /不会重复配对/);
    assert.ok(existsSync(join(root, "data/enrollment.key")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("一键初始化：systemd 单元使用本仓库绝对路径", () => {
  const units = systemdUnits("/opt/roundtable", "/usr/bin/node");
  assert.match(units["roundtable.service"]!, /ExecStart=\/usr\/bin\/node \/opt\/roundtable\/dist\/src\/main.js/);
  assert.match(units["roundtable-runner.service"]!, /FEISHU_RUNNER_CONFIG=\/opt\/roundtable\/runner\/runner.json[\s\S]*KillMode=process/);
});

test("一键初始化：向导选择的界面语言写入 Bridge 配置与 Runner 模板", () => {
  const root = mkdtempSync(join(tmpdir(), "rt-init-"));
  try {
    const a: InitAnswers = { ...answers(root), locale: "en" };
    assert.equal(bridgeConfig(a).locale, "en"); assert.equal(runnerTemplate(a).locale, "en");
    assert.equal(bridgeConfig(answers(root)).locale, "zh"); assert.equal(runnerTemplate(answers(root)).locale, "zh");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
