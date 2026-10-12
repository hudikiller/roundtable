import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadEnvironment } from "../src/config.js";
import { Store } from "../src/store.js";
import { RunnerRegistry } from "../src/runner/registry.js";
import { loadNode, nodeCapabilities } from "../src/runner/config.js";
import { BridgeClient } from "../src/runner/client.js";
import { CHUNK_BYTES, checkpoint, type ArtifactInfo } from "../src/runner/protocol.js";
import type { Job, Session } from "../src/types.js";
import { setSecrets } from "../src/log.js";

const op = process.argv[2], mib = Number(process.argv[4] ?? process.argv[3]);
if (![1, 5, 24].includes(mib)) throw new Error("仅允许1/5/24MiB固定文件");
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
if (op === "prepare") {
  const { config } = loadEnvironment(undefined, true);
  if (!config.runnerBridge || config.runnerBridge.feishuEnabled) throw new Error("仅技术验收，禁用飞书消费者");
  const store = new Store(join(config.dataDir, "control.sqlite")), registry = new RunnerRegistry(config, store);
  try {
    const node = registry.nodes().find(n => n.name === process.argv[3])!;
    if (!node) throw new Error("先登记节点");
    const id = randomUUID();
    const s: Session = { id, tenantId: config.tenantId, chatId: config.allowedChats[0]!, rootMessageId: `transport_${id}`,
      initiatorId: node.ownerId, repoId: "feedbackdesk", workspaceVolume: `fc-transfer-work-${id}`,
      stateVolume: `fc-transfer-state-${id}`, initialized: false, review: "open", createdAt: Date.now() };
    s.runnerId = node.id; s.projectAlias = "feedbackdesk";
    s.profileVersion = node.capabilities.projects.find(p => p.id === s.projectAlias)!.version;
    store.saveSession(s);
    const j: Job = { id: randomUUID(), sessionId: id, messageId: `transport_${id}`, senderId: node.ownerId,
      mode: "discuss", status: "running", contextLoaded: true, prompt: `PROTOCOL_ONLY_TRANSFER_${mib}MIB_NO_MODEL`, createdAt: Date.now() };
    store.insertJob(j); const r = registry.createRun(s, j);
    console.log(JSON.stringify({ runId: r.id, generation: r.generation, jobId: j.id, mib, modelCalls: 0 }));
  } finally { store.close(); }
} else if (op === "upload" || op === "resume") {
  const { config: c, modelKey } = loadNode();
  setSecrets([c.token, modelKey, c.provider.baseUrl]);
  const client = new BridgeClient(c.bridgeUrl, c.caFile, c.token);
  const file = join(c.dataDir, `transfer-${mib}.json`);
  const bytes = Buffer.alloc(mib * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 17) % 251;
  let record: { runId: string; generation: number; artifact: ArtifactInfo; parts: number[]; startedAt: number };
  if (op === "resume") {
    if (!existsSync(file)) throw new Error("没有已中断传输账本");
    record = JSON.parse(readFileSync(file, "utf8"));
  } else {
    await client.heartbeat(nodeCapabilities(c, true), []);
    const { assignment: a } = await client.poll(1, 0);
    if (!a || a.job.prompt !== `PROTOCOL_ONLY_TRANSFER_${mib}MIB_NO_MODEL`) throw new Error("拒绝处理非本次协议测试任务");
    record = { runId: a.runId, generation: a.generation, artifact: {
      id: randomUUID(), bytes: bytes.length, sha256: hash(bytes), name: `transport-${mib}.zip`,
    }, parts: [], startedAt: Date.now() };
    writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
    await client.event({ runId: a.runId, generation: a.generation, seq: 1,
      payload: { kind: "result", completion: { result: { status: "completed", text: "协议传输测试；没有运行模型" },
        checkpoint: checkpoint(a.session), artifact: record.artifact } } });
  }
  const total = Math.ceil(bytes.length / CHUNK_BYTES);
  const end = op === "upload" ? Math.floor(total / 2) : total;
  if (op === "resume" && record.parts.length) {
    // Repeat an already acknowledged block, then resume missing ones.
    await client.chunk({ runId: record.runId, generation: record.generation, artifact: record.artifact, index: 0 }, bytes.subarray(0, CHUNK_BYTES));
  }
  for (let start = 0; start < end; start += 4) {
    const indices = Array.from({ length: Math.min(4, end - start) }, (_, i) => start + i).filter(i => !record.parts.includes(i));
    await Promise.all(indices.map(async index => {
      await client.chunk({ runId: record.runId, generation: record.generation, artifact: record.artifact, index },
        bytes.subarray(index * CHUNK_BYTES, Math.min(bytes.length, (index + 1) * CHUNK_BYTES)));
      record.parts.push(index);
      writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
    }));
  }
  const ms = Date.now() - record.startedAt;
  console.log(JSON.stringify({ node: c.name, mib, runId: record.runId, generation: record.generation,
    interrupted: op === "upload", uploadedParts: record.parts.length, totalParts: total,
    sha256: record.artifact.sha256, ms, mibPerSecond: Number((mib * 1000 / ms).toFixed(3)), modelCalls: 0 }));
  client.close();
} else if (op === "verify") {
  const { config } = loadEnvironment(undefined, true), store = new Store(join(config.dataDir, "control.sqlite"));
  try {
    const registry = new RunnerRegistry(config, store);
    const r = registry.runs().filter(r => r.completion?.artifact?.name === `transport-${mib}.zip`).at(-1)!;
    assert.equal(r.state, "completed"); assert.ok(r.artifactPath);
    const bytes = readFileSync(r.artifactPath!);
    assert.equal(hash(bytes), r.completion!.artifact!.sha256);
    assert.equal(bytes.length, mib * 1024 * 1024);
    const j = store.getJob(r.jobId)!; j.status = "completed"; j.endedAt = Date.now(); store.saveJob(j);
    console.log(JSON.stringify({ verified: true, mib, hash: hash(bytes), bytes: bytes.length, modelCalls: 0 }));
  } finally { store.close(); }
} else throw new Error("支持 prepare / upload / resume / verify");
