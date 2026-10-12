import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "../types.js";
import type { Assignment, Envelope, Completion, Control } from "./protocol.js";

export interface LocalRun {
  assignment?: Assignment; runId: string; generation: number;
  state: "intent" | "running" | "complete" | "uncertain";
  completion?: Completion; artifactPath?: string; quarantined?: boolean;
}
export class NodeJournal {
  readonly db: DatabaseSync;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
    const path = join(dir, "runner.sqlite");
    this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runs(id TEXT NOT NULL,generation INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(id,generation));
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(run TEXT NOT NULL,generation INTEGER NOT NULL,seq INTEGER NOT NULL,acked INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL,PRIMARY KEY(run,generation,seq));
      CREATE TABLE IF NOT EXISTS controls(id TEXT PRIMARY KEY,state TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks(run TEXT NOT NULL,generation INTEGER NOT NULL,part INTEGER NOT NULL,PRIMARY KEY(run,generation,part));`);
  }
  get(id: string, gen: number): LocalRun | undefined {
    const row = this.db.prepare("SELECT data FROM runs WHERE id=? AND generation=?").get(id, gen);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  runs(): LocalRun[] { return this.db.prepare("SELECT data FROM runs").all().map(r => JSON.parse(String(r.data))); }
  save(r: LocalRun): void {
    this.db.prepare("INSERT INTO runs VALUES(?,?,?) ON CONFLICT(id,generation) DO UPDATE SET data=excluded.data")
      .run(r.runId, r.generation, JSON.stringify(r));
  }
  begin(a: Assignment): boolean {
    if (this.get(a.runId, a.generation)) return false;
    this.save({ runId: a.runId, generation: a.generation, assignment: a, state: "intent" }); return true;
  }
  session(id: string): Session | undefined {
    const row = this.db.prepare("SELECT data FROM sessions WHERE id=?").get(id);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  saveSession(s: Session): void {
    this.db.prepare("INSERT INTO sessions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(s.id, JSON.stringify(s));
  }
  append(id: string, gen: number, payload: Envelope["payload"]): Envelope {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const seq = Number(this.db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM events WHERE run=? AND generation=?").get(id, gen)!.seq);
      const envelope: Envelope = { runId: id, generation: gen, seq, payload };
      this.db.prepare("INSERT INTO events(run,generation,seq,data) VALUES(?,?,?,?)").run(id, gen, seq, JSON.stringify(envelope));
      this.db.exec("COMMIT"); return envelope;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  complete(r: LocalRun): Envelope {
    if (!r.completion) throw new Error("缺少最终结果");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.save(r);
      const seq = Number(this.db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM events WHERE run=? AND generation=?").get(r.runId, r.generation)!.seq);
      const event: Envelope = { runId: r.runId, generation: r.generation, seq, payload: { kind: "result", completion: r.completion } };
      this.db.prepare("INSERT INTO events(run,generation,seq,data) VALUES(?,?,?,?)").run(r.runId, r.generation, seq, JSON.stringify(event));
      this.db.exec("COMMIT"); return event;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  completeControl(c: Control): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.saveControl(c, "complete");
      const seq = Number(this.db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM events WHERE run=? AND generation=?").get(c.runId, c.generation)!.seq);
      const e: Envelope = { runId: c.runId, generation: c.generation, seq, payload: { kind: "control", controlId: c.id,
        disposition: c.disposition!, error: c.error, turnId: c.turnId } };
      this.db.prepare("INSERT INTO events(run,generation,seq,data) VALUES(?,?,?,?)").run(c.runId, c.generation, seq, JSON.stringify(e));
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  pending(): Envelope | undefined {
    const row = this.db.prepare("SELECT data FROM events WHERE acked=0 ORDER BY rowid LIMIT 1").get();
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  ack(id: string, gen: number, seq: number, quarantined = false): void {
    this.db.prepare("UPDATE events SET acked=1 WHERE run=? AND generation=? AND seq<=?").run(id, gen, seq);
    if (quarantined) { const r = this.get(id, gen); if (r) { r.quarantined = true; this.save(r); } }
  }
  acknowledged(e: Envelope): boolean {
    return Number(this.db.prepare("SELECT acked FROM events WHERE run=? AND generation=? AND seq=?").get(e.runId, e.generation, e.seq)?.acked) === 1;
  }
  control(id: string): { state: string; control: Control } | undefined {
    const row = this.db.prepare("SELECT state,data FROM controls WHERE id=?").get(id);
    return row ? { state: String(row.state), control: JSON.parse(String(row.data)) } : undefined;
  }
  saveControl(c: Control, state: "intent" | "complete"): void {
    this.db.prepare("INSERT INTO controls VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data").run(c.id, state, JSON.stringify(c));
  }
  chunkAck(id: string, gen: number, part: number): void { this.db.prepare("INSERT OR IGNORE INTO chunks VALUES(?,?,?)").run(id, gen, part); }
  hasChunk(id: string, gen: number, part: number): boolean { return !!this.db.prepare("SELECT 1 FROM chunks WHERE run=? AND generation=? AND part=?").get(id, gen, part); }
  close(): void { this.db.close(); }
}
