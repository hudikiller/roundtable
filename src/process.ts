import { spawn } from "node:child_process";

export async function exec(command: string, args: string[], options: {
  input?: Buffer | string; timeout?: number; maxBytes?: number; cwd?: string;
} = {}): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: "pipe" });
    const out: Buffer[] = [], errors: Buffer[] = [];
    let bytes = 0, timedOut = false, oversized = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeout ?? 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 64 * 1024 * 1024)) { oversized = true; child.kill("SIGKILL"); }
      else out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errors.reduce((n, c) => n + c.length, 0) < 64_000) errors.push(chunk);
    });
    child.stdin.on("error", () => {});
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      const stderr = Buffer.concat(errors).toString();
      if (timedOut || oversized) return reject(new Error(timedOut ? `${command} 超时` : `${command} 输出超过上限`));
      resolve({ stdout: Buffer.concat(out), stderr, code: code ?? -1 });
    });
    child.stdin.end(options.input);
  });
}
export async function checked(command: string, args: string[], options?: Parameters<typeof exec>[2]): Promise<Buffer> {
  const result = await exec(command, args, options);
  if (result.code !== 0) throw new Error(`${command} 失败 (${result.code}): ${result.stderr.slice(-2000)}`);
  return result.stdout;
}
