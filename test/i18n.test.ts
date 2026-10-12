import test from "node:test";
import assert from "node:assert/strict";
import { Router, command } from "../src/router.js";
import { toCard } from "../src/feishu.js";
import { configSchema } from "../src/config.js";
import { setLocale } from "../src/i18n.js";
import { testEnvironment, message, FakeRunner } from "./helpers.js";

const english = async (fn: () => Promise<void> | void) => {
  setLocale("en");
  try { await fn(); } finally { setLocale("zh"); }
};

test("locale defaults to English in new configs", () => {
  const config = configSchema.parse({ tenantId: "t", allowedChats: ["c"], allowedMembers: ["m"],
    provider: { baseUrl: "https://api.example.org/v1", model: "x" } });
  assert.equal(config.locale, "en");
});

test("English commands need a boundary, like the Chinese ones", () => {
  assert.deepEqual(command("execute: add import"), { type: "execute", text: "add import" });
  assert.deepEqual(command("please execute add import"), { type: "execute", text: "add import" });
  assert.equal(command("stop").type, "stop");
  assert.equal(command("STOP").type, "stop");
  assert.equal(command("accept").type, "accept");
  assert.deepEqual(command("send back: needs tests"), { type: "reject", text: "needs tests" });
  assert.equal(command("status").type, "status");
  assert.equal(command("executed yesterday, explain why").type, "discuss");
  assert.equal(command("how do I execute this?").type, "discuss");
});

test("cards speak the configured language", () => english(() => {
  const card = toCard("body", { title: "Running · Task 1", template: "blue" },
    { scope: "topic", target: "s", models: [{ id: "m", label: "M" }], model: "m", effort: "medium", stop: true, review: true });
  for (const label of ["Model", "Effort", "Medium", "Stop", "Accept", "Send back", "Feedback (if sending back)"])
    assert.ok(card.includes(`"${label}"`), label);
  assert.ok(!/[一-龥]/.test(card), "no Chinese left on an English card");
}));

test("an English team gets English acknowledgements, and plain stop works", () => english(async () => {
  const env = testEnvironment(), runner = new FakeRunner(), router = new Router(env.config, env.store, runner);
  try {
    await router.handle(message({ messageId: "root", text: "execute fix the import" }));
    assert.equal(env.store.jobs()[0]!.mode, "execute");
    const ack = env.store.outbox().find(e => e.purpose === "acknowledgement")!;
    assert.match(ack.text ?? "", /^Got it\. Authorized to change code/);
    assert.ok(!/[一-龥]/.test(ack.text ?? ""), ack.text);
    await router.handle(message({ rootId: "root", text: "stop" }));
    assert.equal(runner.stops.length, 1);
  } finally { env.close(); }
}));
