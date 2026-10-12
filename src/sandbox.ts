import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import type { AppConfig, Secrets } from "./config.js";
import type { Job, Session, Runner, RunEvent, RunResult } from "./types.js";
import { CodexHarness } from "./codex.js";
import { checked, exec } from "./process.js";
import { errorText, redact } from "./log.js";
import { ContainerTermination } from "./container-termination.js";
import { SteeringError } from "./types.js";
import { memoryArgs } from "./container-resources.js";
import { writeDurableFile } from "./durable-file.js";
import { L } from "./i18n.js";

interface Active {
  sessionId: string; jobId: string; cancelled: boolean; container: string; network: string;
  proxy: string; harness?: CodexHarness; child?: ChildProcessWithoutNullStreams;
  finished: Promise<void>; finish: () => void;
  labels: string[]; runId?: string; generation?: number;
}
const label = ["--label", "app=feishu-codex"];
const limits = ["--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
  "--user", "1000:1000", "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m", "--init"];

export class Sandbox implements Runner {
  private active = new Map<string, Active>();
  private termination: ContainerTermination;
  constructor(readonly config: AppConfig, private secrets: Secrets) {
    this.termination = new ContainerTermination((_cmd, args, options) => this.dockerExec(args, options));
  }
  private get labels(): string[] {
    return this.config.sandbox.nodeId ? ["--label", "app=feishu-codex-runner-v1", "--label", `node=${this.config.sandbox.nodeId}`] : label;
  }
  private dockerArgs(args: string[]): string[] {
    return this.config.sandbox.dockerContext ? ["--context", this.config.sandbox.dockerContext, ...args] : args;
  }
  private dockerChecked(args: string[], options?: Parameters<typeof checked>[2]): Promise<Buffer> {
    return checked("docker", this.dockerArgs(args), options);
  }
  private dockerExec(args: string[], options?: Parameters<typeof exec>[2]): ReturnType<typeof exec> {
    return exec("docker", this.dockerArgs(args), options);
  }
  private runLabels(job: Job): string[] {
    return [...this.labels, ...(job.runId ? ["--label", `run=${job.runId}`, "--label", `generation=${job.generation}`] : [])];
  }
  private suffix(job: Job): string {
    return this.config.sandbox.nodeId
      ? `${this.config.sandbox.nodeId.slice(0, 8)}-${(job.runId ?? job.id).replaceAll("-", "")}-g${job.generation ?? 1}`
      : job.id.replaceAll("-", "");
  }
  async initialize(session: Session, mode: Job["mode"], active?: Active): Promise<void> {
    for (const name of [session.workspaceVolume, session.stateVolume])
      await this.dockerChecked(["volume", "create", ...this.labels, "--label", `session=${session.id}`, name]);
    // Node orchestration may prepare an approved snapshot for discussion; the
    // model still receives a read-only mount. A doctor without a project stays blank.
    if (session.initialized || (mode !== "execute" && (!this.config.sandbox.nodeId || !session.repoId))) return;
    const repository = this.config.repositories.find(r => r.id === session.repoId);
    if (!repository) throw new Error(L("指定仓库不在允许列表中", "Repository is not on the allowed list"));
    const base = (await checked("git", ["-C", repository.path, "rev-parse", `${repository.ref}^{commit}`])).toString().trim();
    const tmp = join(this.config.dataDir, "tmp");
    await mkdir(tmp, { recursive: true, mode: 0o700 });
    const bundlePath = join(tmp, `${randomUUID()}.bundle`);
    try {
      await checked("git", ["-C", repository.path, "bundle", "create", bundlePath, repository.ref], { timeout: 60_000 });
      const bundle = await readFile(bundlePath);
      if (bundle.length > 256 * 1024 * 1024) throw new Error(L("仓库 bundle 超过首版 256 MiB 导入上限", "Repository bundle exceeds the 256 MiB import limit"));
      const name = active ? `${active.container}-init` : `fc-init-${session.id.replaceAll("-", "")}`;
      if (active) { active.container = name; this.checkCancelled(active); }
      session.branch ??= `task-${session.id}`;
      await this.dockerChecked(["run", "--pull=never", "--rm", "-i", "--name", name, ...(active?.labels ?? this.labels),
        "--label", `session=${session.id}`, ...limits, "--network", "none",
        "--cpus", String(this.config.sandbox.cpus), ...memoryArgs(this.config.sandbox.memoryMiB),
        "--pids-limit", String(this.config.sandbox.pids),
        "--mount", `type=volume,src=${session.workspaceVolume},dst=/workspace`,
        "-e", `TASK_BRANCH=${session.branch}`,
        this.config.sandbox.image, "sh", "-c",
        'cat > /tmp/source.bundle && git clone /tmp/source.bundle /tmp/source && cp -a /tmp/source/. /workspace/ && git -C /workspace remote remove origin && git -C /workspace config user.name "Feishu Codex" && git -C /workspace config user.email "bot@localhost" && git -C /workspace checkout -b "$TASK_BRANCH"'],
        { input: bundle, timeout: 90_000 });
      session.baseCommit = base;
      session.initialized = true;
    } finally { await rm(bundlePath, { force: true }); }
  }
  private checkCancelled(a: Active): void { if (a.cancelled) throw new Error(L("任务已停止", "Task stopped")); }
  private runtimeArgs(session: Session, job: Job, a: Active): string[] {
    return ["run", "--pull=never", "-i", "--name", a.container, ...a.labels, "--label", `session=${session.id}`,
      "--label", `job=${job.id}`, ...limits, "--cpus", String(this.config.sandbox.cpus),
      ...memoryArgs(this.config.sandbox.memoryMiB),
      "--pids-limit", String(this.config.sandbox.pids), "--network", a.network,
      "--mount", `type=volume,src=${session.workspaceVolume},dst=/workspace${job.mode === "discuss" ? ",readonly" : ""}`,
      "--mount", `type=volume,src=${session.stateVolume},dst=/codex`,
      "-e", "CODEX_MODEL_API_KEY", "-e", `CODEX_MODEL=${this.config.provider.model}`,
      "-e", `CODEX_BASE_URL=${this.config.provider.baseUrl}`,
      "-e", "HTTPS_PROXY=http://egress:3128", "-e", "HTTP_PROXY=http://egress:3128",
      "-e", "ALL_PROXY=http://egress:3128", "-e", "NO_PROXY=",
      this.config.sandbox.image];
  }
  async run(session: Session, job: Job, onEvent: (e: RunEvent) => void): Promise<RunResult> {
    const suffix = this.suffix(job);
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const a: Active = { sessionId: session.id, jobId: job.id, cancelled: false,
      container: `fc-task-${suffix}`, network: `fc-net-${suffix}`, proxy: `fc-egress-${suffix}`, finished, finish,
      labels: this.runLabels(job), runId: job.runId, generation: job.generation };
    this.active.set(session.id, a);
    let watchdog: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let stopReason: string | undefined;
    let monitoring = false;
    let final: RunResult = { status: "failed", text: "", events: [] };
    try {
      await this.initialize(session, job.mode, a);
      a.container = `fc-task-${suffix}`;
      this.checkCancelled(a);
      await this.dockerChecked(["network", "create", "--internal", ...a.labels, a.network]);
      const hosts = [...new Set([new URL(this.config.provider.baseUrl).hostname, ...this.config.sandbox.egressHosts])];
      await this.dockerChecked(["run", "--pull=never", "-d", "--name", a.proxy, ...a.labels,
        "--label", `session=${session.id}`, ...limits,
        "--cpus", "0.25", ...memoryArgs(128), "--pids-limit", "32", "--network", "bridge",
        "-e", `ALLOWED_HOSTS=${JSON.stringify(hosts)}`,
        "-e", `PINNED_ADDRESSES=${JSON.stringify(this.config.sandbox.egressAddresses ?? {})}`,
        this.config.sandbox.image, "node", "/app/proxy.mjs"]);
      await this.dockerChecked(["network", "connect", "--alias", "egress", a.network, a.proxy]);
      this.checkCancelled(a);
      const repository = this.config.repositories.find(r => r.id === session.repoId);
      if (repository && session.initialized) {
        const hook = (session as Session & { hooksReady?: boolean }).hooksReady ? repository.resume : repository.initialize;
        if (hook) {
          a.container = `fc-hook-${suffix}`;
          await this.dockerChecked(["run", "--pull=never", "--rm", "--name", a.container, ...a.labels, "--label", `session=${session.id}`,
            ...limits, "--network", a.network, "--cpus", String(this.config.sandbox.cpus),
            ...memoryArgs(this.config.sandbox.memoryMiB), "--pids-limit", String(this.config.sandbox.pids),
            "--mount", `type=volume,src=${session.workspaceVolume},dst=/workspace`,
            "-e", "HTTPS_PROXY=http://egress:3128", "-e", "HTTP_PROXY=http://egress:3128",
            "-e", "ALL_PROXY=http://egress:3128", "-e", "NO_PROXY=", this.config.sandbox.image, ...hook.argv],
          { timeout: this.config.sandbox.timeoutSeconds * 1000 });
        }
        (session as Session & { hooksReady?: boolean }).hooksReady = true;
        a.container = `fc-task-${suffix}`;
      }
      if (job.files?.length) await this.writeFiles(session, job, a);
      // Deliberately minimal child environment; no Feishu/GitHub/host Codex configuration.
      a.child = spawn("docker", this.dockerArgs(this.runtimeArgs(session, job, a)), {
        stdio: "pipe", env: { PATH: process.env.PATH, HOME: process.env.HOME,
          CODEX_MODEL_API_KEY: this.secrets.modelKey },
      });
      a.harness = new CodexHarness(a.child);
      timeout = setTimeout(() => {
        stopReason = L("任务超过时长限制", "Task exceeded its time limit");
        void this.stop(session.id).catch(() => {});
      }, this.config.sandbox.timeoutSeconds * 1000);
      watchdog = setInterval(() => {
        if (monitoring || a.cancelled) return;
        monitoring = true;
        void this.dockerExec(["exec", a.container, "du", "-sk", "/workspace", "/codex"], { timeout: 5000 })
          .then(result => {
            if (result.code !== 0) return;
            const totalKiB = result.stdout.toString().trim().split("\n").reduce((sum, line) => sum + Number(line.split(/\s/)[0] || 0), 0);
            if (totalKiB > this.config.sandbox.diskMiB * 1024) {
              stopReason = L("工作区与 Codex 状态超过磁盘预算（监测限额）", "Workspace and Codex state exceeded the disk budget (monitored limit)");
              void this.stop(session.id).catch(() => {});
            }
          }).finally(() => { monitoring = false; });
      }, 2000);
      const result = await a.harness.run(session, job, job.model ?? this.config.provider.model, onEvent);
      final = result;
      if (a.cancelled || stopReason) { result.status = "interrupted"; result.error = stopReason; }
      if (result.status === "completed" && job.mode === "execute") {
        // Kill the model container and all its children before trusted checks.
        a.harness.close();
        await this.removeContainer(a.container);
        this.checkCancelled(a);
        const checks = await this.checks(session, job, a, onEvent);
        result.events.push(...checks);
        if (a.cancelled || stopReason) { result.status = "interrupted"; result.error = stopReason; }
      }
      return result;
    } catch (e) {
      const snapshot = a.harness?.snapshot();
      final = { status: a.cancelled ? "interrupted" : "failed", text: snapshot?.text ?? final.text,
        events: snapshot?.events ?? final.events, error: stopReason ?? errorText(e) };
      return final;
    } finally {
      if (watchdog) clearInterval(watchdog);
      if (timeout) clearTimeout(timeout);
      a.harness?.close();
      try { await this.cleanup(a); }
      catch (e) {
        final.status = "failed";
        final.cleanupFailed = true;
        final.error = L(`${final.error ? final.error + "；" : ""}资源终止未确认：${errorText(e)}`, `${final.error ? final.error + "; " : ""}Resource termination not confirmed: ${errorText(e)}`);
      } finally { this.active.delete(session.id); a.finish(); }
    }
  }
  /** Write orchestrator-provided reference files (e.g. the group's full record) before the model starts. */
  private async writeFiles(session: Session, job: Job, a: Active): Promise<void> {
    for (const [index, file] of (job.files ?? []).entries()) {
      if (!/^\.group\/[a-zA-Z0-9_.-]{1,80}$/.test(file.path) || file.path.includes(".."))
        throw new Error(L("拒绝写入工作区外或未批准的参考文件路径", "Refusing to write a reference file outside the workspace or to an unapproved path"));
      const content = Buffer.from(file.content, "utf8");
      if (content.length > 6 * 1024 * 1024) throw new Error(L("参考文件超过 6 MiB 上限", "Reference file exceeds the 6 MiB limit"));
      this.checkCancelled(a);
      a.container = `fc-files-${this.suffix(job)}-${index}`;
      await this.dockerChecked(["run", "--pull=never", "--rm", "-i", "--name", a.container, ...a.labels,
        "--label", `session=${session.id}`, ...limits, "--network", "none", ...memoryArgs(256), "--cpus", "1", "--pids-limit", "32",
        "--mount", `type=volume,src=${session.workspaceVolume},dst=/workspace`,
        "-e", `TARGET=/workspace/${file.path}`, this.config.sandbox.image, "sh", "-c",
        'mkdir -p "$(dirname "$TARGET")" && cat > "$TARGET.tmp" && mv "$TARGET.tmp" "$TARGET"'], { input: content, timeout: 60_000 });
    }
    a.container = `fc-task-${this.suffix(job)}`;
  }
  private async removeContainer(name: string): Promise<void> {
    await this.termination.remove(name);
  }
  private async cleanup(a: Active): Promise<void> {
    await this.removeContainer(a.container);
    await this.removeContainer(a.proxy);
    const result = await this.dockerExec(["network", "rm", a.network]);
    if (result.code !== 0 && !result.stderr.includes("not found")) throw new Error(L("任务网络清理失败", "Task network cleanup failed"));
  }
  async stop(sessionId: string): Promise<void> {
    const a = this.active.get(sessionId);
    if (!a) {
      const ids = (await this.dockerChecked(["ps", "-aq", "--filter",
        `label=app=${this.config.sandbox.nodeId ? "feishu-codex-runner-v1" : "feishu-codex"}`,
        ...(this.config.sandbox.nodeId ? ["--filter", `label=node=${this.config.sandbox.nodeId}`] : []),
        "--filter", `label=session=${sessionId}`])).toString().trim().split(/\s+/).filter(Boolean);
      for (const id of ids) await this.removeContainer(id);
      return;
    }
    a.cancelled = true;
    try {
      await Promise.race([a.harness?.interrupt(), new Promise<void>(resolve => setTimeout(resolve, 2000))]);
    } catch { /* Forced container termination follows. */ }
    await this.removeContainer(a.container);
    a.child?.kill("SIGTERM");
    let deadline: NodeJS.Timeout | undefined;
    try {
      await Promise.race([a.finished, new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error(L("停止尚未确认，任务初始化或清理仍未退出", "Stop not confirmed yet: task initialization or cleanup has not exited"))), 15_000);
      })]);
    } finally { if (deadline) clearTimeout(deadline); }
  }
  async steer(sessionId: string, jobId: string, text: string): Promise<{ turnId: string }> {
    const active = this.active.get(sessionId);
    if (!active || active.jobId !== jobId || active.cancelled || !active.harness)
      throw new SteeringError(L("指定回合已结束、尚在初始化或已被停止", "That turn has ended, is still initializing, or was stopped"), "rejected");
    return active.harness.steer(text);
  }
  turnId(sessionId: string): string | undefined { return this.active.get(sessionId)?.harness?.activeTurnId; }
  async stopGeneration(sessionId: string, runId: string, generation: number): Promise<void> {
    const a = this.active.get(sessionId);
    if (a && a.runId === runId && a.generation === generation) return this.stop(sessionId);
    const ids = (await this.dockerChecked(["ps", "-aq", "--filter", "label=app=feishu-codex-runner-v1",
      "--filter", `label=node=${this.config.sandbox.nodeId}`, "--filter", `label=run=${runId}`,
      "--filter", `label=generation=${generation}`])).toString().trim().split(/\s+/).filter(Boolean);
    for (const id of ids) await this.removeContainer(id);
    const networks = (await this.dockerChecked(["network", "ls", "-q", "--filter", "label=app=feishu-codex-runner-v1",
      "--filter", `label=node=${this.config.sandbox.nodeId}`, "--filter", `label=run=${runId}`,
      "--filter", `label=generation=${generation}`])).toString().trim().split(/\s+/).filter(Boolean);
    for (const id of networks) {
      const result = await this.dockerExec(["network", "rm", id]);
      if (result.code !== 0 && !/not found|No such network/i.test(result.stderr)) throw new Error(L("旧代次网络清理未确认", "Cleanup of the previous generation's network not confirmed"));
    }
  }
  async deleteWorkspace(session: Session): Promise<void> {
    if (this.active.has(session.id)) throw new Error(L("任务仍在执行，拒绝删除", "Task is still running; refusing to delete"));
    for (const name of [session.workspaceVolume, session.stateVolume]) {
      const result = await this.dockerExec(["volume", "rm", name]);
      if (result.code !== 0 && !/no such volume/i.test(result.stderr)) throw new Error(L("工作区删除未确认", "Workspace deletion not confirmed"));
    }
  }
  private async helper(session: Session, argv: string[], maxBytes = 64 * 1024 * 1024, job?: Job): Promise<Buffer> {
    return this.dockerChecked(["run", "--pull=never", "--rm", ...(job ? this.runLabels(job) : this.labels), ...limits, "--network", "none",
      ...memoryArgs(512), "--cpus", String(this.config.sandbox.cpus), "--pids-limit", "64",
      "--mount", `type=volume,src=${session.workspaceVolume},dst=/workspace,readonly`,
      this.config.sandbox.image, ...argv], { timeout: 30_000, maxBytes });
  }
  async artifacts(session: Session, job: Job, result: RunResult): Promise<string | undefined> {
    if (job.mode !== "execute" || !session.initialized || !session.baseCommit) return;
    const dir = join(this.config.dataDir, "artifacts", job.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const patch = await this.helper(session, ["git", "-C", "/workspace", "diff", "--binary", session.baseCommit], undefined, job);
    const names = (await this.helper(session, ["git", "-C", "/workspace", "ls-files", "--others", "--exclude-standard", "-z"], undefined, job)).toString().split("\0").filter(Boolean);
    const files: Record<string, Uint8Array> = {};
    const valid = (path: string) => !path.startsWith("/") && !path.split("/").includes("..") &&
      !path.split("/").some(p => p === ".git" || p.startsWith(".env")) && !/\.(pem|key)$/i.test(path);
    let size = patch.length;
    const safeBuffer = (buffer: Buffer): Buffer => {
      for (const secret of [this.secrets.modelKey, this.secrets.appSecret, this.config.provider.baseUrl])
        if (secret && buffer.includes(Buffer.from(secret))) throw new Error(L("成果包含服务凭据，已阻止打包和投递", "Result contains service credentials; packaging and delivery blocked"));
      return buffer;
    };
    files["changes.patch"] = safeBuffer(patch);
    for (const path of names) {
      if (!valid(path)) continue;
      // -f rejects symlinks; fs.readFile itself follows symlinks, so lstat first.
      const contents = await this.helper(session, ["node", "-e",
        'const fs=require("fs");const p=process.argv[1];if(!fs.lstatSync(p).isFile())process.exit(2);process.stdout.write(fs.readFileSync(p));', `/workspace/${path}`], 8 * 1024 * 1024, job);
      size += contents.length;
      if (size > 24 * 1024 * 1024) throw new Error(L("成果超过首版 24 MiB 附件预算；已保留工作区，未截断冒充完整成果", "Result exceeds the 24 MiB attachment budget; workspace kept, nothing truncated or passed off as complete"));
      files[`new-files/${path}`] = safeBuffer(contents);
    }
    const manifest = { jobId: job.id, sessionId: session.id, baseCommit: session.baseCommit,
      modelStatus: result.status, checks: result.events.filter(e => e.type === "command"),
      fileEvents: result.events.filter(e => e.type === "files"),
      newFiles: names.filter(valid), diffSha256: createHash("sha256").update(patch).digest("hex"),
      testSummary: job.testSummary ?? L("未记录固定检查", "No fixed checks recorded"), createdAt: new Date().toISOString() };
    files["result.json"] = strToU8(redact(JSON.stringify(manifest, null, 2)));
    files["answer.txt"] = strToU8(redact(result.text));
    const path = join(dir, "result.zip");
    const zipped = zipSync(files);
    if (zipped.byteLength > 24 * 1024 * 1024) throw new Error(L("完整成果超过24MiB；工作区保留", "Full result exceeds 24 MiB; workspace kept"));
    writeDurableFile(path, zipped, this.config.dataDir);
    writeDurableFile(join(dir, "changes.patch"), patch, this.config.dataDir);
    return path;
  }
  async checks(session: Session, job: Job, active?: Active, onEvent?: (e: RunEvent) => void): Promise<RunEvent[]> {
    if (job.mode !== "execute" || !session.initialized) return [];
    const repository = this.config.repositories.find(r => r.id === session.repoId);
    const events: RunEvent[] = [];
    for (const [index, argv] of (repository?.checks ?? []).entries()) {
      if (active) this.checkCancelled(active);
      onEvent?.({ type: "activity", kind: "checks", summary: argv.join(" ") });
      const name = `fc-check-${this.suffix(job)}-${index}`;
      if (active) active.container = name;
      let result: { stdout: Buffer; stderr: string; code: number };
      try { result = await this.dockerExec(["run", "--pull=never", "--rm", "--name", name, ...this.runLabels(job),
        "--label", `session=${session.id}`, ...limits, "--network", "none",
        "--cpus", String(this.config.sandbox.cpus), ...memoryArgs(this.config.sandbox.memoryMiB),
        "--pids-limit", String(this.config.sandbox.pids),
        "--mount", `type=volume,src=${session.workspaceVolume},dst=/workspace`,
        "--mount", `type=volume,src=${session.stateVolume},dst=/codex,readonly`,
        this.config.sandbox.image, ...argv], { timeout: 120_000, maxBytes: 2 * 1024 * 1024 }); }
      catch (e) {
        await this.removeContainer(name);
        result = { stdout: Buffer.alloc(0), stderr: errorText(e), code: -1 };
      }
      const event: RunEvent = { type: "command", id: `check-${job.id}-${index}`, command: argv.join(" "),
        status: result.code === 0 ? "completed" : "failed", exitCode: result.code,
        output: redact(result.stdout.toString() + result.stderr).slice(-32_000) };
      events.push(event); onEvent?.(event);
      if (active?.cancelled) break;
    }
    return events;
  }
  async cleanupOrphans(): Promise<void> {
    if (this.config.sandbox.nodeId) throw new Error(L("Runner只能按回合代次清理，禁止bulk cleanup", "Runner may only clean up per turn generation; bulk cleanup is not allowed"));
    const ids = (await this.dockerChecked(["ps", "-aq", "--filter", "label=app=feishu-codex"])).toString().trim().split(/\s+/).filter(Boolean);
    for (const id of ids) await this.removeContainer(id);
    const networks = (await this.dockerChecked(["network", "ls", "-q", "--filter", "label=app=feishu-codex"])).toString().trim().split(/\s+/).filter(Boolean);
    for (const id of networks) await this.dockerExec(["network", "rm", id]);
  }
  async close(): Promise<void> {
    await Promise.all([...this.active.keys()].map(id => this.stop(id)));
  }
}
