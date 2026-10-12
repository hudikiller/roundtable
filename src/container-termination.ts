import { exec } from "./process.js";

export type DockerCommand = typeof exec;

export class ContainerTermination {
  private removals = new Map<string, Promise<void>>();
  constructor(private command: DockerCommand = exec) {}
  async remove(name: string): Promise<void> {
    const existing = this.removals.get(name);
    if (existing) return existing;
    const removal = this.removeAndVerify(name);
    this.removals.set(name, removal);
    try { await removal; }
    finally { if (this.removals.get(name) === removal) this.removals.delete(name); }
  }
  private async removeAndVerify(name: string): Promise<void> {
    const result = await this.command("docker", ["rm", "-f", name], { timeout: 15_000 });
    if (result.code !== 0 && !result.stderr.includes("No such container") &&
        !/removal.*(?:already )?in progress/i.test(result.stderr))
      throw new Error(`容器终止未确认：${name}`);
    // Docker --rm and an explicit stop can overlap outside this process.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const inspect = await this.command("docker", ["inspect", "--format", "{{.State.Status}}", name], { timeout: 5000 });
      if (inspect.code !== 0 && /No such (?:object|container)/i.test(inspect.stderr)) return;
      if (inspect.code !== 0) throw new Error(`容器状态核对失败：${name}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`容器删除尚未完成：${name}`);
  }
}
