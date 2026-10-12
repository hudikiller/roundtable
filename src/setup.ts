import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { configSchema, loadEnvironment } from "./config.js";
import { errorText } from "./log.js";

async function setup(): Promise<void> {
  const path = resolve(process.env.FEISHU_CODEX_CONFIG || "config.json");
  if (process.argv.includes("--check") || process.argv.includes("--non-interactive")) {
    loadEnvironment(path);
    chmodSync(path, 0o600);
    if (existsSync(resolve(".env"))) chmodSync(resolve(".env"), 0o600);
    console.log("配置验证通过。请检查飞书事件订阅、群/成员授权，接着运行 npm run doctor。");
    return;
  }
  const cli = createInterface({ input: stdin, output: stdout });
  const previous = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> : {};
  const ask = async (label: string, initial = "") => (await cli.question(`${label}${initial ? ` [${initial}]` : ""}: `)).trim() || initial;
  try {
    console.log("设置独立机器人。密钥填写本机 .env，本向导不打印也不索取聊天中的密钥。");
    const tenantId = await ask("飞书 tenant_key", String(previous.tenantId ?? ""));
    const allowedChats = (await ask("允许群 ID（逗号分隔）", (previous.allowedChats as string[] | undefined)?.join(",") ?? "")).split(",").map(v => v.trim()).filter(Boolean);
    const allowedMembers = (await ask("允许成员 open_id（逗号分隔）", (previous.allowedMembers as string[] | undefined)?.join(",") ?? "")).split(",").map(v => v.trim()).filter(Boolean);
    const leaders = (await ask("Leader open_id（逗号分隔，可空）", (previous.leaders as string[] | undefined)?.join(",") ?? "")).split(",").map(v => v.trim()).filter(Boolean);
    const oldProvider = previous.provider as { baseUrl?: string; model?: string } | undefined;
    const baseUrl = await ask("兼容服务 HTTPS base URL", oldProvider?.baseUrl ?? "");
    const model = await ask("模型 ID", oldProvider?.model ?? "");
    const background = await ask("已获普通群消息接收权限？yes/no", previous.receiveBackground ? "yes" : "no");
    const repositoryPath = await ask("允许业务仓库绝对路径（空则只讨论）");
    const raw = { ...previous, tenantId, allowedChats, allowedMembers, leaders,
      provider: { baseUrl, model }, receiveBackground: background === "yes",
      repositories: repositoryPath ? [{ id: "default", path: repositoryPath, ref: "HEAD", checks: [] }] : previous.repositories ?? [],
      defaultRepo: repositoryPath ? "default" : previous.defaultRepo };
    const config = configSchema.parse(raw);
    writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    if (!existsSync(resolve(".env"))) {
      writeFileSync(resolve(".env"), readFileSync(resolve(".env.example")), { mode: 0o600 });
      console.log("已建立 .env 模板，请在本机填写应用 ID、应用密钥、模型 API Key。");
    }
    console.log("配置已保存。setup 不替代管理员开通事件和权限，也不会自动切换旧消费者。");
  } finally { cli.close(); }
}
setup().catch(e => { console.error(errorText(e)); process.exitCode = 1; });
