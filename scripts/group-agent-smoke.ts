// Real team-runner check of the group session: the answer must use the incremental feed and
// find an older fact only present in .group/history.md. Uses an isolated synthetic chat ID, so
// replies target a nonexistent message and are never shown in a real group.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { loadEnvironment } from "../src/config.js";
import { Store } from "../src/store.js";
import { RunnerRegistry } from "../src/runner/registry.js";
import { GroupAgent, groupOutputGuide, groupOutputSchema } from "../src/group.js";
import { setSecrets } from "../src/log.js";
import type { Job, Session } from "../src/types.js";

const { config, secrets } = loadEnvironment(undefined, true);
setSecrets([secrets.appSecret]);
if (!config.runnerBridge?.groupAgent?.enabled) throw new Error("staging 未启用 groupAgent");
const store = new Store(join(config.dataDir, "control.sqlite")), registry = new RunnerRegistry(config, store);
const group = new GroupAgent(config, store, registry);
const chat = `oc_group_smoke_${Date.now()}`, tenant = config.tenantId, actor = config.leaders[0]!;
const secret = `暗号-${randomUUID().slice(0, 8)}`, fresh = `新进展-${randomUUID().slice(0, 8)}`;
const say = (text: string, at: number) => store.insertMessage({ tenantId: tenant, chatId: chat, messageId: `om_smoke_${randomUUID()}`,
  senderId: actor, senderName: "成员A", senderType: "user", text, mentionedBot: false, mentions: [], createdAt: at });
const t0 = Date.now() - 3_600_000;
say(`上周定的发布暗号是 ${secret}，大家记一下`, t0);
for (let i = 0; i < 5; i++) say(`闲聊 ${i}`, t0 + 1000 + i);
const g = group.ensure(tenant, chat, actor);
const before = await group.feed(tenant, chat);
group.advance(tenant, chat, before.cursor, Date.now()); // the secret is now only in history.md
say(`今天的${fresh}：导入改为整批失败`, Date.now());
const feed = await group.feed(tenant, chat);
if (feed.text.includes(secret)) throw new Error("暗号不应出现在增量补给中");
const topic: Session = { id: randomUUID(), tenantId: tenant, chatId: chat, rootMessageId: `om_smoke_ask_${randomUUID()}`, initiatorId: actor,
  workspaceVolume: `fc-work-smoke-${randomUUID()}`, stateVolume: `fc-state-smoke-${randomUUID()}`, initialized: false, review: "open", createdAt: Date.now() };
store.saveSession(topic); store.addAliases(topic, [topic.rootMessageId]);
const job: Job = { id: randomUUID(), sessionId: g.id, messageId: topic.rootMessageId, senderId: actor, mode: "discuss", status: "queued",
  createdAt: Date.now(), contextLoaded: true, replyTo: topic.rootMessageId, topicSessionId: topic.id, feedCursor: feed.cursor,
  outputSchema: groupOutputSchema, webSearch: true,
  prompt: `你是本飞书群的主群 Agent（群会话）。本回合只读。完整原始记录在 /workspace/.group/history.md，需要更早内容时用 shell 检索。可以联网搜索并注明来源。
群成员（名字=open_id）：${config.allowedMembers.map((id, i) => `成员${i + 1}=${id}`).join("，")}
${groupOutputGuide}
<group-feed>\n${feed.text}\n</group-feed>\n当前提问：今天有什么新进展？上周定的发布暗号是什么（给出原文暗号）？请把“实现导入整批失败”分给成员1、“补充测试”分给成员2，并记住“导入规则为整批失败”。最后联网查一下 Node.js 当前最新的 LTS 主版本号并注明来源。` };
store.insertJob(job);
const started = Date.now();
let current = store.getJob(job.id)!;
while (["queued", "running"].includes(current.status) && Date.now() - started < 600_000) {
  await new Promise(r => setTimeout(r, 1000)); current = store.getJob(job.id)!;
}
for (const entry of store.outbox().filter(e => e.target.chatId === chat && ["pending", "failed"].includes(e.status))) {
  entry.status = "failed"; entry.error = "群会话技术验证回复，不投递"; store.saveOutbox(entry);
}
const commands = store.events(job.id).filter(e => e.type === "command").map(e => e.type === "command" ? e.command : "");
const state = group.state(tenant, chat);
const result = { kind: "real-team-runner-real-model-synthetic-chat-not-feishu", status: current.status, ms: Date.now() - started,
  renderedNotJson: !(current.response ?? "").trim().startsWith("{"), assignments: state?.assignments?.map(a => ({ title: a.title, owner: a.owner.slice(0, 10) })),
  memory: state?.memory?.map(m => m.text), mentionsOwners: /<at user_id="ou_/.test(current.response ?? ""),
  usedFeed: current.response?.includes(fresh) ?? false, foundSecretInHistory: current.response?.includes(secret) ?? false,
  readHistoryFile: commands.some(c => c.includes("history.md")), commands: commands.slice(0, 6), answer: current.response?.slice(0, 900), error: current.error };
console.log(JSON.stringify(result, null, 2));
store.close();
process.exit(result.status === "completed" && result.usedFeed && result.foundSecretInHistory && result.renderedNotJson && !!result.assignments?.length ? 0 : 1);
