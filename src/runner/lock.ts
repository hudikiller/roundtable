import { mkdirSync, openSync, readFileSync, writeFileSync, closeSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { L } from "../i18n.js";

export function nodeLock(dir: string): () => void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "runner.lock");
  let fd: number;
  try { fd = openSync(path, "wx", 0o600); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const pid = Number(readFileSync(path, "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(L("节点锁无效，先核对现有进程", "Invalid node lock; check the existing process first"));
    try { process.kill(pid, 0); throw new Error(L("本节点Runner已经运行，拒绝重复启动及清理其任务", "The Runner on this node is already running; refusing to start a second one or clean up its tasks")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      unlinkSync(path); fd = openSync(path, "wx", 0o600);
    }
  }
  writeFileSync(fd, String(process.pid));
  return () => { closeSync(fd); if (readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path); };
}
