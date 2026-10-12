import test from "node:test";
import assert from "node:assert/strict";
import { Router, command } from "../src/router.js";
import { Jobs } from "../src/jobs.js";
import { SteeringError } from "../src/types.js";
import { Store } from "../src/store.js";
import { messageReferences } from "../src/references.js";
import { taskStatus } from "../src/status.js";
import { join } from "node:path";
import { testEnvironment, message, FakeRunner, messenger, until } from "./helpers.js";

test("开启线程接续后免@跟进，顶层聊天不触发，背景只使用一次，停止后需@重开", async () => {
  const env = testEnvironment(), runner = new FakeRunner(), router = new Router(env.config, env.store, runner);
  env.config.threadFollowups = "members";
  try {
    await router.handle(message({ messageId: "root" }));
    await router.handle(message({ rootId: "root", mentionedBot: false, text: "只要协作模式，不要研究方案" }));
    await router.handle(message({ rootId: "root", senderId: "bob", mentionedBot: false, text: "再解释分工" }));
    await router.handle(message({ mentionedBot: false, text: "只是群内闲聊" }));
    await router.handle(message({ rootId: "root", senderId: "mallory", mentionedBot: false, text: "越权背景" }));
    await router.handle(message({ rootId: "root", senderId: "bob", mentionedBot: false, text: "执行 改代码" }));
    assert.equal(env.store.jobs().length, 3);
    assert.equal(env.store.jobs()[1]!.prompt.split("只要协作模式").length - 1, 1);
    assert.ok(!env.store.jobs()[2]!.prompt.includes("越权背景"));
    await router.handle(message({ rootId: "root", text: "停止" }));
    await router.handle(message({ rootId: "root", mentionedBot: false, text: "继续" }));
    assert.equal(env.store.jobs().length, 3);
    await router.handle(message({ rootId: "root", text: "继续讨论" }));
    assert.equal(env.store.jobs().length, 4);
  } finally { env.close(); }
});

test("缺普通消息能力保持@only；发起人模式不自动触发队友背景", async () => {
  const env = testEnvironment(), router = new Router(env.config, env.store, new FakeRunner());
  env.config.threadFollowups = "initiator";
  try {
    await router.handle(message({ messageId: "root" }));
    await router.handle(message({ senderId: "bob", rootId: "root", mentionedBot: false, text: "整批失败" }));
    assert.equal(env.store.jobs().length, 1);
    await router.handle(message({ rootId: "root", mentionedBot: false, text: "采用补充" }));
    assert.match(env.store.jobs()[1]!.prompt, /整批失败/);
    env.config.receiveBackground = false;
    await router.handle(message({ rootId: "root", mentionedBot: false, text: "不会触发" }));
    assert.equal(env.store.jobs().length, 2);
  } finally { env.close(); }
});

test("自然派活仍校验发起人，疑问和引用内容不构成编码授权", async () => {
  const env = testEnvironment(), router = new Router(env.config, env.store, new FakeRunner());
  env.config.naturalExecution = true;
  try {
    assert.equal(command("帮我修复导入代码的冲突", true).type, "execute");
    assert.equal(command("请帮我实现 double 函数，不要修改 feedback.js 或原有测试", true).type, "execute");
    for (const text of ["帮我解释修改方案", "请帮我修改需求说明，指出可能的问题", "请帮我修改研究计划",
      "帮我修改权限是什么意思", "帮我实现吗？", "如果要修改怎么办", "不要修改代码"])
      assert.equal(command(text, true).type, "discuss", text);
    await router.handle(message({ messageId: "root" }));
    await router.handle(message({ rootId: "root", senderId: "bob", text: "帮我修复导入代码" }));
    assert.equal(env.store.jobs().length, 1);
    await router.handle(message({ rootId: "root", text: "请帮我实现导入函数的冲突检查" }));
    assert.equal(env.store.jobs()[1]!.mode, "execute");
  } finally { env.close(); }
});

test("显式引用同群线程只引入有界文字，未引用不串线，跨群引用不读取", async () => {
  const env = testEnvironment(), router = new Router(env.config, env.store, new FakeRunner());
  try {
    await router.handle(message({ messageId: "om_source", text: "引用校验标记：BASELINE_A17" }));
    const source = env.store.jobs()[0]!; source.response = "已选基线：BASELINE_A17"; source.endedAt = Date.now() - 1; env.store.saveJob(source);
    await router.handle(message({ messageId: "om_other", text: "独立任务" }));
    assert.ok(!env.store.jobs()[1]!.prompt.includes("BASELINE_A17"));
    await router.handle(message({ rootId: "om_other", text: "请引用消息 om_source，总结刚才基线" }));
    assert.match(env.store.jobs()[2]!.prompt, /BASELINE_A17/);
    assert.notEqual(env.store.jobs()[2]!.sessionId, source.sessionId);
    assert.match(env.store.jobs()[2]!.prompt, /不构成执行授权/);
    await router.handle(message({ rootId: "om_other", text: "引用消息 om_unknown：请总结" }));
    assert.match(env.store.jobs().at(-1)!.prompt, /未读取其内容/);
    env.config.allowedChats.push("other-chat");
    await router.handle(message({ chatId: "other-chat", messageId: "om_foreign", text: "FOREIGN_PRIVATE_CONTEXT" }));
    await router.handle(message({ rootId: "om_other", text: "引用消息 om_foreign：请总结" }));
    assert.ok(!env.store.jobs().at(-1)!.prompt.includes("FOREIGN_PRIVATE_CONTEXT"));
    assert.match(env.store.jobs().at(-1)!.prompt, /未读取其内容/);
    assert.deepEqual(messageReferences("https://evil.example/?messageId=om_source"), []);
    assert.deepEqual(messageReferences("https://applink.feishu.cn/client/message/open?messageId=om_source"), ["om_source"]);
  } finally { env.close(); }
});

test("普通跟进排队；明确插话命中当前回合，不新建模型任务且越权拒绝", async () => {
  const env = testEnvironment(), runner = new FakeRunner(); runner.gated = true;
  env.config.threadFollowups = "members";
  const router = new Router(env.config, env.store, runner), jobs = new Jobs(env.config, env.store, runner, messenger);
  try {
    await router.handle(message({ messageId: "root", text: "执行 实现" }));
    await jobs.tick();
    await router.handle(message({ rootId: "root", mentionedBot: false, text: "普通后续要求" }));
    assert.equal(env.store.jobs().length, 2);
    assert.equal(env.store.jobs()[1]!.status, "queued");
    assert.equal(runner.steers.length, 0);
    await router.handle(message({ rootId: "root", senderId: "bob", text: "插话：改需求" }));
    assert.equal(runner.steers.length, 0);
    await router.handle(message({ rootId: "root", text: "插话：采用最终需求" }));
    assert.equal(runner.steers.length, 1);
    assert.equal(runner.steers[0]!.jobId, env.store.jobs()[0]!.id);
    assert.equal(env.store.jobs().length, 2);
    assert.equal(env.store.query("SELECT action FROM audit WHERE action='steer_applied'").length, 1);
    runner.gates.splice(0).forEach(resolve => resolve());
    await until(() => env.store.jobs()[0]!.status === "completed");
  } finally { await jobs.close(); env.close(); }
});

test("插话确认丢失记待核对，不重复发送；重启未确认插话也不自动重发", async () => {
  const env = testEnvironment(), runner = new FakeRunner(), router = new Router(env.config, env.store, runner);
  runner.steer = async () => { throw new SteeringError("RPC timeout", "uncertain"); };
  try {
    await router.handle(message({ messageId: "root" }));
    const job = env.store.jobs()[0]!; job.status = "running"; env.store.saveJob(job);
    const input = message({ rootId: "root", text: "插话：修正" });
    await router.handle(input); await router.handle(input);
    assert.equal(env.store.query("SELECT action FROM audit WHERE action='steer_uncertain'").length, 1);
    env.store.audit("alice", job.sessionId, "steer_requested", { messageId: "lost-steer", jobId: job.id });
    const fresh = new Store(join(env.dir, "test.sqlite"));
    try {
      fresh.recover(); fresh.recover();
      assert.equal(fresh.query("SELECT action FROM audit WHERE action='steer_uncertain'").length, 2);
      assert.equal(fresh.jobs()[0]!.status, "needs_recovery");
    } finally { fresh.close(); }
  } finally { env.close(); }
});

test("进度由实际记录生成，不启动模型，不把完成、固定检查和送达混为一谈", async () => {
  const env = testEnvironment(), router = new Router(env.config, env.store, new FakeRunner());
  try {
    await router.handle(message({ messageId: "root" }));
    const job = env.store.jobs()[0]!; job.status = "running"; env.store.saveJob(job);
    env.store.event(job.id, { type: "activity", kind: "command", summary: "sleep 30" });
    await router.handle(message({ rootId: "root", senderId: "bob", text: "进度" }));
    assert.equal(env.store.jobs().length, 1);
    const text = env.store.outbox().at(-1)!.text!;
    assert.match(text, /sleep 30/);
    assert.match(text, /尚未记录固定检查通过/);
    assert.match(text, /已送达 0/);
    env.store.event(job.id, { type: "completed", status: "completed" });
    env.store.event(job.id, { type: "activity", kind: "checks", summary: "node --test" });
    assert.match(taskStatus(env.store, env.store.getSession(job.sessionId)!), /执行中，尚无最终退出码/);
  } finally { env.close(); }
});
