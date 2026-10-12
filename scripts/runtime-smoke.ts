import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { loadEnvironment } from "../src/config.js";
import { Sandbox } from "../src/sandbox.js";
import { Feishu } from "../src/feishu.js";
import { checked } from "../src/process.js";
import { setSecrets, errorText } from "../src/log.js";
import type { Session, Job, RunEvent } from "../src/types.js";

const { config, secrets } = loadEnvironment();
setSecrets([secrets.appSecret, secrets.modelKey]);
const sandbox = new Sandbox(config, secrets);
function session(): Session {
  const id = randomUUID();
  return { id, tenantId: config.tenantId, chatId: config.allowedChats[0]!, rootMessageId: "runtime-smoke",
    initiatorId: config.allowedMembers[0]!, repoId: config.defaultRepo, workspaceVolume: `fc-work-${id}`,
    stateVolume: `fc-state-${id}`, initialized: false, review: "open", createdAt: Date.now() };
}
function job(s: Session, prompt: string): Job {
  return { id: randomUUID(), sessionId: s.id, messageId: "synthetic-runtime-request", senderId: s.initiatorId,
    mode: "execute", prompt, status: "running", createdAt: Date.now() };
}
const first = session(), second = session();
const importJob = job(first, `实现 feedback.js 的 importFeedback(existing,incoming)，记录为 {id,content}。
所有同ID不同content冲突（含旧数据与新数据、同批内部）必须整批抛错，不覆盖已有数据。
不得修改调用者数组或对象。相同内容重复可合并。补充严格测试，运行 node --test。
不得修改 index.html。不要提交或推送。这是程序驱动的技术验收，不代表真人接受。`);
const pageJob = job(second, `只修改 index.html，将标题改为“独立线程页面”，增加 PAGE_THREAD_ISOLATION 标记。
不得修改 feedback.js 及其测试。执行 node --test。不要提交或推送。`);
const run = async (s: Session, j: Job) => {
  const events: RunEvent[] = [];
  const result = await sandbox.run(s, j, event => {
    events.push(event);
    if (event.type === "thread") s.codexThreadId = event.threadId;
  });
  assert.equal(result.status, "completed", result.error);
  const checks = events.filter((e): e is Extract<RunEvent, { type: "command" }> =>
    e.type === "command" && e.id.startsWith("check-"));
  assert.ok(checks.length > 0 && checks.every(e => e.exitCode === 0), "固定检查失败");
  j.testSummary = checks.map(e => `${e.command}: exit=${e.exitCode}`).join("\n");
  const artifact = await sandbox.artifacts(s, j, { ...result, events });
  assert.ok(artifact);
  return { result, events, artifact };
};
async function evaluate(volume: string, source: string): Promise<string> {
  return (await checked("docker", ["run", "--rm", "-i", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--user", "1000:1000", "--network", "none",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
    "--mount", `type=volume,src=${volume},dst=/workspace,readonly`,
    config.sandbox.image, "node", "--input-type=module"], { input: source })).toString().trim();
}
try {
  const [imported, page] = await Promise.all([run(first, importJob), run(second, pageJob)]);
  const importEvaluation = await evaluate(first.workspaceVolume, `
    import assert from 'node:assert/strict';import fs from 'node:fs';
    const {importFeedback}=await import('/workspace/feedback.js');
    const old=[{id:'a',content:'old'}],incoming=[{id:'b',content:'new'}];
    assert.deepEqual(importFeedback(old,incoming),[{id:'a',content:'old'},{id:'b',content:'new'}]);
    assert.throws(()=>importFeedback(old,[{id:'b',content:'new'},{id:'a',content:'changed'}]));
    assert.throws(()=>importFeedback(old,[{id:'b',content:'one'},{id:'b',content:'two'}]));
    assert.deepEqual(old,[{id:'a',content:'old'}]);assert.deepEqual(incoming,[{id:'b',content:'new'}]);
    assert.ok(!fs.readFileSync('/workspace/index.html','utf8').includes('PAGE_THREAD_ISOLATION'));
    console.log('atomic-import-and-isolation: passed');
  `);
  const pageEvaluation = await evaluate(second.workspaceVolume, `
    import assert from 'node:assert/strict';import fs from 'node:fs';
    assert.ok(fs.readFileSync('/workspace/index.html','utf8').includes('PAGE_THREAD_ISOLATION'));
    const {importFeedback}=await import('/workspace/feedback.js');
    assert.deepEqual(importFeedback([{id:'a',content:'old'}],[{id:'a',content:'changed'}]),[{id:'a',content:'changed'}]);
    console.log('independent-page-workspace: passed');
  `);
  const resumedJob = job(first, `接续此前实现，只在 README.md 记录导入接口及“同ID不同content整批失败、不修改输入”的约定。
不要覆盖前一轮 feedback.js 或测试，运行 node --test；不要修改 index.html。`);
  const resumed = await run(first, resumedJob);
  const resumedEvaluation = await evaluate(first.workspaceVolume, `
    import assert from 'node:assert/strict';import fs from 'node:fs';
    const {importFeedback}=await import('/workspace/feedback.js');
    assert.throws(()=>importFeedback([{id:'a',content:'old'}],[{id:'a',content:'changed'}]));
    assert.ok(fs.existsSync('/workspace/README.md'));console.log('thread-resume-and-files-preserved: passed');
  `);
  const evidence: Record<string, unknown> = { kind: "real-codex-runtime-and-bot-outbound; no-native-inbound-claim",
    at: new Date().toISOString(), imports: { jobId: importJob.id, baseCommit: first.baseCommit,
      checks: importJob.testSummary, evaluation: importEvaluation, response: imported.result.text, artifact: imported.artifact },
    page: { jobId: pageJob.id, evaluation: pageEvaluation, response: page.result.text },
    resume: { jobId: resumedJob.id, evaluation: resumedEvaluation, artifact: resumed.artifact },
    realUserMention: "pending-user-scope-or-manual-mention", humanTwoPersonAcceptance: "pending" };
  await mkdir(join(config.dataDir, "verification"), { recursive: true, mode: 0o700 });
  const evidencePath = join(config.dataDir, "verification/runtime-m2.json");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  if (process.argv.includes("--deliver")) {
    const feishu = new Feishu(config, secrets);
    const root = await feishu.channel.rawClient.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: config.allowedChats[0]!, msg_type: "text", uuid: randomUUID(),
        content: JSON.stringify({ text: "【feishu-codex 技术联调】真实隔离编码、线程接续与独立检查已完成。此消息由机器人主动发出，不代表真实用户 @ 或真人验收；结果和附件回复在本线程。" }) },
    });
    if (root.code !== 0 || !root.data?.message_id) throw new Error(`机器人投递权限不足 (${root.code})`);
    const target = { tenantId: config.tenantId, chatId: config.allowedChats[0]!, messageId: root.data.message_id };
    const text = await feishu.reply({ id: randomUUID(), target, status: "pending", attempts: 0, nextAttemptAt: 0,
      text: `真实编码检查：${importEvaluation}\n独立线程：${pageEvaluation}\n接续：${resumedEvaluation}\n\n${resumed.result.text}` });
    const file = await feishu.reply({ id: randomUUID(), target, status: "pending", attempts: 0, nextAttemptAt: 0,
      filePath: resumed.artifact, fileName: "feishu-codex-runtime-result.zip" });
    evidence.botThreadDelivery = { replyConfirmed: !!text.messageId, fileConfirmed: !!file.messageId,
      sameRoot: text.rootId === target.messageId && file.rootId === target.messageId };
  }
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(evidence, null, 2));
} catch (e) { console.error(errorText(e)); process.exitCode = 1; }
finally { await sandbox.close(); }
