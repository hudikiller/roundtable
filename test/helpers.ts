import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, Runner, Messenger, Session, Job, RunResult, RunEvent } from "../src/types.js";
import { Store } from "../src/store.js";
import { configSchema } from "../src/config.js";

export function testEnvironment() {
  const dir = mkdtempSync(join(tmpdir(), "feishu-codex-test-"));
  const config = configSchema.parse({
    tenantId: "tenant", allowedChats: ["chat"], allowedMembers: ["alice", "bob"], leaders: ["alice"],
    receiveBackground: true, provider: { baseUrl: "https://api.example.org/v1", model: "test" },
    repositories: [{ id: "fixture", path: dir }], defaultRepo: "fixture", dataDir: dir,
  });
  const store = new Store(join(dir, "test.sqlite"));
  return { dir, config, store, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
let sequence = 0;
export function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return { tenantId: "tenant", chatId: "chat", messageId: `msg-${++sequence}`, senderId: "alice",
    senderName: "Alice", senderType: "user", text: "解释当前任务", mentions: [],
    mentionedBot: true, createdAt: Date.now(), ...overrides };
}
export class FakeRunner implements Runner {
  calls: { session: Session; job: Job }[] = [];
  stops: string[] = [];
  steers: { sessionId: string; jobId: string; text: string }[] = [];
  result: RunResult = { status: "completed", text: "完成", events: [] };
  gates: (() => void)[] = [];
  gated = false;
  async run(session: Session, job: Job, onEvent?: (e: RunEvent) => void): Promise<RunResult> {
    this.calls.push({ session, job });
    if (this.gated) await new Promise<void>(resolve => this.gates.push(resolve));
    for (const event of this.result.events) onEvent?.(event);
    return this.result;
  }
  async stop(id: string): Promise<void> { this.stops.push(id); this.gates.splice(0).forEach(fn => fn()); }
  async steer(sessionId: string, jobId: string, text: string): Promise<{ turnId: string }> {
    this.steers.push({ sessionId, jobId, text }); return { turnId: "fake-active-turn" };
  }
  async artifacts(): Promise<undefined> { return undefined; }
  async close(): Promise<void> { this.gates.splice(0).forEach(fn => fn()); }
}
export const messenger: Messenger = { async reply(entry) { return { messageId: `sent-${entry.id}` }; } };
export async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("test condition timeout");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
