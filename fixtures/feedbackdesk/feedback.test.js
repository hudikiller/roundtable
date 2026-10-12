import test from "node:test";
import assert from "node:assert/strict";
import { importFeedback } from "./feedback.js";

test("导入新反馈且不修改输入", () => {
  const existing = [{ id: "a", content: "原反馈" }];
  assert.deepEqual(importFeedback(existing, [{ id: "b", content: "新反馈" }]),
    [{ id: "a", content: "原反馈" }, { id: "b", content: "新反馈" }]);
  assert.deepEqual(existing, [{ id: "a", content: "原反馈" }]);
});
