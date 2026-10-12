import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Router } from "../src/router.js";
import { Jobs } from "../src/jobs.js";
import { DeliveryError } from "../src/feishu.js";
import { join } from "node:path";
import { readFile, stat, writeFile } from "node:fs/promises";
import { testEnvironment, message, FakeRunner, messenger, until } from "./helpers.js";

test("模型完成后发送失败只补发，绝不重跑模型", async () => {
  const env = testEnvironment(), runner = new FakeRunner(), router = new Router(env.config, env.store, runner);
  let fail = true;
  const jobs = new Jobs(env.config, env.store, runner, { async reply(e) {
    if (fail) throw new DeliveryError("rate limit", "retry");
    return messenger.reply(e);
  } });
  try {
    await router.handle(message());
    await jobs.tick();
    await until(() => env.store.jobs()[0]?.status === "completed");
    assert.equal(runner.calls.length, 1);
    assert.ok(env.store.outbox().some(e => e.status === "pending" && e.attempts > 0));
    fail = false;
    for (const entry of env.store.outbox("pending")) { entry.nextAttemptAt = 0; env.store.saveOutbox(entry); }
    for (let i = 0; i < 8; i++) await jobs.tick();
    assert.ok(env.store.outbox().every(e => e.status === "sent"));
    assert.equal(runner.calls.length, 1);
  } finally { await jobs.close(); env.close(); }
});

test("发送不确定不自动重试；已发送消息产生别名", async () => {
  const env = testEnvironment(), runner = new FakeRunner(), router = new Router(env.config, env.store, runner);
  const jobs = new Jobs(env.config, env.store, runner, { async reply() { throw new DeliveryError("timeout", "uncertain"); } });
  try {
    await router.handle(message());
    await jobs.deliver();
    assert.equal(env.store.outbox("uncertain").length, 1);
    await jobs.deliver();
    assert.equal(env.store.outbox("uncertain")[0]!.attempts, 1);
  } finally { await jobs.close(); env.close(); }
});

test("重启将执行中任务改待恢复，保存会话，阻塞同线程排队任务", async () => {
  const env = testEnvironment(), runner = new FakeRunner(), router = new Router(env.config, env.store, runner);
  try {
    await router.handle(message({ messageId: "root" }));
    await router.handle(message({ rootId: "root" }));
    const job = env.store.jobs()[0]!; job.status = "running"; env.store.saveJob(job);
    const session = env.store.getSession(job.sessionId)!;
    session.codexThreadId = "real-protocol-thread-id"; env.store.saveSession(session);
    const out = env.store.outbox()[0]!; out.status = "sending"; env.store.saveOutbox(out);
    const fresh = new Store(join(env.dir, "test.sqlite"));
    try {
      fresh.recover();
      assert.equal(fresh.jobs("needs_recovery").length, 1);
      assert.equal(fresh.outbox("uncertain").length, 1);
      assert.equal(fresh.queued(new Set()), undefined);
      assert.equal(fresh.getSession(session.id)!.codexThreadId, "real-protocol-thread-id");
    } finally { fresh.close(); }
    await router.handle(message({ rootId: "root", text: `恢复 ${job.id}` }));
    assert.equal(env.store.jobs("needs_recovery").length, 0);
    assert.equal(env.store.queued(new Set())!.id, job.id);
  } finally { env.close(); }
});

test("同线程串行，其他线程并行；最多全局并发2", async () => {
  const env = testEnvironment(), runner = new FakeRunner(); runner.gated = true;
  const router = new Router(env.config, env.store, runner), jobs = new Jobs(env.config, env.store, runner, messenger);
  try {
    await router.handle(message({ messageId: "root-a" }));
    await router.handle(message({ rootId: "root-a" }));
    await router.handle(message({ messageId: "root-b" }));
    await router.handle(message({ messageId: "root-c" }));
    await jobs.tick();
    assert.equal(runner.calls.length, 2);
    assert.notEqual(runner.calls[0]!.job.sessionId, runner.calls[1]!.job.sessionId);
    assert.equal(env.store.jobs("queued").length, 2);
    runner.gates.splice(0).forEach(resolve => resolve());
    await until(() => env.store.jobs("completed").length === 2);
    await jobs.tick();
    assert.equal(runner.calls.length, 4);
    runner.gates.splice(0).forEach(resolve => resolve());
    await until(() => env.store.jobs("completed").length === 4);
  } finally { await jobs.close(); env.close(); }
});

test("模型失败不被记录为完成，也不能人工接受", async () => {
  const env = testEnvironment(), runner = new FakeRunner();
  runner.result = { status: "failed", text: "", error: "错误 API Key", events: [] };
  const router = new Router(env.config, env.store, runner), jobs = new Jobs(env.config, env.store, runner, messenger);
  try {
    await router.handle(message({ messageId: "root", text: "执行 导入" }));
    await jobs.tick();
    await until(() => env.store.jobs()[0]!.status === "failed");
    await router.handle(message({ rootId: "root", text: "接受" }));
    assert.equal(env.store.allSessions()[0]!.review, "open");
    assert.ok(env.store.outbox().some(e => e.text?.includes("错误 API Key")));
  } finally { await jobs.close(); env.close(); }
});

test("模型回答保留，但固定检查非零会失败，不能接受", async () => {
  const env = testEnvironment(), runner = new FakeRunner();
  runner.result = { status: "completed", text: "已修改导入", events: [
    { type: "command", id: "check-fixture-0", command: "node --test", exitCode: 1, status: "failed", output: "assertion failed" },
  ] };
  const router = new Router(env.config, env.store, runner), jobs = new Jobs(env.config, env.store, runner, messenger);
  try {
    await router.handle(message({ messageId: "root", text: "执行 导入" }));
    await jobs.tick();
    await until(() => env.store.jobs()[0]!.status === "failed");
    const job = env.store.jobs()[0]!;
    assert.equal(job.modelStatus, "completed");
    assert.equal(job.checksStatus, "failed");
    assert.equal(job.response, "已修改导入");
    assert.match(job.testSummary!, /exit=1/);
    await router.handle(message({ rootId: "root", text: "接受" }));
    assert.equal(env.store.allSessions()[0]!.review, "open");
  } finally { await jobs.close(); env.close(); }
});

test("容器清理未确认时保留回答并阻塞后续同线程工作", async () => {
  const env = testEnvironment(), runner = new FakeRunner();
  runner.result = { status: "failed", text: "已有部分成果", events: [], cleanupFailed: true, error: "容器未终止" };
  const router = new Router(env.config, env.store, runner), jobs = new Jobs(env.config, env.store, runner, messenger);
  try {
    await router.handle(message({ messageId: "root" }));
    await router.handle(message({ rootId: "root" }));
    await jobs.tick();
    await until(() => env.store.jobs("needs_recovery").length === 1);
    assert.equal(env.store.jobs("needs_recovery")[0]!.response, "已有部分成果");
    assert.equal(env.store.queued(new Set()), undefined);
  } finally { await jobs.close(); env.close(); }
});

test("简短讨论只有一次确认和最终回答，检查状态仍单独保存", async () => {
  const env = testEnvironment(), runner = new FakeRunner();
  runner.result.text = "先验证冲突，再一次性写入。";
  const router = new Router(env.config, env.store, runner), jobs = new Jobs(env.config, env.store, runner, messenger);
  try {
    await router.handle(message());
    await jobs.tick();
    await until(() => env.store.jobs()[0]!.status === "completed");
    const outbox = env.store.outbox(), result = outbox.find(e => e.purpose === "result")!;
    assert.equal(outbox.length, 2);
    assert.equal(outbox.filter(e => e.purpose === "acknowledgement").length, 1);
    assert.equal(result.text, runner.result.text);
    assert.equal(env.store.jobs()[0]!.checksStatus, "not_run");
    assert.equal(env.store.jobs()[0]!.artifactPath, undefined);
  } finally { await jobs.close(); env.close(); }
});

test("讨论请求 Markdown：完整私有附件投递失败只重发附件，不重新调用模型", async () => {
  const env = testEnvironment(), runner = new FakeRunner();
  runner.result.text = "# 协作说明\n\n同线程补充后由发起人明确授权。\n";
  let rejectAttachment = true;
  const router = new Router(env.config, env.store, runner), jobs = new Jobs(env.config, env.store, runner, {
    async reply(entry) {
      if (entry.filePath && rejectAttachment) throw new DeliveryError("rate limit", "retry");
      return messenger.reply(entry);
    },
  });
  try {
    await router.handle(message({ messageId: "root", text: "请导出 Markdown 文件" }));
    await jobs.tick();
    await until(() => env.store.jobs()[0]!.status === "completed");
    const job = env.store.jobs()[0]!, file = env.store.outbox().find(e => e.purpose === "artifact")!;
    assert.equal(job.mode, "discuss");
    assert.ok(job.artifactPath?.endsWith(".md"));
    assert.equal(await readFile(job.artifactPath!, "utf8"), runner.result.text);
    assert.equal((await stat(job.artifactPath!)).mode & 0o777, 0o600);
    assert.equal(file.target.messageId, "root");
    assert.ok(file.fileName?.endsWith(".md"));
    for (let i = 0; i < 3; i++) await jobs.deliver();
    assert.ok(env.store.outbox().some(e => e.purpose === "artifact" && e.status === "pending" && e.attempts === 1));
    rejectAttachment = false;
    const pending = env.store.outbox().find(e => e.purpose === "artifact")!;
    pending.nextAttemptAt = 0; env.store.saveOutbox(pending);
    await jobs.deliver();
    assert.equal(env.store.outbox().find(e => e.purpose === "artifact")!.status, "sent");
    assert.equal(runner.calls.length, 1);
  } finally { await jobs.close(); env.close(); }
});

test("长讨论完整导出为一个附件，聊天中不切成多条长消息", async () => {
  const env = testEnvironment(), runner = new FakeRunner();
  runner.result.text = "# 长报告\n\n" + "基于已有信息解释需求。\n".repeat(1000);
  const router = new Router(env.config, env.store, runner), jobs = new Jobs(env.config, env.store, runner, messenger);
  try {
    await router.handle(message());
    await jobs.tick();
    await until(() => env.store.jobs()[0]!.status === "completed");
    const job = env.store.jobs()[0]!;
    assert.equal(await readFile(job.artifactPath!, "utf8"), runner.result.text);
    assert.equal(env.store.outbox().filter(e => e.purpose === "result").length, 1);
    assert.equal(env.store.outbox().filter(e => e.purpose === "artifact").length, 1);
    assert.ok(env.store.outbox().find(e => e.purpose === "result")!.text!.length < 1000);
    assert.equal(job.response, runner.result.text);
  } finally { await jobs.close(); env.close(); }
});

test("文档导出失败不发送不存在的附件，不宣称已发送，保留完整回答", async () => {
  const env = testEnvironment(), runner = new FakeRunner();
  runner.result.text = "完整讨论结果。".repeat(1000);
  await writeFile(join(env.dir, "artifacts"), "阻止创建目录");
  const router = new Router(env.config, env.store, runner), jobs = new Jobs(env.config, env.store, runner, messenger);
  try {
    await router.handle(message({ text: "请导出 Markdown 文件" }));
    await jobs.tick();
    await until(() => env.store.jobs()[0]!.status === "completed");
    const job = env.store.jobs()[0]!;
    assert.equal(job.response, runner.result.text);
    assert.equal(job.artifactPath, undefined);
    assert.ok(env.store.outbox().every(e => !e.filePath));
    const results = env.store.outbox().filter(e => e.purpose === "result");
    assert.equal(results.length, 1);
    assert.match(results[0]!.text!, /成果导出失败/);
    assert.ok(!results[0]!.text!.includes("已发送"));
  } finally { await jobs.close(); env.close(); }
});

test("成果导出期间收到停止，迟到的模型结果不能覆盖停止状态或继续投递", async () => {
  const env = testEnvironment(), runner = new FakeRunner();
  let exporting = false, release: () => void = () => {};
  runner.artifacts = async () => {
    exporting = true;
    await new Promise<void>(resolve => { release = resolve; });
    return undefined;
  };
  const router = new Router(env.config, env.store, runner), jobs = new Jobs(env.config, env.store, runner, messenger);
  try {
    await router.handle(message({ messageId: "root", text: "执行 实现导入" }));
    await jobs.tick();
    await until(() => exporting);
    await router.handle(message({ rootId: "root", text: "停止" }));
    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(env.store.jobs()[0]!.status, "stopped");
    assert.ok(!env.store.outbox().some(e => e.purpose === "result" || e.purpose === "artifact"));
    assert.ok(env.store.outbox().some(e => e.text?.startsWith("已停止本线程")));
  } finally { release(); await jobs.close(); env.close(); }
});
