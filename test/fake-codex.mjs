import readline from "node:readline";
const send = msg => process.stdout.write(JSON.stringify(msg) + "\n");
let turnRequest, toolReply;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: {} });
  if (m.method === "thread/start" || m.method === "thread/resume")
    send({ id: m.id, result: { thread: { id: "thread-1" } } });
  if (m.method === "turn/start") {
    turnRequest = m;
    send({ id: m.id, result: { turn: { id: "turn-1" } } });
    send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
    send({ method: "turn/plan/updated", params: { threadId: "thread-1", turnId: "turn-1", explanation: null,
      plan: [{ step: "读取导入逻辑", status: "completed" }, { step: "补测试", status: "inProgress" }] } });
    send({ method: "item/started", params: { item: { id: "reason", type: "reasoning" } } });
    send({ method: "item/reasoning/textDelta", params: { delta: "NEVER_SEND_REASONING" } });
    send({ id: 800, method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1", callId: "c1", namespace: null,
      tool: "update_checklist", arguments: { steps: [{ step: "读取导入逻辑", status: "completed" }, { step: "补测试", status: "completed" }] } } });
    send({ id: 700, method: "item/commandExecution/requestApproval", params: { command: "outside-workspace" } });
  }
  if (m.id === 800) toolReply = m.result;
  if (m.id === 700 && m.result) {
    const decision = m.result.decision;
    const items = [
      { id: "command-1", type: "commandExecution", command: "pwd", status: "completed", exitCode: 0, aggregatedOutput: "/workspace\n" },
      { id: "answer-1", type: "agentMessage", phase: "final_answer", text: "完整最终回答", decision, toolReply },
    ];
    for (const item of items) send({ method: "item/completed", params: { item, threadId: "thread-1", turnId: "turn-1" } });
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items, error: null } } });
  }
  if (m.method === "turn/interrupt") send({ id: m.id, result: {} });
}
