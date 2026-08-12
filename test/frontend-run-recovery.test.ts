import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type RecoveryPolicy = {
  validStoredRun(value: unknown, key: string, runKey: (recordId: string) => string): boolean;
  retryableStoredCreation(run: Record<string, unknown>): boolean;
  missingRunAction(run: Record<string, unknown>, active: unknown): "watch" | "create" | "discard" | "retry";
  uncertainCreateError(error: unknown): boolean;
  acknowledgedStorageAction(run: { createPhase?: unknown; storageAvailable?: unknown }): "remove" | "keep";
  recoverPersistedRun(run: Record<string, unknown>, operations: {
    getRun(runId: string): Promise<unknown>;
    getActive(recordId: string): Promise<unknown>;
    create(): Promise<unknown>;
  }): Promise<{ action: "watch" | "created" | "discard" | "retry" | "failed"; snapshot?: unknown; error?: unknown; stage?: "observe" | "create" }>;
  inspectStoredRuns(entries: Array<{ key: string; raw: string | null }>, runKey: (recordId: string) => string): {
    runs: Record<string, unknown>[]; remove: string[];
  };
};

async function policy(): Promise<RecoveryPolicy> {
  return await import(pathToFileURL(join(process.cwd(), "src/frontend/run-recovery-policy.js")).href) as RecoveryPolicy;
}

const runId = "11111111-1111-4111-8111-111111111111";
const otherRunId = "22222222-2222-4222-8222-222222222222";
const recordId = "fixture-session";
const runKey = (value: string) => `ark-panel:run:v1:${encodeURIComponent(value)}`;
const payload = {
  runId,
  recordId,
  status: "accepted",
  submittedDraft: "fictional recovery message",
  submittedRevision: "fixture-revision",
  submittedAttachmentIds: [] as string[],
  submittedRequestOutputs: false
};

test("persisted run v1 accepts legacy and additive shapes but rejects corrupt state", async () => {
  const { validStoredRun } = await policy(), key = runKey(recordId);
  assert.equal(validStoredRun({ ...payload, status: undefined }, key, runKey), true, "legacy shape");
  for (const status of ["accepted", "running", "materializing", "committing", "committed", "aborting", "completed", "failed", "aborted"]) {
    assert.equal(validStoredRun({ ...payload, status, createPhase: "acknowledged" }, key, runKey), true, status);
  }
  for (const value of [
    null,
    [],
    { ...payload, runId: "not-a-run" },
    { ...payload, recordId: "other" },
    { ...payload, status: "unknown" },
    { ...payload, createPhase: "posted" },
    { ...payload, submittedDraft: 42 },
    { ...payload, submittedAttachmentIds: [42] },
    { ...payload, submittedRequestOutputs: "false" }
  ]) assert.equal(validStoredRun(value, key, runKey), false, JSON.stringify(value));
});

test("only complete provisional or legacy-unknown records may recreate after both 404 and no active run", async () => {
  const { missingRunAction, retryableStoredCreation } = await policy();
  for (const createPhase of ["provisional", undefined]) {
    const run = { ...payload, createPhase };
    assert.equal(retryableStoredCreation(run), true);
    assert.equal(missingRunAction(run, null), "create");
  }
  assert.equal(missingRunAction({ ...payload, status: "accepted", createPhase: "acknowledged" }, null), "discard");
  for (const status of ["running", "materializing", "committing", "committed", "aborting", "completed", "failed", "aborted"]) {
    assert.equal(missingRunAction({ ...payload, status, createPhase: "acknowledged" }, null), "discard", status);
  }
  for (const run of [
    { ...payload, createPhase: "acknowledged" },
    { ...payload, status: "running", createPhase: "acknowledged" },
    { ...payload, status: "completed", createPhase: "acknowledged" },
    { ...payload, createPhase: "provisional", submittedAttachmentIds: undefined },
    { ...payload, createPhase: "provisional", submittedRequestOutputs: undefined },
    { ...payload, createPhase: "provisional", submittedDraft: "" },
    { ...payload, createPhase: "provisional", storageAvailable: false }
  ]) {
    assert.equal(retryableStoredCreation(run), false, JSON.stringify(run));
    assert.equal(missingRunAction(run, null), "discard");
  }
  const active = { runId: otherRunId, recordId, status: "running" };
  assert.equal(missingRunAction({ ...payload, createPhase: "provisional" }, active), "watch");
  assert.equal(missingRunAction({ ...payload, createPhase: "provisional" }, { ...active, recordId: "other-session" }), "retry");
  assert.equal(missingRunAction({ ...payload, createPhase: "provisional" }, { ...active, runId: "invalid" }), "retry");
  for (const malformed of [undefined, false, 0, "", [], "null", { runId: otherRunId, recordId }]) {
    assert.equal(missingRunAction({ ...payload, createPhase: "provisional" }, malformed), "retry", JSON.stringify(malformed));
  }
});

test("network and server create ambiguity returns to observation before any retry", async () => {
  const { uncertainCreateError } = await policy();
  for (const error of [new TypeError("network unavailable"), { status: 500 }, { status: 503 }, { status: 408 }, { status: 429 }, { status: 409, code: "SESSION_BUSY" }]) {
    assert.equal(uncertainCreateError(error), true, JSON.stringify(error));
  }
  for (const error of [{ status: 400 }, { status: 404 }, { status: 409, code: "IDEMPOTENCY_KEY_REUSED" }]) {
    assert.equal(uncertainCreateError(error), false, JSON.stringify(error));
  }
});

test("recovery orchestration writes only after exact not-found and exact null active", async () => {
  const { recoverPersistedRun } = await policy();
  async function scenario(
    getRun: () => Promise<unknown>,
    getActive: () => Promise<unknown>,
    create: () => Promise<unknown> = async () => ({ ...payload, createPhase: "acknowledged" })
  ) {
    const calls: string[] = [], created = { ...payload, createPhase: "acknowledged" };
    const result = recoverPersistedRun({ ...payload, createPhase: "provisional" }, {
      async getRun() { calls.push("GET_RUN"); return getRun(); },
      async getActive() { calls.push("GET_ACTIVE"); return getActive(); },
      async create() { calls.push("POST"); return create(); }
    });
    return { calls, result };
  }

  for (const value of [{ ...payload, createPhase: "acknowledged" }, { ...payload, status: "running" }, { ...payload, status: "completed" }]) {
    const { calls, result } = await scenario(async () => value, async () => null);
    assert.equal((await result).action, "watch");
    assert.deepEqual(calls, ["GET_RUN"]);
  }
  for (const value of [{ ...payload, recordId: "other" }, { ...payload, runId: otherRunId }, { ...payload, status: "unknown" }]) {
    const { calls, result } = await scenario(async () => value, async () => null);
    assert.deepEqual(await result, { action: "retry", stage: "observe" });
    assert.deepEqual(calls, ["GET_RUN"]);
  }
  for (const error of [new TypeError("network"), { status: 500 }, { status: 503 }, { status: 404, code: "SESSION_NOT_FOUND" }]) {
    const { calls, result } = await scenario(async () => { throw error; }, async () => null);
    assert.deepEqual(await result, { action: "retry", error, stage: "observe" });
    assert.deepEqual(calls, ["GET_RUN"]);
  }
  for (const error of [new TypeError("network"), { status: 500 }, { status: 503 }]) {
    const { calls, result } = await scenario(
      async () => { throw { status: 404, code: "RUN_NOT_FOUND" }; },
      async () => { throw error; }
    );
    assert.deepEqual(await result, { action: "retry", error, stage: "observe" });
    assert.deepEqual(calls, ["GET_RUN", "GET_ACTIVE"]);
  }
  for (const active of [false, 0, "", [], { ...payload, recordId: "other" }, { ...payload, runId: "bad" }, { runId: otherRunId, recordId }]) {
    const { calls, result } = await scenario(async () => { throw { status: 404, code: "RUN_NOT_FOUND" }; }, async () => active);
    assert.deepEqual(await result, { action: "retry", stage: "observe" });
    assert.deepEqual(calls, ["GET_RUN", "GET_ACTIVE"]);
  }
  const activeOther = { ...payload, runId: otherRunId, status: "running" };
  const watching = await scenario(async () => { throw { status: 404, code: "RUN_NOT_FOUND" }; }, async () => activeOther);
  assert.equal((await watching.result).snapshot, activeOther);
  assert.deepEqual(watching.calls, ["GET_RUN", "GET_ACTIVE"]);
  const creating = await scenario(async () => { throw { status: 404, code: "RUN_NOT_FOUND" }; }, async () => null);
  assert.equal((await creating.result).action, "created");
  assert.deepEqual(creating.calls, ["GET_RUN", "GET_ACTIVE", "POST"]);
  const legacyCalls: string[] = [];
  const legacyResult = await recoverPersistedRun({ ...payload, createPhase: undefined }, {
    async getRun() { legacyCalls.push("GET_RUN"); throw { status: 404, code: "RUN_NOT_FOUND" }; },
    async getActive() { legacyCalls.push("GET_ACTIVE"); return null; },
    async create() { legacyCalls.push("POST"); return { ...payload, createPhase: "acknowledged" }; }
  });
  assert.equal(legacyResult.action, "created", "a complete legacy accepted record remains recoverable");
  assert.deepEqual(legacyCalls, ["GET_RUN", "GET_ACTIVE", "POST"]);
  for (const value of [{ ...payload, recordId: "other" }, { ...payload, runId: otherRunId }, { ...payload, status: "unknown" }]) {
    const malformed = await scenario(
      async () => { throw { status: 404, code: "RUN_NOT_FOUND" }; },
      async () => null,
      async () => value
    );
    assert.deepEqual(await malformed.result, { action: "retry", stage: "create" });
    assert.deepEqual(malformed.calls, ["GET_RUN", "GET_ACTIVE", "POST"]);
  }
  for (const error of [new TypeError("network"), { status: 503 }, { status: 409, code: "SESSION_BUSY" }]) {
    const uncertain = await scenario(
      async () => { throw { status: 404, code: "RUN_NOT_FOUND" }; },
      async () => null,
      async () => { throw error; }
    );
    assert.deepEqual(await uncertain.result, { action: "retry", error, stage: "create" });
    assert.deepEqual(uncertain.calls, ["GET_RUN", "GET_ACTIVE", "POST"]);
  }
  const rejected = { status: 400, code: "INVALID_REQUEST" };
  const failed = await scenario(
    async () => { throw { status: 404, code: "RUN_NOT_FOUND" }; },
    async () => null,
    async () => { throw rejected; }
  );
  assert.deepEqual(await failed.result, { action: "failed", error: rejected, stage: "create" });
  assert.deepEqual(failed.calls, ["GET_RUN", "GET_ACTIVE", "POST"]);
});

test("stored run inspection rejects corrupt and cross-session run-id collisions before recovery", async () => {
  const { inspectStoredRuns } = await policy(), duplicate = { ...payload, runId: otherRunId };
  const entries = [
    { key: runKey("safe"), raw: JSON.stringify({ ...payload, recordId: "safe" }) },
    { key: runKey("first"), raw: JSON.stringify({ ...duplicate, recordId: "first" }) },
    { key: runKey("second"), raw: JSON.stringify({ ...duplicate, recordId: "second" }) },
    { key: runKey("corrupt"), raw: "{not-json" }
  ];
  const result = inspectStoredRuns(entries, runKey);
  assert.deepEqual(result.runs, [{ ...payload, recordId: "safe" }]);
  assert.deepEqual(new Set(result.remove), new Set([runKey("first"), runKey("second"), runKey("corrupt")]));
});

test("failed acknowledged persistence removes an older provisional record without changing provisional liveness", async () => {
  const { acknowledgedStorageAction } = await policy();
  assert.equal(acknowledgedStorageAction({ createPhase: "acknowledged", storageAvailable: false }), "remove");
  assert.equal(acknowledgedStorageAction({ createPhase: "provisional", storageAvailable: false }), "keep");
  assert.equal(acknowledgedStorageAction({ createPhase: "acknowledged", storageAvailable: true }), "keep");
});

test("failed provisional storage keeps the initial create live but forbids recovery recreate", async () => {
  const { acknowledgedStorageAction, recoverPersistedRun } = await policy(), run = {
    ...payload,
    createPhase: "provisional",
    storageAvailable: false
  };
  assert.equal(acknowledgedStorageAction(run), "keep", "the caller may continue its initial POST");
  const calls: string[] = [];
  const result = await recoverPersistedRun(run, {
    async getRun() { calls.push("GET_RUN"); throw { status: 404, code: "RUN_NOT_FOUND" }; },
    async getActive() { calls.push("GET_ACTIVE"); return null; },
    async create() { calls.push("POST"); return { ...payload, createPhase: "acknowledged" }; }
  });
  assert.deepEqual(result, { action: "discard" });
  assert.deepEqual(calls, ["GET_RUN", "GET_ACTIVE"]);
});
