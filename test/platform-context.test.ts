import test from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@larksuiteoapi/node-sdk";
import type { Job, Session } from "../src/types.js";
import { platformContext } from "../src/platform-context.js";
import { Router } from "../src/router.js";
import { Jobs } from "../src/jobs.js";
import { testEnvironment, FakeRunner, message, messenger, until } from "./helpers.js";

test("平台历史读取只用应用身份、同群和授权成员；无权限配置时零API调用", async () => {
  const env = testEnvironment(), calls: string[] = [];
  const item = (id: string, sender: string, chat = "chat", content = "known") => ({
    message_id: id, chat_id: chat, thread_id: "omt_native", create_time: String(Date.now() - 1000),
    sender: { id: sender, id_type: "open_id", sender_type: "user" }, msg_type: "text",
    body: { content: JSON.stringify({ text: content }) },
  });
  const client = { im: { message: {
    async get() { calls.push("get"); return { code: 0, data: { items: [item("om_reference", "alice")] } }; },
    async list(input: unknown) {
      calls.push("list");
      assert.deepEqual((input as { params: unknown }).params, {
        container_id_type: "thread", container_id: "omt_native", sort_type: "ByCreateTimeDesc", page_size: 20,
      });
      return { code: 0, data: { items: [item("om_allowed", "bob", "chat", "AUTHORED_CONTEXT"),
        item("om_forbidden", "mallory", "chat", "FORBIDDEN_CONTENT"), item("om_otherchat", "alice", "elsewhere", "OTHER_CHAT_CONTENT")], has_more: true } };
    },
  } } } as unknown as Client;
  const session = { tenantId: "tenant", chatId: "chat", rootMessageId: "om_current" } as Session;
  const job = { messageId: "om_current", referenceIds: ["om_reference"], createdAt: Date.now() } as Job;
  try {
    env.config.receiveBackground = false;
    assert.equal(await platformContext(client, env.config, { appId: "app", appSecret: "", modelKey: "" }, env.store, session, job), "");
    assert.equal(calls.length, 0);
    env.config.receiveBackground = true;
    const text = await platformContext(client, env.config, { appId: "app", appSecret: "", modelKey: "" }, env.store, session, job);
    assert.match(text, /AUTHORED_CONTEXT/);
    assert.ok(!text.includes("FORBIDDEN_CONTENT") && !text.includes("OTHER_CHAT_CONTENT"));
    assert.match(text, /超过20条/);
    assert.equal(calls.length, 2);
  } finally { env.close(); }
});

test("未知引用位于别的群时不读线程，不向模型提供正文", async () => {
  const env = testEnvironment();
  let lists = 0;
  const client = { im: { message: {
    async get() { return { code: 0, data: { items: [{ message_id: "om_reference", chat_id: "private-other-chat", thread_id: "omt_other" }] } }; },
    async list() { lists++; throw new Error("不应该调用"); },
  } } } as unknown as Client;
  try {
    const text = await platformContext(client, env.config, { appId: "", appSecret: "", modelKey: "" }, env.store,
      { tenantId: "tenant", chatId: "chat", rootMessageId: "om_current" } as Session,
      { messageId: "om_current", referenceIds: ["om_reference"], createdAt: Date.now() } as Job);
    assert.match(text, /未取得可访问的同群正文/);
    assert.equal(lists, 0);
  } finally { env.close(); }
});

test("上下文加载期间停止，读取完成后不得启动迟到的模型回合", async () => {
  const env = testEnvironment(), runner = new FakeRunner(), router = new Router(env.config, env.store, runner);
  let loading = false, release: () => void = () => {};
  const jobs = new Jobs(env.config, env.store, runner, messenger, async () => {
    loading = true; await new Promise<void>(resolve => { release = resolve; }); return "授权背景";
  });
  try {
    await router.handle(message({ messageId: "root" }));
    await jobs.tick(); await until(() => loading);
    await router.handle(message({ rootId: "root", text: "停止" }));
    release(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(runner.calls.length, 0);
    assert.equal(env.store.jobs()[0]!.status, "stopped");
  } finally { release(); await jobs.close(); env.close(); }
});
