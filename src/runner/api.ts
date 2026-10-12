import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { capabilitySchema, envelopeSchema, chunkSchema, idSchema, type NodeRecord } from "./protocol.js";
import { RunnerRegistry } from "./registry.js";
import { errorText } from "../log.js";

async function body(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.length;
    if (bytes > max) throw new Error("请求体超过上限");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
const pollSchema = z.object({ free: z.number().int().min(0).max(8), waitMs: z.number().int().min(0).max(20_000).default(20_000) });
const heartbeatSchema = z.object({ capabilities: capabilitySchema, running: z.array(z.object({
  runId: idSchema, generation: z.number().int().positive(),
})).max(8) });

export class RunnerApi {
  private server?: Server;
  private closing = false;
  private requests = new Set<Promise<void>>();
  constructor(readonly registry: RunnerRegistry) {}
  async start(port = this.registry.config.runnerBridge!.port): Promise<number> {
    const cfg = this.registry.config.runnerBridge!;
    this.server = createServer({ key: readFileSync(cfg.keyFile), cert: readFileSync(cfg.certFile),
      minVersion: "TLSv1.2" }, (req, res) => {
      const pending = this.handle(req, res);
      this.requests.add(pending);
      void pending.finally(() => this.requests.delete(pending));
    });
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject); this.server!.listen(port, "127.0.0.1", resolve);
    });
    return (this.server.address() as { port: number }).port;
  }
  private json(res: ServerResponse, status: number, value: unknown): void {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(value));
  }
  private auth(req: IncomingMessage): NodeRecord {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ") || header.length > 300) throw new Error("节点认证失败");
    return this.registry.authenticate(header.slice(7));
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method !== "POST" || !["/runner/enroll", "/runner/poll", "/runner/heartbeat", "/runner/events"].includes(req.url ?? ""))
        return this.json(res, 404, { error: "接口不存在" });
      if (this.closing) return this.json(res, 503, { error: "Bridge 正在退出" });
      if (req.url === "/runner/enroll") {
        const value = z.object({ code: z.string().min(20).max(100), requestId: idSchema, capabilities: capabilitySchema })
          .parse(JSON.parse((await body(req, 32_768)).toString()));
        const { node, token } = this.registry.enroll(value.code, value.requestId, value.capabilities);
        return this.json(res, 200, { protocolVersion: 1, node: { id: node.id, ownerId: node.ownerId, name: node.name }, token });
      }
      let node: NodeRecord;
      try { node = this.auth(req); } catch { return this.json(res, 401, { error: "节点凭据无效或已撤销" }); }
      if (req.url === "/runner/events" && req.headers["content-type"] === "application/octet-stream") {
        const raw = req.headers["x-runner-chunk"];
        if (typeof raw !== "string" || raw.length > 4096) throw new Error("缺少成果分块元数据");
        const chunk = chunkSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString()));
        this.registry.chunk(node, chunk, await body(req, 256 * 1024));
        return this.json(res, 200, { accepted: true, index: chunk.index });
      }
      const data = JSON.parse((await body(req, 1024 * 1024)).toString());
      if (req.url === "/runner/heartbeat") {
        const h = heartbeatSchema.parse(data);
        return this.json(res, 200, this.registry.heartbeat(node, h.capabilities, h.running));
      }
      if (req.url === "/runner/events")
        return this.json(res, 200, this.registry.accept(node, envelopeSchema.parse(data)));
      const p = pollSchema.parse(data), deadline = Date.now() + p.waitMs;
      do {
        const current = this.registry.node(node.id);
        if (!current || current.revoked || current.tokenHash !== node.tokenHash) return this.json(res, 401, { error: "节点已撤销或凭据已更新" });
        const controls = this.registry.controls(node.id);
        const assignment = this.registry.claim(current, p.free);
        if (controls.length || assignment || Date.now() >= deadline)
          return this.json(res, 200, { controls, assignment });
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (!this.closing && !res.destroyed);
      this.json(res, 503, { error: "Bridge 正在退出" });
    } catch (e) { this.json(res, 400, { error: errorText(e) }); }
  }
  async close(): Promise<void> {
    this.closing = true;
    await new Promise<void>(resolve => {
      if (!this.server) return resolve();
      const timeout = setTimeout(() => this.server?.closeAllConnections(), 3000);
      this.server.close(() => { clearTimeout(timeout); resolve(); });
      this.server.closeIdleConnections();
    });
    await Promise.allSettled([...this.requests]);
  }
}
