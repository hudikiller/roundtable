import { existsSync, readFileSync, mkdirSync, chmodSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { isIP } from "node:net";
import { setLocale, L } from "./i18n.js";

export const configSchema = z.object({
  // Interface language: chat replies, cards and the language models are asked to answer in.
  locale: z.enum(["en", "zh"]).default("en"),
  tenantId: z.string().min(1),
  allowedChats: z.array(z.string().min(1)).min(1),
  allowedMembers: z.array(z.string().min(1)).min(1),
  leaders: z.array(z.string().min(1)).default([]),
  receiveBackground: z.boolean().default(false),
  threadFollowups: z.enum(["mention", "initiator", "members"]).default("mention"),
  replyMode: z.enum(["chat", "thread"]).default("thread"),
  naturalExecution: z.boolean().default(false),
  cutoffTime: z.number().int().nonnegative().default(0),
  provider: z.object({
    baseUrl: z.url().refine(v => new URL(v).protocol === "https:", { error: () => L("provider 必须使用 HTTPS", "provider must use HTTPS") }),
    model: z.string().min(1),
  }),
  repositories: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    path: z.string().refine(isAbsolute, { error: () => L("仓库路径必须是绝对路径", "Repository path must be absolute") }),
    ref: z.string().default("HEAD"),
    checks: z.array(z.array(z.string().min(1)).min(1)).default([]),
    initialize: z.object({ argv: z.array(z.string().min(1)).min(1), approvedVersion: z.string().min(1) }).optional(),
    resume: z.object({ argv: z.array(z.string().min(1)).min(1), approvedVersion: z.string().min(1) }).optional(),
  })).default([]),
  defaultRepo: z.string().optional(),
  dataDir: z.string().default("./data"),
  concurrency: z.number().int().min(1).max(8).default(2),
  sandbox: z.object({
    image: z.string().default("feishu-codex-task:0.1.0"),
    cpus: z.number().positive().max(8).default(2),
    memoryMiB: z.number().int().min(256).default(4096),
    pids: z.number().int().min(16).default(256),
    timeoutSeconds: z.number().int().min(10).default(1800),
    diskMiB: z.number().int().min(16).default(2048),
    egressHosts: z.array(z.string().regex(/^[a-zA-Z0-9.-]+$/)).default([]),
    egressAddresses: z.record(z.string().regex(/^[a-zA-Z0-9.-]+$/),
      z.array(z.string().refine(v => isIP(v) !== 0)).min(1).max(16)).optional(),
    dockerContext: z.string().regex(/^[a-zA-Z0-9_.-]+$/).optional(),
    nodeId: z.string().optional(),
  }).default({ image: "feishu-codex-task:0.1.0", cpus: 2, memoryMiB: 4096,
    pids: 256, timeoutSeconds: 1800, diskMiB: 2048, egressHosts: [] }),
  runnerBridge: z.object({
    port: z.number().int().min(1024).max(65535).default(9443),
    certFile: z.string(),
    keyFile: z.string(),
    enrollmentKeyFile: z.string(),
    defaultNode: z.string().optional(),
    projectDefaults: z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/), z.string().min(1)).optional(),
    feishuEnabled: z.boolean().default(true),
    // Team servers usable by every allowed member; honoured only when a Leader owns the node.
    sharedNodes: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).default(["team-runner"]),
    // Default model and reasoning effort for every executing turn (topic tasks and the group agent).
    defaults: z.object({
      model: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/).optional(),
      effort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
    }).optional(),
    // Models members may pick in chat or on cards (each still subject to the node's allowedModels).
    models: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/), label: z.string().min(1).max(40) })).min(1).max(10)
      .default([{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol" }, { id: "gpt-6-astra", label: "GPT-6 Astra" }]),
    groupAgent: z.object({
      enabled: z.boolean().default(false),
      node: z.string().regex(/^[a-zA-Z0-9_-]+$/).default("team-runner"),
      feedBudgetChars: z.number().int().min(4000).max(400_000).default(60_000),
      historyMaxBytes: z.number().int().min(64 * 1024).max(6 * 1024 * 1024).default(4 * 1024 * 1024),
      importHistory: z.boolean().default(true),
      // Claude Tag pauses per-message judgement after ~100 top-level messages without engaging.
      pauseAfter: z.number().int().min(10).max(10_000).default(100),
      ackEmoji: z.string().regex(/^[A-Za-z_]{1,40}$/).default("OnIt"),
      webSearch: z.boolean().default(true),
    }).optional(),
    intentModel: z.object({
      baseUrl: z.url().refine(v => new URL(v).protocol === "https:", { error: () => L("意图识别模型必须使用 HTTPS", "Intent model must use HTTPS") }),
      model: z.string().min(1),
      keyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default("BRIDGE_MODEL_API_KEY"),
      timeoutMs: z.number().int().min(1000).max(60_000).default(15_000),
    }).optional(),
  }).optional(),
}).superRefine((c, ctx) => {
  if (new Set(c.repositories.map(r => r.id)).size !== c.repositories.length)
    ctx.addIssue({ code: "custom", message: L("仓库 id 重复", "Duplicate repository id") });
  if (c.defaultRepo && !c.repositories.some(r => r.id === c.defaultRepo))
    ctx.addIssue({ code: "custom", message: L("defaultRepo 不在允许仓库列表中", "defaultRepo is not in the allowed repositories") });
  if (c.leaders.some(id => !c.allowedMembers.includes(id)))
    ctx.addIssue({ code: "custom", message: L("Leader 必须也是允许成员", "Leaders must also be allowed members") });
});

export type AppConfig = z.infer<typeof configSchema>;
export interface Secrets { appId: string; appSecret: string; modelKey: string; intentKey?: string }
export interface Environment { config: AppConfig; secrets: Secrets; configPath: string }

export function loadEnvironment(configPath = process.env.FEISHU_CODEX_CONFIG || "config.json", bridgeOnly = false): Environment {
  const envFile = resolve(dirname(resolve(configPath)), ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const raw: unknown = JSON.parse(readFileSync(resolve(configPath), "utf8"));
  const config = configSchema.parse(raw);
  setLocale(config.locale);
  bridgeOnly ||= !!config.runnerBridge;
  config.dataDir = resolve(dirname(resolve(configPath)), config.dataDir);
  const secrets = {
    appId: process.env.FEISHU_APP_ID || "",
    appSecret: process.env.FEISHU_APP_SECRET || "",
    modelKey: bridgeOnly ? "" : process.env.CODEX_MODEL_API_KEY || "",
    intentKey: config.runnerBridge?.intentModel ? process.env[config.runnerBridge.intentModel.keyEnv] || "" : undefined,
  };
  if (secrets.intentKey !== undefined && (!secrets.intentKey || secrets.intentKey === "replace_me"))
    throw new Error(L("已配置 Bridge 意图识别模型，但本机 .env 缺少对应 Key。", "A Bridge intent model is configured, but the local .env is missing its key."));
  if ([secrets.appId, secrets.appSecret, ...(bridgeOnly ? [] : [secrets.modelKey])].some(v => !v || v === "replace_me"))
    throw new Error(L("缺少应用或模型凭据；先运行 npm run setup。密钥仅填写在本机 .env。", "Missing app or model credentials. Run npm run setup first. Secrets go only in the local .env."));
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  chmodSync(config.dataDir, 0o700);
  return { config, secrets, configPath: resolve(configPath) };
}
