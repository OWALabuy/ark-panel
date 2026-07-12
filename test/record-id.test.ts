import test from "node:test";
import assert from "node:assert/strict";
import { externalRecordId } from "../src/domain/record-id.js";

test("外部 recordId 可重建且按 agent 和类型隔离", () => {
  assert.equal(externalRecordId("claude", "active", "abc"), externalRecordId("claude", "active", "abc"));
  assert.notEqual(externalRecordId("claude", "active", "abc"), externalRecordId("main", "active", "abc"));
  assert.notEqual(externalRecordId("claude", "active", "abc"), externalRecordId("claude", "reset", "abc"));
});
