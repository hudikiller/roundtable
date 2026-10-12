import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { loadEnvironment } from "../src/config.js";
import { Store } from "../src/store.js";
import { RunnerRegistry } from "../src/runner/registry.js";
import { checked } from "../src/process.js";
import { setSecrets } from "../src/log.js";

const { config, secrets } = loadEnvironment(undefined, true);
setSecrets([secrets.appSecret]);
if (!config.runnerBridge?.feishuEnabled || config.runnerBridge.defaultNode ||
    Object.keys(config.runnerBridge.projectDefaults ?? {}).length)
  throw new Error("节点选择实测仅在专用唯一消费者且没有默认节点的配置运行");
const cli = process.env.LARK_CLI!, profile = process.env.LARK_PROFILE!;
if (!cli || !profile) throw new Error("先指定已授权 LARK_CLI 与 LARK_PROFILE");
const store = new Store(join(config.dataDir, "control.sqlite")), registry = new RunnerRegistry(config, store);
const auth = JSON.parse((await checked(cli, ["--profile", profile, "auth", "status", "--verify", "--json"])).toString());
if (!auth.verified || auth.appId !== secrets.appId || !auth.identities.user.available ||
    !config.allowedMembers.includes(auth.identities.user.openId)) throw new Error("应用/用户授权不匹配");
const actor = auth.identities.user.openId as string, node = registry.select(actor, "mac-mini", config.defaultRepo);
const mention = `<at user_id="${auth.identities.bot.openId}">Codex</at> `;
const marker = `NODE_CHOICE_${randomUUID().replaceAll("-", "")}`;
async function until(test: () => boolean, timeout = 240_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!test()) {
    if (Date.now() > end) throw new Error("原生节点选择联调超时");
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
async function send(text: string, root?: string): Promise<string> {
  const cmd = root ? ["im", "+messages-reply", "--message-id", root, "--reply-in-thread"]
    : ["im", "+messages-send", "--chat-id", config.allowedChats[0]!];
  const r = JSON.parse((await checked(cli, ["--profile", profile, ...cmd, "--as", "user",
    "--text", mention + text, "--idempotency-key", randomUUID()])).toString());
  assert.equal(r.ok, true); return r.data.message_id;
}
try {
  const root = await send(`请只读实际调用shell执行pwd和ls，再报告 ${marker}。不修改文件。`);
  const session = () => store.findSession(config.tenantId, config.allowedChats[0]!, [root]);
  await until(() => !!session()?.pendingNodeRequest);
  assert.equal(store.jobs().some(j => j.messageId === root), false);
  const sessionId = session()!.id;
  await until(() => store.outbox().some(o => o.sessionId === sessionId && o.status === "sent"));
  const choice = await send("在 Mac mini 上", root);
  const job = () => store.jobs().find(j => j.messageId === root);
  await until(() => !!job() && !["queued", "running"].includes(job()!.status));
  assert.equal(job()!.status, "completed", job()!.error);
  await until(() => store.outbox().some(o => o.jobId === job()!.id && o.purpose === "result" && o.status === "sent"));
  assert.equal(job()!.senderId, actor); assert.equal(job()!.mode, "discuss");
  assert.equal(store.jobs().some(j => j.messageId === choice), false);
  assert.equal(session()!.runnerId, node.id); assert.equal(session()!.pendingNodeRequest, undefined);
  assert.ok(job()!.response?.includes(marker));
  assert.ok(store.events(job()!.id).some(e => e.type === "command" && e.exitCode === 0));
  const report = { at: new Date().toISOString(), kind: "real-feishu-real-model-one-authorized-user",
    pendingWithoutModel: true, resumedOriginalRequest: true, originalAuthorPreserved: true,
    nodeChosenInSameNativeThread: true, realTools: true, replyDelivered: true, twoHumanAcceptance: "pending" };
  await mkdir(join(config.dataDir, "verification"), { recursive: true, mode: 0o700 });
  await writeFile(join(config.dataDir, "verification/runner-node-choice.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
} finally { store.close(); }
