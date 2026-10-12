import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

await mkdir("/tmp/home", { recursive: true });
const line = JSON.stringify;
// Optional metadata (context window, reasoning levels, tools) for models Codex does not know built in.
const catalog = existsSync("/app/models/model_catalog.json") ? 'model_catalog_json = "/app/models/model_catalog.json"\n' : "";
await writeFile("/codex/config.toml", `model_provider = "team_api"
model = ${line(process.env.CODEX_MODEL)}
${catalog}
cli_auth_credentials_store = "file"
[model_providers.team_api]
name = "Team Responses API"
base_url = ${line(process.env.CODEX_BASE_URL)}
env_key = "CODEX_MODEL_API_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 1
stream_max_retries = 1
stream_idle_timeout_ms = 120000
`, { mode: 0o600 });
const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
  stdio: "inherit",
  env: process.env,
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.on("error", () => { console.error("无法启动 Codex app-server"); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
