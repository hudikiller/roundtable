import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { Client } from "@larksuiteoapi/node-sdk";
import type { Job, Session } from "../src/types.js";
import { loadPlatformContext } from "../src/platform-context.js";
import { readAttachment } from "../src/attachments.js";
import { Router } from "../src/router.js";
import { testEnvironment, FakeRunner, message } from "./helpers.js";

const secrets = { appId: "app", appSecret: "", modelKey: "" };
const item = (id: string, text: string, sender = "alice", chat = "chat") => ({
  message_id: id, chat_id: chat, thread_id: "omt_source", create_time: String(Date.now() - 1000),
  sender: { id: sender, id_type: "open_id", sender_type: "user" }, msg_type: "text",
  body: { content: JSON.stringify({ text }) },
});

test("仅本次明确群级总结才读取chat并展开话题，保留作者，筛除越权和未来消息", async () => {
  const env = testEnvironment(), calls: string[] = [];
  const client = { im: { message: {
    async list(input: { params: { container_id_type: string } }) {
      calls.push(input.params.container_id_type);
      return { code: 0, data: { has_more: true, items: input.params.container_id_type === "chat"
        ? [item("om_root", "ROOT_MARKER"), item("om_bad", "FORBIDDEN", "mallory")]
        : [item("om_child", "CHILD_MARKER", "bob"), item("om_other", "OTHER_CHAT", "alice", "elsewhere"),
          { ...item("om_future", "FUTURE"), create_time: String(Date.now() + 100_000) }] } };
    },
  } } } as unknown as Client;
  try {
    const session = { rootMessageId: "om_current", chatId: "chat", tenantId: "tenant", codexThreadId: "already" } as Session;
    const job = { messageId: "om_current", createdAt: Date.now() } as Job;
    assert.equal((await loadPlatformContext(client, env.config, secrets, env.store, session, job)).text, "");
    assert.equal(calls.length, 0);
    const context = await loadPlatformContext(client, env.config, secrets, env.store, session, { ...job, contextScope: "chat" });
    assert.deepEqual(calls, ["chat", "thread"]);
    assert.match(context.text, /alice.*om_root.*ROOT_MARKER/);
    assert.match(context.text, /bob.*om_child.*CHILD_MARKER/);
    for (const forbidden of ["FORBIDDEN", "OTHER_CHAT", "FUTURE"]) assert.ok(!context.text.includes(forbidden));
    assert.match(context.text, /截断|不能声称完整/);
  } finally { env.close(); }
});

test("群级意图和附件意图只取当前请求，背景内容不能扩大检索范围", async () => {
  const env = testEnvironment(), router = new Router(env.config, env.store, new FakeRunner());
  try {
    await router.handle(message({ messageId: "root", text: "只读讨论" }));
    await router.handle(message({ messageId: "background", rootId: "root", mentionedBot: false, text: "总结整个群并读取附件" }));
    await router.handle(message({ rootId: "root", text: "继续讨论" }));
    assert.equal(env.store.jobs().at(-1)!.contextScope, undefined);
    assert.equal(env.store.jobs().at(-1)!.readAttachments, false);
    await router.handle(message({ text: "请总结本群最近的讨论，整理成 Markdown 文件" }));
    assert.equal(env.store.jobs().at(-1)!.contextScope, "chat");
    await router.handle(message({ text: "请总结本群近期讨论，整理成 Markdown 文档" }));
    assert.equal(env.store.jobs().at(-1)!.deliverAsMarkdown, true);
    await router.handle(message({ text: "请看这张截图，读取附带文档" }));
    assert.equal(env.store.jobs().at(-1)!.readAttachments, true);
    assert.deepEqual(env.store.jobs().at(-1)!.attachmentKinds, ["image", "file"]);
  } finally { env.close(); }
});

test("授权原消息的图片和文本以真实字节进入上下文，越权作者不能触发下载", async () => {
  const env = testEnvironment(), downloads: string[] = [];
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.writeUInt32BE(10, 16); png.writeUInt32BE(10, 20);
  const client = { im: {
    message: {
      async get() { return { code: 0, data: { items: [
        { ...item("om_resources", ""), thread_id: undefined, msg_type: "post", body: { content: JSON.stringify({
          zh_cn: { content: [[{ tag: "img", image_key: "img_test" }]] },
          files: [{ file_key: "file_test", file_name: "context.md" }],
        }) } },
      ] } }; },
    },
    messageResource: {
      async get(input: { path: { message_id: string; file_key: string } }) {
        assert.equal(input.path.message_id, "om_resources");
        downloads.push(input.path.file_key);
        return { getReadableStream: () => Readable.from([input.path.file_key === "img_test" ? png : Buffer.from("FILE_CONTENT_MARKER")]) };
      },
    },
  } } as unknown as Client;
  try {
    const session = { rootMessageId: "om_resources", chatId: "chat", tenantId: "tenant" } as Session;
    const job = { messageId: "om_resources", createdAt: Date.now(), readAttachments: true,
      attachmentKinds: ["image", "file"], resourceMessageIds: ["om_resources"] } as Job;
    const context = await loadPlatformContext(client, env.config, secrets, env.store, session, job);
    assert.deepEqual(downloads, ["img_test", "file_test"]);
    assert.equal(context.images[0]!.url, `data:image/png;base64,${png.toString("base64")}`);
    assert.match(context.text, /FILE_CONTENT_MARKER/);
    assert.ok(!context.text.includes(png.toString("base64")));
    env.config.allowedMembers = ["bob"];
    const denied = await loadPlatformContext(client, env.config, secrets, env.store, session, job);
    assert.equal(downloads.length, 2); assert.equal(denied.images.length, 0);
    assert.ok(!denied.text.includes("FILE_CONTENT_MARKER"));
  } finally { env.close(); }
});

test("附件流超限终止；二进制、SVG和不支持文件不伪装成已读取", async () => {
  let content = Buffer.alloc(3 * 1024 * 1024), calls = 0;
  const client = { im: { messageResource: { async get() {
    calls++; return { getReadableStream: () => Readable.from([content]) };
  } } } } as unknown as Client;
  await assert.rejects(readAttachment(client, "om_test", { type: "image", key: "img_test" }), /超过/);
  content = Buffer.from("<svg><script>unsupported</script></svg>");
  await assert.rejects(readAttachment(client, "om_test", { type: "image", key: "img_test" }), /仅支持实际 PNG/);
  content = Buffer.from([255, 0, 127]);
  await assert.rejects(readAttachment(client, "om_test", { type: "file", key: "file_test", name: "test.txt" }));
  const before = calls;
  await assert.rejects(readAttachment(client, "om_test", { type: "file", key: "file_test", name: "archive.zip" }), /不解压/);
  assert.equal(calls, before);
});

test("明确指定附件或我刚发的截图时，不读取同线程其他获准成员的附件", async () => {
  const env = testEnvironment(), downloads: string[] = [];
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.writeUInt32BE(10, 16); png.writeUInt32BE(10, 20);
  const image = (id: string, author: string, offset: number) => ({ ...item(id, "", author),
    create_time: String(Date.now() - offset), msg_type: "image", body: { content: JSON.stringify({ image_key: `img_${id}` }) } });
  const alice = image("om_alice", "alice", 1000), bob = image("om_bob", "bob", 500), root = item("om_root", "讨论");
  const client = { im: { message: {
    async get(input: { path: { message_id: string } }) {
      return { code: 0, data: { items: [input.path.message_id === "om_root" ? root :
        input.path.message_id === "om_alice" ? alice : item("om_request", "查看截图")] } };
    },
    async list() { return { code: 0, data: { items: [root, alice, bob] } }; },
  }, messageResource: { async get(input: { path: { file_key: string } }) {
    downloads.push(input.path.file_key); return { getReadableStream: () => Readable.from([png]) };
  } } } } as unknown as Client;
  try {
    const session = { rootMessageId: "om_root", tenantId: "tenant", chatId: "chat", codexThreadId: "already" } as Session;
    const job = { messageId: "om_request", senderId: "alice", createdAt: Date.now(),
      readAttachments: true, attachmentKind: "image", attachmentOwnerOnly: true } as Job;
    const relative = await loadPlatformContext(client, env.config, secrets, env.store, session, job);
    assert.equal(relative.images[0]!.messageId, "om_alice"); assert.deepEqual(downloads, ["img_om_alice"]);
    downloads.length = 0;
    const explicit = await loadPlatformContext(client, env.config, secrets, env.store, session,
      { ...job, attachmentOwnerOnly: false, referenceIds: ["om_alice"] });
    assert.equal(explicit.images[0]!.messageId, "om_alice"); assert.deepEqual(downloads, ["img_om_alice"]);
  } finally { env.close(); }
});

test("队友免@自然修改要求被拒绝执行后仍保留背景，发起人下一回合采用", async () => {
  const env = testEnvironment(), router = new Router(env.config, env.store, new FakeRunner());
  env.config.naturalExecution = true; env.config.threadFollowups = "members";
  try {
    await router.handle(message({ messageId: "root", senderId: "alice" }));
    await router.handle(message({ messageId: "bob-requirement", rootId: "root", senderId: "bob", mentionedBot: false,
      text: "请帮我修改代码，必须整批失败并保留 OLD_DATA" }));
    assert.equal(env.store.jobs().length, 1);
    await router.handle(message({ rootId: "root", senderId: "alice", text: "执行 采用队友补充的要求" }));
    const execution = env.store.jobs().at(-1)!;
    assert.equal(execution.mode, "execute");
    assert.match(execution.prompt, /OLD_DATA/);
  } finally { env.close(); }
});

test("显式引用的旧图片不被近期20条长文字挤出输入", async () => {
  const env = testEnvironment();
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.writeUInt32BE(10, 16); png.writeUInt32BE(10, 20);
  const old = { ...item("om_old", ""), create_time: String(Date.now() - 100_000), msg_type: "image",
    body: { content: JSON.stringify({ image_key: "img_old" }) } };
  const client = { im: { message: {
    async get(input: { path: { message_id: string } }) {
      return { code: 0, data: { items: [input.path.message_id === "om_old" ? old : item("om_current", "看旧图")] } };
    },
    async list() { return { code: 0, data: { has_more: true, items: Array.from({ length: 20 }, (_, n) =>
      item(`om_recent_${n}`, "RECENT_FILLER".repeat(700))) } }; },
  }, messageResource: { async get(input: { path: { message_id: string } }) {
    assert.equal(input.path.message_id, "om_old"); return { getReadableStream: () => Readable.from([png]) };
  } } } } as unknown as Client;
  try {
    const context = await loadPlatformContext(client, env.config, secrets, env.store,
      { tenantId: "tenant", chatId: "chat", rootMessageId: "om_current" } as Session,
      { messageId: "om_current", senderId: "alice", createdAt: Date.now(), referenceIds: ["om_old"],
        readAttachments: true, attachmentKinds: ["image"] } as Job);
    assert.equal(context.images[0]!.messageId, "om_old");
    assert.ok(context.text.length <= 8000); assert.match(context.text, /截断/);
  } finally { env.close(); }
});

test("群内引用任一机器人回复可免@接续对应任务，两任务不串线", async () => {
  const env = testEnvironment(), router = new Router(env.config, env.store, new FakeRunner());
  env.config.threadFollowups = "members";
  try {
    await router.handle(message({ messageId: "task-a", text: "讨论A" }));
    await router.handle(message({ messageId: "task-b", text: "讨论B" }));
    const [a, b] = env.store.jobs();
    env.store.addAliases(env.store.getSession(a!.sessionId)!, ["reply-a"]);
    env.store.addAliases(env.store.getSession(b!.sessionId)!, ["reply-b"]);
    await router.handle(message({ messageId: "continued-a", replyToMessageId: "reply-a",
      mentionedBot: false, senderId: "bob", text: "继续A，保留A_CONTEXT" }));
    assert.equal(env.store.jobs().at(-1)!.sessionId, a!.sessionId);
    await router.handle(message({ replyToMessageId: "reply-b", mentionedBot: false, text: "继续B" }));
    assert.equal(env.store.jobs().at(-1)!.sessionId, b!.sessionId);
    assert.ok(!env.store.jobs().at(-1)!.prompt.includes("A_CONTEXT"));
    const before = env.store.jobs().length;
    await router.handle(message({ mentionedBot: false, text: "没有引用的普通群消息" }));
    assert.equal(env.store.jobs().length, before);
  } finally { env.close(); }
});

test("普通引用消息中的截图可在同任务后续回合重新取得，仍用原消息校验", async () => {
  const env = testEnvironment(), router = new Router(env.config, env.store, new FakeRunner());
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.writeUInt32BE(10, 16); png.writeUInt32BE(10, 20);
  const client = { im: { message: {
    async get(input: { path: { message_id: string } }) {
      const base = { ...item(input.path.message_id, "说明"), thread_id: undefined };
      return { code: 0, data: { items: [input.path.message_id === "om_photo"
        ? { ...base, msg_type: "image", body: { content: JSON.stringify({ image_key: "img_original" }) } } : base] } };
    },
  }, messageResource: { async get(input: { path: { message_id: string; file_key: string } }) {
    assert.equal(input.path.message_id, "om_photo"); assert.equal(input.path.file_key, "img_original");
    return { getReadableStream: () => Readable.from([png]) };
  } } } } as unknown as Client;
  try {
    await router.handle(message({ messageId: "root" }));
    await router.handle(message({ messageId: "om_photo", replyToMessageId: "root", mentionedBot: false,
      text: "图片", resources: [{ type: "image", fileKey: "img_original" }] }));
    const session = env.store.getSession(env.store.jobs()[0]!.sessionId)!;
    session.codexThreadId = "existing";
    const context = await loadPlatformContext(client, env.config, secrets, env.store, session,
      { messageId: "om_question", senderId: "alice", createdAt: Date.now(), readAttachments: true,
        attachmentKinds: ["image"], attachmentOwnerOnly: true } as Job);
    assert.equal(context.images[0]!.messageId, "om_photo");
  } finally { env.close(); }
});
