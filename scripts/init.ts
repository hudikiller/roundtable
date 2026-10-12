// Roundtable setup wizard: `npm run init`. Interactive by default; `--yes` takes answers from RT_* env vars.
import { createInterface } from "node:readline/promises";
import { existsSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createLarkChannel } from "@larksuite/channel";
import { normalizeMessage } from "../src/feishu.js";
import { createTls } from "../src/runner/tls.js";
import { writeBridge, pairLocalRunner, systemdUnits, type InitAnswers } from "../src/init.js";

const root = resolve(process.cwd());
const auto = process.argv.includes("--yes");
const env = process.env;
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
let muted = false;
(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = function (this: { output: NodeJS.WritableStream }, s: string) {
  if (!muted || s.includes("\n")) this.output.write(muted ? "\n" : s);
};
const step = (n: number, title: string) => console.log(`\n\x1b[1m[${n}/7] ${title}\x1b[0m`);
async function ask(label: string, fallback = "", key?: string, secret = false): Promise<string> {
  const preset = key ? env[key] : undefined;
  if (preset !== undefined) return preset;
  if (auto) { if (fallback || !secret) return fallback; throw new Error(`--yes 模式缺少 ${key}`); }
  const prompt = `${label}${fallback && !secret ? `（默认 ${fallback}）` : ""}：`;
  let answer: string;
  if (secret) { process.stdout.write(prompt); muted = true; answer = (await rl.question("")).trim(); muted = false; }
  else answer = (await rl.question(prompt)).trim();
  return answer || fallback;
}
async function yes(label: string, key: string, fallback: boolean): Promise<boolean> {
  const v = (await ask(`${label} [${fallback ? "Y/n" : "y/N"}]`, "", key)).toLowerCase();
  return v ? v.startsWith("y") : fallback;
}
function run(cmd: string, args: string[], extraEnv: Record<string, string> = {}): boolean {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: root, env: { ...env, ...extraEnv } });
  return r.status === 0;
}
function have(cmd: string, args: string[]): string | undefined {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return r.status === 0 ? (r.stdout || r.stderr).trim().split("\n")[0] : undefined;
}

/** Connect to Feishu briefly and collect the tenant, group and members from real @-mentions. */
async function discover(appId: string, appSecret: string): Promise<{ tenantId: string; chatId: string; members: { id: string; name: string }[] } | undefined> {
  const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {} };
  const channel = createLarkChannel({ appId, appSecret, includeRawEvent: true, logger, source: "roundtable-init",
    policy: { requireMention: false, dmMode: "disabled" } });
  const chats = new Map<string, { tenantId: string; members: Map<string, string> }>();
  channel.on("message", m => {
    const msg = normalizeMessage(m);
    if (!msg) return;
    const chat = chats.get(msg.chatId) ?? { tenantId: msg.tenantId, members: new Map() };
    if (!chat.members.has(msg.senderId)) console.log(`  收到：群 ${msg.chatId} · 成员 ${msg.senderName || ""}（${msg.senderId}）`);
    chat.members.set(msg.senderId, msg.senderName && msg.senderName !== msg.senderId ? msg.senderName : "");
    chats.set(msg.chatId, chat);
  });
  await channel.connect();
  console.log("  已连接飞书。请让每位成员在测试群里 @ 一次机器人（第一个 @ 的人默认为 Leader），全部收到后按回车。");
  await rl.question("");
  await channel.disconnect();
  const [chatId, chat] = [...chats.entries()][0] ?? [];
  return chat && chatId ? { tenantId: chat.tenantId, chatId, members: [...chat.members.entries()].map(([id, name]) => ({ id, name })) } : undefined;
}

async function main(): Promise<void> {
  console.log("\x1b[1mRoundtable 一键初始化\x1b[0m —— 生成 Bridge 配置、证书、示例项目，并在本机登记 team-runner。");
  if (existsSync(join(root, "config.json"))) throw new Error("config.json 已存在。向导只用于全新部署，不会覆盖现有配置。");
  if (!existsSync(join(root, "dist/src/main.js"))) throw new Error("请先运行 npm ci && npm run build。");

  step(1, "环境检查");
  const checks: [string, string | undefined, boolean][] = [
    ["Node.js 24", process.version.startsWith("v24.") ? process.version : undefined, true],
    ["Docker", have("docker", ["version", "--format", "{{.Server.Version}}"]), true],
    ["Git", have("git", ["--version"]), true],
    ["OpenSSL", have("openssl", ["version"]), true],
  ];
  for (const [name, found] of checks) console.log(`  ${found ? "✅" : "❌"} ${name}${found ? `：${found}` : ""}`);
  if (checks.some(([, found, required]) => required && !found)) throw new Error("缺少必需的环境，请先安装后重试。");

  step(2, "飞书应用（开放平台 → 凭证与基础信息）");
  const appId = await ask("App ID", "", "RT_APP_ID");
  const appSecret = await ask("App Secret（输入时不显示）", "", "RT_APP_SECRET", true);
  if (!/^cli_/.test(appId) || !appSecret) throw new Error("App ID 应以 cli_ 开头，App Secret 不能为空");

  step(3, "模型服务（兼容 OpenAI Responses API）");
  const baseUrl = await ask("Base URL", "https://api.openai.com/v1", "RT_BASE_URL");
  const intentModel = await ask("意图识别模型（快）", "", "RT_INTENT_MODEL");
  const intentKey = await ask("意图识别模型 Key（输入时不显示）", "", "RT_INTENT_KEY", true);
  const codingModel = await ask("编码模型（强）", intentModel, "RT_CODING_MODEL");
  const codingKey = await ask("编码模型 Key（回车沿用上一个，输入时不显示）", intentKey, "RT_CODING_KEY", true);
  const effort = await ask("默认思考强度 low/medium/high/xhigh", "medium", "RT_EFFORT") as InitAnswers["effort"];
  if (!baseUrl.startsWith("https://") || !intentModel || !intentKey || !["low", "medium", "high", "xhigh"].includes(effort))
    throw new Error("模型服务需要 HTTPS 地址、模型名和 Key，思考强度为 low/medium/high/xhigh");

  step(4, "测试群与成员");
  let tenantId = env.RT_TENANT ?? "", chatId = env.RT_CHAT ?? "", leader = env.RT_LEADER ?? "";
  let members = (env.RT_MEMBERS ?? "").split(",").map(x => x.trim()).filter(Boolean);
  if (!tenantId && await yes("自动识别？（需要已在开放平台订阅消息事件并发布；识别期间请勿运行其他使用此应用的程序）", "RT_DISCOVER", true)) {
    const found = await discover(appId, appSecret);
    if (!found) throw new Error("没有收到任何群消息：请确认机器人已进群、已订阅 im.message.receive_v1 并发布版本");
    tenantId = found.tenantId; chatId = found.chatId;
    found.members.forEach((m, i) => console.log(`  ${i + 1}. ${m.name || "成员"}（${m.id}）`));
    const pick = Number(await ask("哪一位是 Leader（填序号）", "1")) - 1;
    leader = found.members[pick]?.id ?? found.members[0]!.id;
    members = found.members.map(m => m.id);
  }
  tenantId ||= await ask("tenant_key", "", "RT_TENANT");
  chatId ||= await ask("测试群 chat_id（oc_…）", "", "RT_CHAT");
  leader ||= await ask("Leader 的 open_id（ou_…）", "", "RT_LEADER");
  if (!members.length) members = (await ask("其他成员 open_id，逗号分隔（可留空）", "", "RT_MEMBERS")).split(",").map(x => x.trim()).filter(Boolean);
  if (!tenantId || !/^oc_/.test(chatId) || !/^ou_/.test(leader)) throw new Error("需要 tenant_key、oc_ 开头的群 ID 和 ou_ 开头的 Leader open_id");

  step(5, "生成证书、示例项目与 Bridge 配置");
  const custom = await ask("要接入的项目 Git 仓库绝对路径（回车使用自带示例）", "", "RT_PROJECT_PATH");
  const projectPath = custom || join(root, "data/fixture-repo");
  if (!custom && !existsSync(projectPath) && !run(process.execPath, ["--import", "tsx", "scripts/fixture-init.ts", projectPath]))
    throw new Error("示例项目初始化失败");
  const tls = await createTls(join(root, "data/tls"));
  console.log(`  ✅ TLS 证书：data/tls（CA 指纹 ${tls.caFingerprint.slice(0, 23)}…）`);
  const answers: InitAnswers = { root, appId, appSecret, baseUrl, intentModel, intentKey, codingModel, codingKey, effort,
    tenantId, chatId, leader, members, projectId: custom ? (env.RT_PROJECT_ID || "project") : "feedbackdesk", projectPath, port: 9443 };
  const { configFile } = writeBridge(answers);
  console.log(`  ✅ ${configFile} 与 .env（权限 600）`);

  step(6, "在本机登记 team-runner");
  const { runnerFile, nodeId } = pairLocalRunner(answers);
  console.log(`  ✅ ${runnerFile}（节点 ${nodeId.slice(0, 8)}…，由 Leader 登记，团队共享）`);

  step(7, "镜像、诊断与启动");
  if (await yes("现在构建任务镜像 feishu-codex-task:runner-v1？（首次需要几分钟）", "RT_BUILD_IMAGE", true))
    if (!run("docker", ["build", "-t", "feishu-codex-task:runner-v1", "-f", "docker/task.Dockerfile", "."])) throw new Error("镜像构建失败");
  const runnerEnv = { FEISHU_RUNNER_CONFIG: runnerFile };
  if (await yes("运行免费诊断（Docker 隔离、内存 OOM、项目）？", "RT_DOCTOR", true)) run(process.execPath, ["dist/src/runner/cli.js", "doctor"], runnerEnv);
  if (await yes("运行真实模型诊断（会产生少量模型费用，节点接单前必须通过）？", "RT_DOCTOR_LIVE", false))
    run(process.execPath, ["dist/src/runner/cli.js", "doctor", "--live"], runnerEnv);
  const units = systemdUnits(root);
  if (process.getuid?.() === 0 && existsSync("/etc/systemd/system") && await yes("安装并启动 systemd 服务（roundtable、roundtable-runner）？", "RT_SYSTEMD", false)) {
    for (const [name, content] of Object.entries(units)) writeFileSync(`/etc/systemd/system/${name}`, content, { mode: 0o644 });
    run("systemctl", ["daemon-reload"]);
    run("systemctl", ["enable", "--now", "roundtable.service", "roundtable-runner.service"]);
  } else {
    console.log(`\n启动方式（两个终端，或参考 deploy/ 中的 systemd 模板）：
  FEISHU_CODEX_CONFIG=${configFile} node dist/src/main.js
  FEISHU_RUNNER_CONFIG=${runnerFile} node dist/src/runner/cli.js run`);
  }
  console.log(`\n\x1b[1m完成！\x1b[0m 节点通过免费诊断和真实模型诊断后即可接单。
然后在测试群里试试：“@机器人 总结一下我们刚才说的，按讨论分个工”。`);
}

main().catch(e => { console.error(`\n❌ ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; }).finally(() => rl.close());
