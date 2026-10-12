import { join } from "node:path";
import { readFileSync } from "node:fs";
import { loadEnvironment } from "../config.js";
import { Store } from "../store.js";
import { RunnerRegistry } from "./registry.js";
import { errorText, setSecrets } from "../log.js";
import { L } from "../i18n.js";

function main(): void {
  const { config, secrets } = loadEnvironment(undefined, true);
  setSecrets([secrets.appSecret]);
  if (!config.runnerBridge) throw new Error(L("需要独立Runner Bridge配置", "A separate Runner Bridge config is required"));
  const store = new Store(join(config.dataDir, "control.sqlite")), registry = new RunnerRegistry(config, store);
  const [op, ...args] = process.argv.slice(2);
  try {
    if (op === "pair") {
      const [owner, name] = args;
      if (!owner || !name) throw new Error(L("runner:admin -- pair <获准ownerId> <节点名>；代码只在可信终端/SSH管道使用", "runner:admin -- pair <approved ownerId> <node name>; only use the code over a trusted terminal or SSH pipe"));
      console.log(JSON.stringify({ code: registry.pair(owner, name), expiresInSeconds: 600 }));
    } else if (op === "nodes") console.log(JSON.stringify(registry.nodes().map(n => ({
      id: n.id, name: n.name, owner: n.ownerId, ready: n.capabilities.ready, online: Date.now() - n.lastSeen < 30_000,
      projects: n.capabilities.projects, revoked: n.revoked,
    })), null, 2));
    else if (op === "grant" || op === "ungrant") {
      const [node, actor, project, owner] = args;
      if (!node || !actor || !project || !owner) throw new Error("grant <nodeId> <actorId> <projectAlias> <ownerId>");
      registry.grant(node, actor, project, owner, op === "ungrant"); console.log(L("已记录节点/项目授权", "Node/project grant recorded"));
    } else if (op === "revoke") {
      if (!args[0] || !args[1]) throw new Error("revoke <nodeId> <ownerId>");
      registry.revoke(args[0], args[1]); console.log(L("已撤销节点凭据", "Node credentials revoked"));
    } else if (op === "migrate-legacy") {
      const n = registry.nodes().find(n => n.name === "team-runner");
      if (!n) throw new Error(L("先登记team-runner", "Register team-runner first")); registry.migrateLegacy(n); console.log(L("已固定旧会话在team-runner，原卷与thread ID保留", "Pinned legacy sessions to team-runner; original volumes and thread IDs kept"));
    } else if (op === "status") console.log(JSON.stringify(registry.runs().map(r => ({
      runId: r.id, generation: r.generation, node: r.nodeId, state: r.state, jobId: r.jobId, lastSeq: r.lastSeq, stopConfirmed: r.stopConfirmed,
    })), null, 2));
    else throw new Error(L("支持 pair / nodes / grant / ungrant / revoke / migrate-legacy / status", "Supported: pair / nodes / grant / ungrant / revoke / migrate-legacy / status"));
  } finally { store.close(); }
}
try { main(); } catch (e) { console.error(errorText(e)); process.exitCode = 1; }
