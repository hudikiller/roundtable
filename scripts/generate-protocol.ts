import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

const root = resolve("src/protocol");
execFileSync(resolve("node_modules/.bin/codex"), ["app-server", "generate-ts", "--out", root], { stdio: "inherit" });
function extensions(path: string): void {
  for (const item of readdirSync(path, { withFileTypes: true })) {
    const name = join(path, item.name);
    if (item.isDirectory()) extensions(name);
    else if (name.endsWith(".ts"))
      writeFileSync(name, readFileSync(name, "utf8").replace(/(from\s+["'])(\.[^"']+)(["'])/g,
        (_, a: string, b: string, c: string) => {
          const target = join(dirname(name), b);
          const module = existsSync(target) && statSync(target).isDirectory() ? `${b}/index.js` : b;
          return `${a}${module.endsWith(".js") ? module : module + ".js"}${c}`;
        }));
  }
}
extensions(root);
