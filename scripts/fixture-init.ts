import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { checked } from "../src/process.js";

const path = resolve(process.argv[2] || "data/fixture-repo");
if (existsSync(path)) throw new Error("验收仓库已存在，不覆盖现有工作");
await mkdir(path, { recursive: true, mode: 0o700 });
await cp(resolve("fixtures/feedbackdesk"), path, { recursive: true });
await checked("git", ["init", "-b", "main", path]);
await checked("git", ["-C", path, "config", "user.name", "Feishu Codex Fixture"]);
await checked("git", ["-C", path, "config", "user.email", "fixture@localhost"]);
await checked("git", ["-C", path, "add", "."]);
await checked("git", ["-C", path, "commit", "-m", "Initialize independent acceptance fixture"]);
console.log(`独立验收仓库已建立：${path}`);
