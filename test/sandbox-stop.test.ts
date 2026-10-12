import test from "node:test";
import assert from "node:assert/strict";
import { ContainerTermination, type DockerCommand } from "../src/container-termination.js";

test("并发停止共享删除结果，并等待Docker确认容器不存在", async () => {
  let removeRequests = 0, inspections = 0, gone = false;
  const daemon: DockerCommand = async (_command, argv) => {
    if (argv[0] === "rm") {
      removeRequests++;
      if (removeRequests > 1) return { code: 1, stdout: Buffer.alloc(0), stderr: "removal of container is already in progress" };
      return { code: 0, stdout: Buffer.from("fixture-container"), stderr: "" };
    }
    assert.equal(argv[0], "inspect");
    if (++inspections < 3) return { code: 0, stdout: Buffer.from("removing"), stderr: "" };
    gone = true;
    return { code: 1, stdout: Buffer.alloc(0), stderr: "Error: No such object: fixture-container" };
  };
  const termination = new ContainerTermination(daemon);
  await Promise.all([termination.remove("fixture-container"), termination.remove("fixture-container")]);
  assert.equal(gone, true, "Docker仍返回容器时不得确认停止");
  assert.equal(inspections, 3);
  assert.equal(removeRequests, 1);
});
