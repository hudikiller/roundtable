import { request } from "node:https";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { ClientRequest } from "node:http";
import type { Assignment, Capabilities, Envelope, Chunk, Control } from "./protocol.js";

export class NodeAuthenticationError extends Error {}
export class BridgeClient {
  private ca: Buffer;
  private requests = new Set<ClientRequest>();
  private closed = false;
  constructor(private baseUrl: string, caFile: string, private token = "") {
    if (new URL(baseUrl).protocol !== "https:") throw new Error("Bridge 必须使用HTTPS");
    this.ca = readFileSync(caFile);
  }
  private call<T>(path: string, input: Buffer, headers: Record<string, string> = {}, timeout = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Bridge客户端已关闭"));
    const url = new URL(path, this.baseUrl);
    return new Promise((resolve, reject) => {
      const req = request(url, { method: "POST", ca: this.ca, minVersion: "TLSv1.2", rejectUnauthorized: true,
        headers: { "content-type": "application/json", "content-length": String(input.length),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...headers } }, res => {
        if (res.statusCode === 401) { res.resume(); return reject(new NodeAuthenticationError("节点凭据已撤销或无效")); }
        if ((res.statusCode ?? 500) >= 300 && (res.statusCode ?? 500) < 400) {
          res.resume(); return reject(new Error("Bridge 禁止重定向，未转发凭据"));
        }
        const chunks: Buffer[] = []; let size = 0;
        res.on("data", (b: Buffer) => {
          size += b.length;
          if (size > 8 * 1024 * 1024) { res.destroy(); reject(new Error("Bridge响应超过8MiB")); }
          else chunks.push(b);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString());
            if (res.statusCode !== 200) reject(new Error(`Bridge 请求失败 (${res.statusCode}): ${value.error ?? "unknown"}`));
            else resolve(value as T);
          } catch (e) { reject(e); }
        });
      });
      req.setTimeout(timeout, () => req.destroy(new Error("Bridge HTTPS请求超时")));
      this.requests.add(req);
      req.on("close", () => this.requests.delete(req));
      req.on("error", reject); req.end(input);
    });
  }
  enroll(code: string, requestId: string, capabilities: Capabilities): Promise<{
    protocolVersion: 1; node: { id: string; name: string; ownerId: string }; token: string;
  }> { return this.json("/runner/enroll", { code, requestId, capabilities }); }
  json<T>(path: string, input: unknown): Promise<T> { return this.call(path, Buffer.from(JSON.stringify(input))); }
  poll(free: number, waitMs = 20_000): Promise<{ assignment?: Assignment; controls: Control[] }> {
    return this.json("/runner/poll", { free, waitMs });
  }
  heartbeat(capabilities: Capabilities, running: { runId: string; generation: number }[]): Promise<{
    controls: Control[]; leases: { runId: string; generation: number; leaseMs: number }[];
  }> { return this.json("/runner/heartbeat", { capabilities, running }); }
  event(envelope: Envelope): Promise<{ ack: number; quarantined?: boolean }> { return this.json("/runner/events", envelope); }
  chunk(metadata: Omit<Chunk, "sha256">, bytes: Buffer): Promise<{ accepted: boolean }> {
    const chunk = { ...metadata, sha256: createHash("sha256").update(bytes).digest("hex") };
    return this.call("/runner/events", bytes, { "content-type": "application/octet-stream",
      "x-runner-chunk": Buffer.from(JSON.stringify(chunk)).toString("base64url") });
  }
  close(): void {
    this.closed = true;
    for (const req of this.requests) req.destroy(new Error("Runner正在关闭，待上传事件保留"));
  }
}
