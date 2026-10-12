// Roundtable setup wizard: `npm run init`. Interactive by default; `--yes` takes answers from RT_* env vars.
import { createInterface } from "node:readline/promises";
import { existsSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createLarkChannel } from "@larksuite/channel";
import { normalizeMessage } from "../src/feishu.js";
import { createTls } from "../src/runner/tls.js";
import { writeBridge, pairLocalRunner, systemdUnits, type InitAnswers } from "../src/init.js";
import { L, setLocale, type Locale } from "../src/i18n.js";

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
  if (auto) { if (fallback || !secret) return fallback; throw new Error(L(`--yes 模式缺少 ${key}`, `--yes mode is missing ${key}`)); }
  const prompt = L(`${label}${fallback && !secret ? `（默认 ${fallback}）` : ""}：`, `${label}${fallback && !secret ? ` (default ${fallback})` : ""}: `);
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
/** Asked before anything else, in both languages; the rest of the wizard follows the answer. */
async function chooseLocale(): Promise<Locale> {
  const parse = (v: string): Locale | undefined => { const x = v.trim().toLowerCase(); return !x || x.startsWith("en") ? "en" : x.startsWith("zh") ? "zh" : undefined; };
  if (env.RT_LOCALE !== undefined || auto) {
    const chosen = parse(env.RT_LOCALE ?? "");
    if (!chosen) throw new Error("RT_LOCALE must be en or zh / RT_LOCALE 只能是 en 或 zh");
    return chosen;
  }
  for (;;) {
    const chosen = parse(await rl.question("Language / 语言 [en/zh] (default en): "));
    if (chosen) return chosen;
  }
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
    if (!chat.members.has(msg.senderId)) console.log(L(`  收到：群 ${msg.chatId} · 成员 ${msg.senderName || ""}（${msg.senderId}）`, `  Received: chat ${msg.chatId} · member ${msg.senderName || ""} (${msg.senderId})`));
    chat.members.set(msg.senderId, msg.senderName && msg.senderName !== msg.senderId ? msg.senderName : "");
    chats.set(msg.chatId, chat);
  });
  await channel.connect();
  console.log(L("  已连接飞书。请让每位成员在测试群里 @ 一次机器人（第一个 @ 的人默认为 Leader），全部收到后按回车。", "  Connected to Feishu. Ask each member to @ the bot once in the test group (the first to @ becomes the Leader by default), then press Enter once everyone shows up."));
  await rl.question("");
  await channel.disconnect();
  const [chatId, chat] = [...chats.entries()][0] ?? [];
  return chat && chatId ? { tenantId: chat.tenantId, chatId, members: [...chat.members.entries()].map(([id, name]) => ({ id, name })) } : undefined;
}

async function main(): Promise<void> {
  const locale = await chooseLocale();
  setLocale(locale);
  env.ROUNDTABLE_LOCALE = locale;
  console.log(L("\x1b[1mRoundtable 一键初始化\x1b[0m —— 生成 Bridge 配置、证书、示例项目，并在本机登记 team-runner。",
    "\x1b[1mRoundtable setup\x1b[0m: generates the Bridge config, certificates and a sample project, and registers team-runner on this machine."));
  if (existsSync(join(root, "config.json"))) throw new Error(L("config.json 已存在。向导只用于全新部署，不会覆盖现有配置。", "config.json already exists. The wizard is only for fresh deployments and won't overwrite an existing config."));
  if (!existsSync(join(root, "dist/src/main.js"))) throw new Error(L("请先运行 npm ci && npm run build。", "Run npm ci && npm run build first."));

  step(1, L("环境检查", "Environment check"));
  const checks: [string, string | undefined, boolean][] = [
    ["Node.js 24", process.version.startsWith("v24.") ? process.version : undefined, true],
    ["Docker", have("docker", ["version", "--format", "{{.Server.Version}}"]), true],
    ["Git", have("git", ["--version"]), true],
    ["OpenSSL", have("openssl", ["version"]), true],
  ];
  for (const [name, found] of checks) console.log(`  ${found ? "✅" : "❌"} ${name}${found ? L(`：${found}`, `: ${found}`) : ""}`);
  if (checks.some(([, found, required]) => required && !found)) throw new Error(L("缺少必需的环境，请先安装后重试。", "Required tools are missing. Install them and try again."));

  step(2, L("飞书应用（开放平台 → 凭证与基础信息）", "Feishu app (Developer Console → Credentials & Basic Info)"));
  const appId = await ask("App ID", "", "RT_APP_ID");
  const appSecret = await ask(L("App Secret（输入时不显示）", "App Secret (hidden while typing)"), "", "RT_APP_SECRET", true);
  if (!/^cli_/.test(appId) || !appSecret) throw new Error(L("App ID 应以 cli_ 开头，App Secret 不能为空", "App ID should start with cli_ and App Secret can't be empty"));

  step(3, L("模型服务（兼容 OpenAI Responses API）", "Model service (OpenAI Responses API compatible)"));
  const baseUrl = await ask("Base URL", "https://api.openai.com/v1", "RT_BASE_URL");
  const intentModel = await ask(L("意图识别模型（快）", "Intent model (fast)"), "", "RT_INTENT_MODEL");
  const intentKey = await ask(L("意图识别模型 Key（输入时不显示）", "Intent model key (hidden while typing)"), "", "RT_INTENT_KEY", true);
  const codingModel = await ask(L("编码模型（强）", "Coding model (strong)"), intentModel, "RT_CODING_MODEL");
  const codingKey = await ask(L("编码模型 Key（回车沿用上一个，输入时不显示）", "Coding model key (Enter to reuse the previous one, hidden while typing)"), intentKey, "RT_CODING_KEY", true);
  const effort = await ask(L("默认思考强度 low/medium/high/xhigh", "Default reasoning effort low/medium/high/xhigh"), "medium", "RT_EFFORT") as InitAnswers["effort"];
  if (!baseUrl.startsWith("https://") || !intentModel || !intentKey || !["low", "medium", "high", "xhigh"].includes(effort))
    throw new Error(L("模型服务需要 HTTPS 地址、模型名和 Key，思考强度为 low/medium/high/xhigh", "The model service needs an HTTPS URL, a model name and a key; effort must be low/medium/high/xhigh"));

  step(4, L("测试群与成员", "Test group and members"));
  let tenantId = env.RT_TENANT ?? "", chatId = env.RT_CHAT ?? "", leader = env.RT_LEADER ?? "";
  let members = (env.RT_MEMBERS ?? "").split(",").map(x => x.trim()).filter(Boolean);
  if (!tenantId && await yes(L("自动识别？（需要已在开放平台订阅消息事件并发布；识别期间请勿运行其他使用此应用的程序）", "Detect automatically? (requires the message event to be subscribed and the app published; don't run anything else using this app meanwhile)"), "RT_DISCOVER", true)) {
    const found = await discover(appId, appSecret);
    if (!found) throw new Error(L("没有收到任何群消息：请确认机器人已进群、已订阅 im.message.receive_v1 并发布版本", "No group messages received. Make sure the bot is in the group, im.message.receive_v1 is subscribed and a version is published"));
    tenantId = found.tenantId; chatId = found.chatId;
    found.members.forEach((m, i) => console.log(L(`  ${i + 1}. ${m.name || "成员"}（${m.id}）`, `  ${i + 1}. ${m.name || "Member"} (${m.id})`)));
    const pick = Number(await ask(L("哪一位是 Leader（填序号）", "Which one is the Leader (number)"), "1")) - 1;
    leader = found.members[pick]?.id ?? found.members[0]!.id;
    members = found.members.map(m => m.id);
  }
  tenantId ||= await ask("tenant_key", "", "RT_TENANT");
  chatId ||= await ask(L("测试群 chat_id（oc_…）", "Test group chat_id (oc_…)"), "", "RT_CHAT");
  leader ||= await ask(L("Leader 的 open_id（ou_…）", "Leader open_id (ou_…)"), "", "RT_LEADER");
  if (!members.length) members = (await ask(L("其他成员 open_id，逗号分隔（可留空）", "Other member open_ids, comma-separated (optional)"), "", "RT_MEMBERS")).split(",").map(x => x.trim()).filter(Boolean);
  if (!tenantId || !/^oc_/.test(chatId) || !/^ou_/.test(leader)) throw new Error(L("需要 tenant_key、oc_ 开头的群 ID 和 ou_ 开头的 Leader open_id", "Need a tenant_key, a chat ID starting with oc_ and a Leader open_id starting with ou_"));

  step(5, L("生成证书、示例项目与 Bridge 配置", "Generate certificates, sample project and Bridge config"));
  const custom = await ask(L("要接入的项目 Git 仓库绝对路径（回车使用自带示例）", "Absolute path of the project Git repository to connect (Enter for the bundled sample)"), "", "RT_PROJECT_PATH");
  const projectPath = custom || join(root, "data/fixture-repo");
  if (!custom && !existsSync(projectPath) && !run(process.execPath, ["--import", "tsx", "scripts/fixture-init.ts", projectPath]))
    throw new Error(L("示例项目初始化失败", "Failed to initialize the sample project"));
  const tls = await createTls(join(root, "data/tls"));
  console.log(L(`  ✅ TLS 证书：data/tls（CA 指纹 ${tls.caFingerprint.slice(0, 23)}…）`, `  ✅ TLS certificates: data/tls (CA fingerprint ${tls.caFingerprint.slice(0, 23)}…)`));
  const answers: InitAnswers = { root, locale, appId, appSecret, baseUrl, intentModel, intentKey, codingModel, codingKey, effort,
    tenantId, chatId, leader, members, projectId: custom ? (env.RT_PROJECT_ID || "project") : "feedbackdesk", projectPath, port: 9443 };
  const { configFile } = writeBridge(answers);
  console.log(L(`  ✅ ${configFile} 与 .env（权限 600）`, `  ✅ ${configFile} and .env (mode 600)`));

  step(6, L("在本机登记 team-runner", "Register team-runner on this machine"));
  const { runnerFile, nodeId } = pairLocalRunner(answers);
  console.log(L(`  ✅ ${runnerFile}（节点 ${nodeId.slice(0, 8)}…，由 Leader 登记，团队共享）`, `  ✅ ${runnerFile} (node ${nodeId.slice(0, 8)}…, registered by the Leader, shared with the team)`));

  step(7, L("镜像、诊断与启动", "Image, diagnostics and startup"));
  if (await yes(L("现在构建任务镜像 feishu-codex-task:runner-v1？（首次需要几分钟）", "Build the task image feishu-codex-task:runner-v1 now? (takes a few minutes the first time)"), "RT_BUILD_IMAGE", true))
    if (!run("docker", ["build", "-t", "feishu-codex-task:runner-v1", "-f", "docker/task.Dockerfile", "."])) throw new Error(L("镜像构建失败", "Image build failed"));
  const runnerEnv = { FEISHU_RUNNER_CONFIG: runnerFile };
  if (await yes(L("运行免费诊断（Docker 隔离、内存 OOM、项目）？", "Run the free diagnostics (Docker isolation, memory OOM, project)?"), "RT_DOCTOR", true)) run(process.execPath, ["dist/src/runner/cli.js", "doctor"], runnerEnv);
  if (await yes(L("运行真实模型诊断（会产生少量模型费用，节点接单前必须通过）？", "Run the live model diagnostics (small model cost; must pass before the node takes tasks)?"), "RT_DOCTOR_LIVE", false))
    run(process.execPath, ["dist/src/runner/cli.js", "doctor", "--live"], runnerEnv);
  const units = systemdUnits(root);
  if (process.getuid?.() === 0 && existsSync("/etc/systemd/system") && await yes(L("安装并启动 systemd 服务（roundtable、roundtable-runner）？", "Install and start the systemd services (roundtable, roundtable-runner)?"), "RT_SYSTEMD", false)) {
    for (const [name, content] of Object.entries(units)) writeFileSync(`/etc/systemd/system/${name}`, content, { mode: 0o644 });
    run("systemctl", ["daemon-reload"]);
    run("systemctl", ["enable", "--now", "roundtable.service", "roundtable-runner.service"]);
  } else {
    console.log(L(`\n启动方式（两个终端，或参考 deploy/ 中的 systemd 模板）：
  FEISHU_CODEX_CONFIG=${configFile} node dist/src/main.js
  FEISHU_RUNNER_CONFIG=${runnerFile} node dist/src/runner/cli.js run`, `\nTo start (two terminals, or see the systemd templates in deploy/):
  FEISHU_CODEX_CONFIG=${configFile} node dist/src/main.js
  FEISHU_RUNNER_CONFIG=${runnerFile} node dist/src/runner/cli.js run`));
  }
  console.log(L(`\n\x1b[1m完成！\x1b[0m 节点通过免费诊断和真实模型诊断后即可接单。
然后在测试群里试试：“@机器人 总结一下我们刚才说的，按讨论分个工”。`, `\n\x1b[1mDone!\x1b[0m The node takes tasks once it passes the free and live model diagnostics.
Then try this in the test group: "@ the bot summarize what we just said and split up the work".`));
}

main().catch(e => { console.error(`\n❌ ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; }).finally(() => rl.close());
