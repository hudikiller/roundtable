import { mkdirSync, openSync, readFileSync, writeFileSync, closeSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export function nodeLock(dir: string): () => void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "runner.lock");
  let fd: number;
  try { fd = openSync(path, "wx", 0o600); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const pid = Number(readFileSync(path, "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("节点锁无效，先核对现有进程");
    try { process.kill(pid, 0); throw new Error("本节点Runner已经运行，拒绝重复启动及清理其任务"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      unlinkSync(path); fd = openSync(path, "wx", 0o600);
    }
  }
  writeFileSync(fd, String(process.pid));
  return () => { closeSync(fd); if (readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path); };
}
