import { resolve, join } from "node:path";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { loadEnvironment } from "../src/config.js";
import { createTls } from "../src/runner/tls.js";
import { checked } from "../src/process.js";
import { setSecrets, errorText } from "../src/log.js";
import { L } from "../src/i18n.js";

async function main(): Promise<void> {
  if (!process.argv[2]) throw new Error(L("用法：node dist/scripts/runner-bootstrap.js EXISTING_APPROVED_PROJECT_DIR", "Usage: node dist/scripts/runner-bootstrap.js EXISTING_APPROVED_PROJECT_DIR"));
  const source = resolve(process.argv[2]);
  const root = resolve("data/staging");
  if (existsSync(join(root, "config.json"))) throw new Error(L("staging已存在，不覆盖；继续使用已有配置", "staging already exists; not overwriting. Keep using the existing config"));
  const original = loadEnvironment(join(source, "config.json"));
  setSecrets([original.secrets.appSecret, original.secrets.modelKey]);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const tls = await createTls(join(root, "tls"));
  const repo = join(root, "fixture-repo");
  await checked("git", ["clone", "--no-hardlinks", original.config.repositories.find(r => r.id === original.config.defaultRepo)!.path, repo]);
  await checked("git", ["-C", repo, "remote", "remove", "origin"]);
  const config = { ...original.config, dataDir: join(root, "bridge"), provider: {
    baseUrl: "https://unused.invalid/v1", model: "node-only",
  }, cutoffTime: Date.now(), threadFollowups: "mention", replyMode: "thread",
    repositories: [{ id: "feedbackdesk", path: repo, ref: "HEAD", checks: [["node", "--test"]] }],
    defaultRepo: "feedbackdesk", runnerBridge: { port: 9443, certFile: tls.certFile, keyFile: tls.keyFile,
      enrollmentKeyFile: join(root, "bridge", "enrollment.key"), defaultNode: "team-runner", feishuEnabled: false } };
  writeFileSync(join(root, "config.json"), JSON.stringify(config, null, 2), { mode: 0o600 });
  writeFileSync(join(root, ".env"), `FEISHU_APP_ID=${original.secrets.appId}\nFEISHU_APP_SECRET=${original.secrets.appSecret}\n`, { mode: 0o600 });
  const nodeRoot = join(root, "team-runner"); mkdirSync(nodeRoot, { mode: 0o700 });
  writeFileSync(join(nodeRoot, ".env"), `CODEX_MODEL_API_KEY=${original.secrets.modelKey}\n`, { mode: 0o600 });
  const template = { bridgeUrl: "https://127.0.0.1:9443", caFile: tls.caFile, name: "team-runner",
    ownerId: original.config.leaders[0] ?? original.config.allowedMembers[0], dataDir: join(nodeRoot, "state"),
    provider: { ...original.config.provider, label: L("本人项目兼容 API（团队节点）", "Your OpenAI-compatible API (team node)") }, capacity: 1,
    projects: [{ id: "feedbackdesk", path: repo, ref: "HEAD", checks: [["node", "--test"]] }],
    sandbox: { ...original.config.sandbox, image: "feishu-codex-task:runner-v1" } };
  writeFileSync(join(nodeRoot, "template.json"), JSON.stringify(template, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ staging: root, bridgePort: 9443, caFingerprint: tls.caFingerprint, feishuConsumerEnabled: false,
    modelCredentials: L("仅写入节点本机 .env；Bridge配置无模型Key", "Written only to the node's local .env; the Bridge config holds no model key") }));
}
void main().catch(e => { console.error(errorText(e)); process.exitCode = 1; });
