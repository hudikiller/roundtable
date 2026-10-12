import readline from "node:readline";
const send = message => process.stdout.write(JSON.stringify(message) + "\n");
const finish = status => send({ method: "turn/completed", params: { threadId: "test-thread",
  turn: { id: "active-turn", status, items: [], error: null } } });
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "test-thread" } } });
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "active-turn" } } });
    send({ method: "turn/started", params: { threadId: "test-thread", turn: { id: "active-turn" } } });
    send({ method: "item/started", params: { threadId: "test-thread", turnId: "active-turn",
      item: { id: "command", type: "commandExecution", command: "sleep 30", status: "inProgress", exitCode: null } } });
  }
  if (message.method === "turn/steer") {
    if (process.argv[2] === "timeout") continue;
    if (process.argv[2] === "reject" || message.params.expectedTurnId !== "active-turn") {
      send({ id: message.id, error: { code: -32602, message: "expected turn mismatch" } }); continue;
    }
    send({ id: message.id, result: { turnId: "active-turn" } });
    send({ method: "item/completed", params: { item: { id: "answer", type: "agentMessage",
      phase: "final_answer", text: message.params.input[0].text } } });
    finish("completed");
  }
  if (message.method === "turn/interrupt") { send({ id: message.id, result: {} }); finish("interrupted"); }
}
