import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { configSchema, type AppConfig } from "../config.js";
import type { Capabilities } from "./protocol.js";

const script = z.object({ argv: z.array(z.string().min(1)).min(1), approvedVersion: z.string().min(1) });
export const nodeConfigSchema = z.object({
  bridgeUrl: z.url().refine(s => new URL(s).protocol === "https:"),
  caFile: z.string().refine(isAbsolute), nodeId: z.string().uuid(), token: z.string().min(32),
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/), ownerId: z.string().min(1),
  dataDir: z.string().refine(isAbsolute), capacity: z.number().int().min(1).max(8).default(1),
  modelKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default("CODEX_MODEL_API_KEY"),
  provider: z.object({ baseUrl: z.url().refine(s => new URL(s).protocol === "https:"), model: z.string().min(1),
    label: z.string().min(1).max(80) }),
  projects: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/), path: z.string().refine(isAbsolute),
    ref: z.string().default("HEAD"), checks: z.array(z.array(z.string().min(1)).min(1)).default([]),
    initialize: script.optional(), resume: script.optional(),
  })).default([]),
  sandbox: configSchema.shape.sandbox,
  /** Models this node's owner allows the Bridge to request; unset allows any model on the provider. */
  allowedModels: z.array(z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/)).max(20).optional(),
});
export type NodeConfig = z.infer<typeof nodeConfigSchema>;
export function projectVersion(c: NodeConfig, id: string): string {
  return createHash("sha256").update(JSON.stringify({ project: c.projects.find(p => p.id === id),
    sandbox: c.sandbox, provider: c.provider })).digest("hex");
}
export function nodeCapabilities(c: NodeConfig, ready: boolean): Capabilities {
  return { protocolVersion: 1, os: process.platform, arch: process.arch, capacity: c.capacity, ready,
    projects: c.projects.map(p => ({ id: p.id, version: projectVersion(c, p.id), profileLabel: c.provider.label, ready })) };
}
export function sandboxConfig(c: NodeConfig): AppConfig {
  return configSchema.parse({ tenantId: "node", allowedChats: ["node"], allowedMembers: [c.ownerId],
    dataDir: c.dataDir, provider: c.provider, repositories: c.projects,
    defaultRepo: c.projects[0]?.id, concurrency: c.capacity,
    sandbox: { ...c.sandbox, nodeId: c.nodeId, image: c.sandbox.image } });
}
export function loadNode(path = process.env.FEISHU_RUNNER_CONFIG || "runner.json"): { config: NodeConfig; modelKey: string } {
  const file = resolve(path), env = resolve(dirname(file), ".env");
  if (existsSync(env)) process.loadEnvFile(env);
  const config = nodeConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const modelKey = process.env[config.modelKeyEnv] || "";
  if (!modelKey || modelKey === "replace_me") throw new Error("在节点本机 .env 配置项目模型 Key，不能发送到群聊。");
  return { config, modelKey };
}
