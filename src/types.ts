export type JobMode = "discuss" | "execute";
export type JobStatus =
  | "queued" | "running" | "completed" | "failed" | "stopped" | "needs_recovery";
export type OutboxStatus = "pending" | "sending" | "sent" | "uncertain" | "failed";

export interface IncomingMessage {
  tenantId: string;
  chatId: string;
  messageId: string;
  senderId: string;
  senderName: string;
  senderType: "user" | "bot";
  text: string;
  mentionedBot: boolean;
  mentions: { id: string; key?: string; name?: string }[];
  rootId?: string;
  threadId?: string;
  replyToMessageId?: string;
  createdAt: number;
  resources?: { type: "image" | "file" | "audio" | "video" | "sticker"; fileKey: string; fileName?: string }[];
}

export interface Session {
  id: string;
  tenantId: string;
  chatId: string;
  rootMessageId: string;
  initiatorId: string;
  initiatorName?: string;
  codexThreadId?: string;
  workspaceVolume: string;
  stateVolume: string;
  repoId?: string;
  baseCommit?: string;
  initialized: boolean;
  review: "open" | "accepted" | "rejected";
  createdAt: number;
  runnerId?: string;
  projectAlias?: string;
  workspaceId?: string;
  profileVersion?: string;
  branch?: string;
  collaborators?: string[];
  archived?: boolean;
  workspaceDeleted?: boolean;
  workspaceAction?: "archive_pending" | "delete_pending";
  pendingNodeRequest?: { message: IncomingMessage; mode: JobMode; text: string; flags?: JobFlags };
  /** "group" marks the long-lived main-group session; topic sessions leave it unset. */
  kind?: "group";
  /** First answer the group agent gave in this topic, carried into the topic's first own turn. */
  seedContext?: string;
  /** Short human title of the task (assignment title or first request), used to route hand-offs. */
  title?: string;
  /** Model and reasoning effort chosen for this topic; group and Bridge defaults apply when unset. */
  model?: string;
  effort?: string;
  /** Quiet topic: only explicit @ messages continue it (Claude Tag "quiet a thread"). */
  quiet?: boolean;
}

export interface JobFlags {
  deliverAsMarkdown: boolean; contextScope?: "chat"; readAttachments: boolean;
  attachmentKinds: ("image" | "file")[]; attachmentOwnerOnly: boolean;
}

export interface Job {
  id: string;
  sessionId: string;
  messageId: string;
  senderId: string;
  mode: JobMode;
  prompt: string;
  deliverAsMarkdown?: boolean;
  referenceIds?: string[];
  contextScope?: "chat";
  readAttachments?: boolean;
  attachmentKind?: "image" | "file";
  attachmentKinds?: ("image" | "file")[];
  attachmentOwnerOnly?: boolean;
  resourceMessageIds?: string[];
  images?: { messageId: string; url: string }[];
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  response?: string;
  artifactPath?: string;
  testSummary?: string;
  modelStatus?: RunResult["status"];
  checksStatus?: "passed" | "failed" | "not_run";
  runId?: string;
  generation?: number;
  contextLoaded?: boolean;
  /** Group-agent turns answer in a topic: reply under this message and attribute delivery to that topic session. */
  replyTo?: string;
  topicSessionId?: string;
  /** Inbound rowid up to which the group feed was included; advanced when the turn completes. */
  feedCursor?: number;
  /** Small files the runner writes into the workspace before the model starts (attached at claim time). */
  files?: { path: string; content: string }[];
  /** Unprompted turn (proactive reply or hand-off): a final answer of NO_REPLY is not delivered. */
  unprompted?: boolean;
  /** JSON schema the final answer must follow (group turns), and whether web search is enabled. */
  outputSchema?: Record<string, unknown>;
  webSearch?: boolean;
  /** Model and reasoning effort for this turn; the Bridge fills its defaults at claim time. */
  model?: string;
  effort?: string;
}

export type RunEvent =
  | { type: "thread"; threadId: string }
  | { type: "turn"; turnId: string }
  | { type: "text"; text: string; final: boolean }
  | { type: "command"; id: string; command: string; exitCode: number | null; output: string; status: string }
  | { type: "files"; id: string; paths: string[]; status: string }
  | { type: "approvalDenied"; reason: string }
  | { type: "activity"; kind: "command" | "files" | "checks"; summary: string }
  | { type: "plan"; steps: { step: string; status: "pending" | "inProgress" | "completed" }[]; explanation?: string | null }
  | { type: "completed"; status: "completed" | "failed" | "interrupted"; error?: string };

export interface RunResult {
  status: "completed" | "failed" | "interrupted";
  text: string;
  events: RunEvent[];
  error?: string;
  cleanupFailed?: boolean;
}

export interface ReplyTarget {
  tenantId: string;
  chatId: string;
  messageId: string;
}

export interface OutboxEntry {
  id: string;
  sessionId?: string;
  jobId?: string;
  purpose?: "acknowledgement" | "result" | "artifact" | "control" | "reaction" | "post";
  /** Feishu emoji_type for purpose "reaction" (placed on target.messageId). */
  emoji?: string;
  /** For purpose "post": a new top-level message that becomes a task topic owned by this member. */
  post?: { initiatorId: string; title: string; request: string };
  /** Optional card header for text replies (rendered as a Feishu interactive card). */
  card?: { title: string; template: "green" | "red" | "grey" | "blue" | "orange" };
  /** Interactive controls on the card: model/effort pickers (topic or group scope) and task buttons. */
  controls?: CardControls;
  target: ReplyTarget;
  text?: string;
  filePath?: string;
  fileName?: string;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: number;
  sentMessageId?: string;
  error?: string;
}

export interface CardControls {
  scope: "topic" | "group";
  /** Topic session id (scope topic) or chat id (scope group). */
  target: string;
  models: { id: string; label: string }[];
  model?: string;
  effort?: string;
  stop?: boolean;
  review?: boolean;
}

export interface Messenger {
  reply(entry: OutboxEntry): Promise<{ messageId: string; rootId?: string; threadId?: string }>;
}

export interface LoadedContext {
  text: string;
  images: { messageId: string; url: string }[];
}

export interface Runner {
  run(session: Session, job: Job, onEvent: (event: RunEvent) => void): Promise<RunResult>;
  stop(sessionId: string): Promise<void>;
  steer?(sessionId: string, jobId: string, text: string): Promise<{ turnId: string }>;
  artifacts(session: Session, job: Job, result: RunResult): Promise<string | undefined>;
  close(): Promise<void>;
  readonly remote?: boolean;
  canDispatch?(session: Session, job: Job): boolean;
  reserve?(session: Session, job: Job): void;
  releaseReservation?(job: Job, reason: string): void;
  manage?(sessionId: string, action: "archive" | "delete"): Promise<void>;
}

export class SteeringError extends Error {
  constructor(message: string, readonly disposition: "rejected" | "uncertain") { super(message); }
}
