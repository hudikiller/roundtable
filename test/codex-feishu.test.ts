import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CodexHarness } from "../src/codex.js";
import { normalizeMessage, Feishu, DeliveryError, toCard } from "../src/feishu.js";
import { configSchema } from "../src/config.js";
import { redact, setSecrets } from "../src/log.js";
import type { NormalizedMessage } from "@larksuite/channel";
import type { RunEvent, Session, Job } from "../src/types.js";
import { SteeringError } from "../src/types.js";
import { until, testEnvironment } from "./helpers.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

test("固定协议握手、拒绝审批、最终项校正，不转发原始推理", async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fake-codex.mjs", import.meta.url))], { stdio: "pipe" });
  const harness = new CodexHarness(child, 2000), events: RunEvent[] = [];
  const session = { id: "s", initialized: false } as Session;
  const job = { mode: "discuss", prompt: "测试协议" } as Job;
  try {
    const result = await harness.run(session, job, "protocol-test", e => events.push(e));
    assert.equal(result.status, "completed");
    assert.equal(result.text, "完整最终回答");
    assert.equal(result.events.filter(e => e.type === "command").length, 1, "完成通知中的同一item不能重复计算");
    assert.ok(events.some(e => e.type === "approvalDenied"));
    assert.ok(!JSON.stringify(events).includes("NEVER_SEND_REASONING"));
    assert.deepEqual(events.find(e => e.type === "plan"), { type: "plan", explanation: null,
      steps: [{ step: "读取导入逻辑", status: "completed" }, { step: "补测试", status: "inProgress" }] }, "Codex 计划转为清单事件");
    assert.deepEqual(events.filter(e => e.type === "plan").at(-1), { type: "plan", explanation: null,
      steps: [{ step: "读取导入逻辑", status: "completed" }, { step: "补测试", status: "completed" }] }, "update_checklist 工具调用转为清单事件");
  } finally { harness.close(); child.kill(); }
});

for (const mode of ["accept", "reject", "timeout"]) test(`固定协议插话 ${mode}：命中活动回合，区分拒绝与确认不确定`, async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./steer-codex.mjs", import.meta.url)), mode], { stdio: "pipe" });
  const harness = new CodexHarness(child, 500), events: RunEvent[] = [];
  const running = harness.run({ initialized: false } as Session, { mode: "discuss", prompt: "等待插话" } as Job,
    "protocol-test", event => events.push(event));
  try {
    await until(() => events.some(event => event.type === "activity"));
    assert.ok(!events.some(event => event.type === "command"), "工具刚开始时不能假造退出码");
    if (mode === "accept") {
      assert.deepEqual(await harness.steer("NEW_SCOPE_MARKER"), { turnId: "active-turn" });
      assert.match((await running).text, /NEW_SCOPE_MARKER/);
      await assert.rejects(harness.steer("已结束"), e => e instanceof SteeringError && e.disposition === "rejected");
    } else {
      await assert.rejects(harness.steer("NEW_SCOPE_MARKER"),
        e => e instanceof SteeringError && e.disposition === (mode === "reject" ? "rejected" : "uncertain"));
      await harness.interrupt();
      assert.equal((await running).status, "interrupted");
    }
  } finally { harness.close(); child.kill(); await running.catch(() => {}); }
});

test("飞书事件从原始 tenant_key 和原生 mention 归一化；未知sender拒绝", () => {
  const input: NormalizedMessage = { messageId: "om_1", chatId: "oc_1", chatType: "group",
    senderId: "ou_1", senderType: "user", senderIsBot: false, content: "问题",
    mentionedBot: true, mentions: [{ key: "@_user_1", openId: "bot" }], mentionAll: false,
    resources: [], rawContentType: "text", createTime: 1_790_000_000_000,
    rootId: "om_root", threadId: "omt_thread", replyToMessageId: "om_parent",
    raw: { sender: { tenant_key: "tenant-real" } } };
  const message = normalizeMessage(input)!;
  assert.equal(message.tenantId, "tenant-real"); assert.equal(message.mentionedBot, true);
  assert.equal(message.rootId, "om_root"); assert.equal(message.threadId, "omt_thread");
  assert.equal(normalizeMessage({ ...input, raw: undefined }), undefined);
  assert.equal(normalizeMessage({ ...input, senderType: undefined }), undefined);
  const rich = normalizeMessage({ ...input, rawContentType: "post", content: "@机器人 执行 带图需求",
    mentions: [{ key: "@_user_1", name: "机器人", isBot: true, openId: "bot" }],
    resources: [{ type: "image", fileKey: "img_test" }] })!;
  assert.equal(rich.text, "执行 带图需求"); assert.equal(rich.resources?.[0]?.fileKey, "img_test");
});

test("日志和输出清洗实际配置密钥与Bearer", () => {
  setSecrets(["test-private-key"]);
  assert.equal(redact("key test-private-key Authorization: Bearer abcdef"), "key [REDACTED] Authorization: Bearer [REDACTED]");
  setSecrets([]);
});

test("回复原消息撤回时明确失败，绝不退回群顶层；请求带稳定UUID", async () => {
  const config = configSchema.parse({ tenantId: "t", allowedChats: ["oc_test"], allowedMembers: ["alice"], replyMode: "chat",
    provider: { baseUrl: "https://api.example.org/v1", model: "test" } });
  const feishu = new Feishu(config, { appId: "fake", appSecret: "fake", modelKey: "fake" });
  const received: { data: unknown; path: { message_id: string } }[] = [];
  feishu.channel.rawClient.im.message.reply = (async (req: unknown) => {
    received.push(req as typeof received[number]); return { code: 230001, msg: "revoked" };
  }) as typeof feishu.channel.rawClient.im.message.reply;
  const entry = { id: "stable-uuid", target: { tenantId: "t", chatId: "oc_test", messageId: "om_root" },
    text: "完成", status: "pending" as const, attempts: 0, nextAttemptAt: 0 };
  await assert.rejects(feishu.reply(entry), (e: unknown) => e instanceof DeliveryError && e.disposition === "failed");
  assert.equal(received.length, 2, "卡片被拒后只以纯文本补试一次，仍回复原消息");
  assert.ok(received.every(r => r.path.message_id === "om_root"));
  assert.deepEqual(received[0]!.data, { msg_type: "interactive", content: toCard("完成"), reply_in_thread: false, uuid: "stable-uuid" });
  assert.deepEqual(received[1]!.data, { msg_type: "text", content: JSON.stringify({ text: "完成" }), reply_in_thread: false, uuid: "stable-uuid-t" });
});

test("话题为默认显示方式，显式普通引用模式同样保留文字文件目标和稳定UUID", async () => {
  const env = testEnvironment(), feishu = new Feishu(env.config, { appId: "fake", appSecret: "fake", modelKey: "fake" });
  const received: { data: { reply_in_thread: boolean; uuid: string; msg_type: string }; path: { message_id: string } }[] = [];
  feishu.channel.rawClient.im.file.create = (async () => ({ file_key: "file_test" })) as typeof feishu.channel.rawClient.im.file.create;
  feishu.channel.rawClient.im.message.reply = (async (request: unknown) => {
    received.push(request as typeof received[number]); return { code: 0, data: { message_id: `sent-${received.length}` } };
  }) as typeof feishu.channel.rawClient.im.message.reply;
  const entry = { id: "same-delivery-uuid", target: { tenantId: "tenant", chatId: "chat", messageId: "om_task_root" },
    text: "回答", status: "pending" as const, attempts: 0, nextAttemptAt: 0 };
  try {
    assert.equal(env.config.replyMode, "thread");
    env.config.replyMode = "chat";
    await feishu.reply(entry);
    const path = join(env.dir, "answer.md"); writeFileSync(path, "真实附件");
    await feishu.reply({ ...entry, filePath: path, fileName: "answer.md" });
    assert.deepEqual(received.slice(0, 2).map(request => request.data.reply_in_thread), [false, false]);
    assert.deepEqual(received.map(request => request.path.message_id), ["om_task_root", "om_task_root"]);
    assert.equal(received[1]!.data.msg_type, "file");
    env.config.replyMode = "thread"; await feishu.reply(entry);
    assert.equal(received[2]!.data.reply_in_thread, true);
    assert.ok(received.every(request => request.data.uuid === entry.id));
  } finally { env.close(); }
});
