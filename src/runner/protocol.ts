import { z } from "zod";
import type { Job, Session, RunEvent, RunResult } from "../types.js";

export const PROTOCOL_VERSION = 1;
export const LEASE_MS = 60_000;
export const OFFLINE_MS = 30_000;
export const CHUNK_BYTES = 256 * 1024;
export const ARTIFACT_BYTES = 24 * 1024 * 1024;
export const idSchema = z.string().uuid();
export const projectSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  profileLabel: z.string().min(1).max(80),
  version: z.string().regex(/^[a-f0-9]{64}$/),
  ready: z.boolean(),
});
export type ProjectCapability = z.infer<typeof projectSchema>;
export const capabilitySchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  os: z.string().max(40), arch: z.string().max(20),
  capacity: z.number().int().min(1).max(8),
  ready: z.boolean(), projects: z.array(projectSchema).max(40),
});
export type Capabilities = z.infer<typeof capabilitySchema>;
export interface NodeRecord {
  id: string; name: string; ownerId: string; tokenHash: string;
  revoked: boolean; enrolledAt: number; lastSeen: number; capabilities: Capabilities;
}
export type RunState = "preparing" | "assigned" | "running" | "reported" | "completed" | "failed" | "stopped" | "needs_recovery";
export interface ArtifactInfo { id: string; sha256: string; bytes: number; name: string }
export interface Completion {
  result: Omit<RunResult, "events">;
  checkpoint: Pick<Session, "codexThreadId" | "workspaceVolume" | "stateVolume" | "initialized" | "baseCommit" | "branch">;
  artifact?: ArtifactInfo;
}
export interface Assignment {
  protocolVersion: 1; runId: string; generation: number; leaseMs: number;
  session: Session; job: Job; profileVersion: string;
}
export interface RunRecord {
  id: string; jobId: string; sessionId: string; nodeId: string; generation: number;
  state: RunState; leaseUntil: number; createdAt: number; lastSeq: number;
  turnId?: string; completion?: Completion; artifactPath?: string;
  stopConfirmed?: boolean; error?: string;
}
export interface Control {
  id: string; runId: string; generation: number;
  type: "stop" | "steer" | "archive" | "delete";
  text?: string; expectedTurnId?: string;
  disposition?: "accepted" | "rejected" | "uncertain"; error?: string; turnId?: string;
}
const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("thread"), threadId: z.string().max(200) }),
  z.object({ type: z.literal("turn"), turnId: z.string().max(200) }),
  z.object({ type: z.literal("text"), text: z.string().max(512 * 1024), final: z.boolean() }),
  z.object({ type: z.literal("command"), id: z.string().max(200), command: z.string().max(4000),
    exitCode: z.number().int().nullable(), output: z.string().max(32_000), status: z.string().max(40) }),
  z.object({ type: z.literal("files"), id: z.string().max(200), paths: z.array(z.string().max(4000)).max(1000), status: z.string().max(40) }),
  z.object({ type: z.literal("approvalDenied"), reason: z.string().max(4000) }),
  z.object({ type: z.literal("activity"), kind: z.enum(["command", "files", "checks"]), summary: z.string().max(500) }),
  z.object({ type: z.literal("completed"), status: z.enum(["completed", "failed", "interrupted"]), error: z.string().max(4000).optional() }),
  z.object({ type: z.literal("plan"), explanation: z.string().max(500).nullable().optional(),
    steps: z.array(z.object({ step: z.string().max(300), status: z.enum(["pending", "inProgress", "completed"]) })).max(20) }),
]);
export const artifactSchema = z.object({ id: idSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().min(1).max(ARTIFACT_BYTES), name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}\.zip$/) });
const checkpointSchema = z.object({
  codexThreadId: z.string().max(200).optional(), workspaceVolume: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
  stateVolume: z.string().regex(/^[a-zA-Z0-9_.-]+$/), initialized: z.boolean(),
  baseCommit: z.string().regex(/^[a-f0-9]{40}$/).optional(), branch: z.string().max(100).optional(),
});
export const completionSchema = z.object({
  result: z.object({ status: z.enum(["completed", "failed", "interrupted"]), text: z.string().max(512 * 1024),
    error: z.string().max(4000).optional(), cleanupFailed: z.boolean().optional() }),
  checkpoint: checkpointSchema, artifact: artifactSchema.optional(),
});
export const envelopeSchema = z.object({
  runId: idSchema, generation: z.number().int().positive(), seq: z.number().int().positive(),
  payload: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("started") }),
    z.object({ kind: z.literal("event"), event: eventSchema }),
    z.object({ kind: z.literal("result"), completion: completionSchema }),
    z.object({ kind: z.literal("control"), controlId: idSchema,
      disposition: z.enum(["accepted", "rejected", "uncertain"]), error: z.string().max(4000).optional(), turnId: z.string().max(200).optional() }),
  ]),
});
export type Envelope = z.infer<typeof envelopeSchema>;
export const chunkSchema = z.object({
  runId: idSchema, generation: z.number().int().positive(), artifact: artifactSchema,
  index: z.number().int().min(0), sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type Chunk = z.infer<typeof chunkSchema>;
export function checkpoint(s: Session): Completion["checkpoint"] {
  return { codexThreadId: s.codexThreadId, workspaceVolume: s.workspaceVolume, stateVolume: s.stateVolume,
    initialized: s.initialized, baseCommit: s.baseCommit, branch: s.branch };
}
export function terminal(state: RunState): boolean { return ["completed", "failed", "stopped"].includes(state); }
export function safeEvent(event: RunEvent): RunEvent { return eventSchema.parse(event); }
