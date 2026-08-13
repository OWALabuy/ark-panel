import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

type Scope = { agentId?: string | null; sessionId?: string | null };
type FakeFile = { name: string; type: string; size: number };
type Uploaded = { id?: string; attachmentId?: string; recordId: string };
type Pending = Readonly<{ localId: number; file: FakeFile; previewUrl?: string; uploaded?: Readonly<Uploaded> }>;
type Receipt = Readonly<{ token: symbol; scope: string }>;
type ComposerState = Readonly<{
  scopeKey(scope: Scope): string;
  readDraft(scope: Scope): string;
  saveDraft(scope: Scope, value: string): boolean;
  currentDraft(scope: Scope): string | undefined;
  readOutputIntent(scope: Scope): boolean;
  saveOutputIntent(scope: Scope, enabled: boolean): boolean;
  pending(scope: Scope): readonly Pending[];
  addPending(scope: Scope, files: Iterable<FakeFile>): boolean;
  removePending(scope: Scope, localId: number): boolean;
  startSubmission(scope: Scope, submittedDraft: string): Receipt | null;
  isSubmitting(scope: Scope): boolean;
  finishSubmission(receipt: Receipt): boolean;
  commitSubmission(receipt: Receipt, runId: string, attachmentIds: Iterable<unknown>): boolean;
  rememberCreatedSession(from: Scope, to: Scope & { revision?: unknown }): boolean;
  createdSession(from: Scope): Readonly<{ agentId: string; sessionId: string; revision: string }> | null;
  promoteSubmission(receipt: Receipt, from: Scope, to: Scope): Receipt | false;
  uploadSubmission(receipt: Receipt, recordId: string, upload: (file: FakeFile) => Promise<Omit<Uploaded, "recordId"> | undefined>): Promise<readonly Readonly<Uploaded>[]>;
  acceptOutputIntent(scope: Scope, enabled: boolean): void;
  discardCompletionOwnership(runId: unknown): boolean;
  complete(scope: Scope, submission: { runId?: unknown; submittedDraft?: unknown; submittedAttachmentIds?: unknown }, currentDraft: unknown): Readonly<{ owned: boolean; released: number }>;
  isPreviewImageMime(value: unknown): boolean;
}>;

type Dependencies = {
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
  createObjectURL(file: FakeFile): string;
  revokeObjectURL(url: string): void;
};

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

class FaultStorage extends MemoryStorage {
  setFault: ((key: string, value: string) => "skip" | void) | null = null;
  removeFault: ((key: string) => "skip" | void) | null = null;
  override setItem(key: string, value: string) { if (this.setFault?.(key, value) === "skip") return; super.setItem(key, value); }
  override removeItem(key: string) { if (this.removeFault?.(key) === "skip") return; super.removeItem(key); }
}

async function loadFactory(): Promise<(dependencies: Dependencies) => ComposerState> {
  const url = pathToFileURL(join(process.cwd(), "src/frontend/composer-state.js")).href;
  return (await import(`${url}?composer-state`)).createComposerState as (dependencies: Dependencies) => ComposerState;
}

function file(name: string, type = "text/plain", size = 32): FakeFile { return { name, type, size }; }

async function fixture(overrides: Partial<Dependencies> = {}) {
  const storage = new MemoryStorage(), created: string[] = [], revoked: string[] = [];
  const createObjectURL = (value: FakeFile) => { const url = `blob:fixture-${value.name}-${created.length + 1}`; created.push(url); return url; };
  const revokeObjectURL = (url: string) => { revoked.push(url); };
  const createComposerState = await loadFactory();
  return {
    storage, created, revoked,
    state: createComposerState({ storage, createObjectURL, revokeObjectURL, ...overrides })
  };
}

async function stateWithStorage(storage: Dependencies["storage"]) {
  const createComposerState = await loadFactory();
  return createComposerState({ storage, createObjectURL: value => `blob:${value.name}`, revokeObjectURL() {} });
}

function errorCode(error: unknown) { return String((error as { code?: unknown })?.code ?? ""); }

test("composer v1 keys remain byte-compatible and ordinary saves stay fail-soft", async () => {
  const { state, storage } = await fixture(), session = { agentId: "agent /中文", sessionId: "record/?值" }, fresh = { agentId: "agent /中文" };

  assert.equal(state.scopeKey(session), "session:record/?值");
  assert.equal(state.scopeKey(fresh), "new:agent /中文");
  assert.equal(state.scopeKey({ sessionId: "record-without-agent" }), "");
  state.saveDraft(session, "fictional draft");
  state.saveOutputIntent(fresh, true);
  assert.deepEqual([...storage.values], [
    ["ark-panel:draft:v1:agent%20%2F%E4%B8%AD%E6%96%87:record%2F%3F%E5%80%BC", "fictional draft"],
    ["ark-panel:request-outputs:v1:new:agent%20%2F%E4%B8%AD%E6%96%87", "1"]
  ]);
  assert.equal(state.readDraft(session), "fictional draft");
  assert.equal(state.readOutputIntent(fresh), true);
  state.saveDraft(session, "");
  state.saveOutputIntent(fresh, false);
  assert.equal(storage.values.size, 0);

  const createComposerState = await loadFactory(), broken = createComposerState({
    storage: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } },
    createObjectURL() { throw new Error("unused"); }, revokeObjectURL() { throw new Error("unused"); }
  });
  assert.equal(broken.readDraft(session), "");
  assert.equal(broken.readOutputIntent(session), false);
  assert.doesNotThrow(() => broken.saveDraft(session, "kept in the textarea"));
  assert.doesNotThrow(() => broken.saveOutputIntent(session, true));
  const receipt = broken.startSubmission(fresh, "draft stays in the textarea");
  assert.ok(receipt);
  assert.equal(broken.promoteSubmission(receipt, fresh, session), false, "scope promotion fails closed when storage cannot be verified");
});

test("attachment validation remains atomic across MIME, size, total, and count limits", async () => {
  const { state, created } = await fixture(), scope = { agentId: "fixture", sessionId: "validation" };
  for (const [value, code] of [
    [file("empty.txt", "text/plain", 0), "ATTACHMENT_EMPTY"],
    [file("vector.svg", "image/svg+xml"), "ATTACHMENT_UNSUPPORTED"],
    [file("binary.exe", "application/octet-stream"), "ATTACHMENT_UNSUPPORTED"],
    [file("large.txt", "text/plain", 5 * 1024 * 1024 + 1), "ATTACHMENT_TOO_LARGE"],
    [file("large.png", "image/png", 6 * 1024 * 1024 + 1), "ATTACHMENT_TOO_LARGE"]
  ] as const) assert.throws(() => state.addPending(scope, [value]), error => errorCode(error) === code, value.name);
  assert.equal(state.pending(scope).length, 0);
  assert.equal(created.length, 0, "validation must finish before allocating any preview URL");

  assert.equal(state.addPending(scope, [file("still.gif", "image/gif"), file("typed-by-extension.md", "application/octet-stream")]), true);
  assert.equal(state.pending(scope).every(item => item.previewUrl === undefined), true, "GIF and ordinary files remain non-preview attachments");
  assert.equal(state.isPreviewImageMime("image/png"), true);
  assert.equal(state.isPreviewImageMime("IMAGE/PNG"), true, "historical attachment preview MIME matching stays case-insensitive");
  assert.equal(state.isPreviewImageMime("image/gif"), false);

  const countScope = { agentId: "fixture", sessionId: "count" };
  state.addPending(countScope, Array.from({ length: 10 }, (_, index) => file(`file-${index}.txt`)));
  assert.throws(() => state.addPending(countScope, [file("eleventh.txt")]), error => errorCode(error) === "ATTACHMENT_TOO_MANY");
  assert.equal(state.pending(countScope).length, 10);

  const totalScope = { agentId: "fixture", sessionId: "total" };
  state.addPending(totalScope, [file("one.txt", "text/plain", 5 * 1024 * 1024), file("two.txt", "text/plain", 5 * 1024 * 1024), file("three.txt", "text/plain", 5 * 1024 * 1024)]);
  assert.throws(() => state.addPending(totalScope, [file("overflow.txt", "text/plain", 1)]), error => errorCode(error) === "ATTACHMENT_TOTAL_TOO_LARGE");
  assert.equal(state.pending(totalScope).length, 3);
});

test("pending getters are frozen snapshots and Blob URLs are released exactly once", async () => {
  const { state, created, revoked } = await fixture(), scope = { agentId: "fixture", sessionId: "snapshots" };
  state.addPending(scope, [file("preview.png", "image/png"), file("notes.txt")]);
  const first = state.pending(scope), second = state.pending(scope);

  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first[0]), true);
  assert.notEqual(first, second);
  assert.notEqual(first[0], second[0]);
  assert.throws(() => (first as Pending[]).splice(0, 1), TypeError);
  assert.equal(state.pending(scope).length, 2);

  assert.equal(state.removePending(scope, first[0]!.localId), true);
  assert.deepEqual(revoked, [created[0]]);
  assert.equal(state.removePending(scope, first[0]!.localId), false);
  assert.deepEqual(revoked, [created[0]], "a removed preview URL cannot be revoked twice");
  assert.equal(state.removePending(scope, first[1]!.localId), true);
  assert.deepEqual(revoked, [created[0]], "non-preview files have no Blob URL to release");
});

test("partial preview allocation rolls back every URL without publishing half a batch", async () => {
  const revoked: string[] = [], createComposerState = await loadFactory(), storage = new MemoryStorage();
  let attempts = 0;
  const state = createComposerState({
    storage,
    createObjectURL(value) { if (++attempts === 2) throw new Error("fictional allocation failure"); return `blob:${value.name}`; },
    revokeObjectURL(url) { revoked.push(url); }
  }), scope = { agentId: "fixture", sessionId: "allocation" };

  assert.throws(() => state.addPending(scope, [file("first.png", "image/png"), file("second.png", "image/png")]), /fictional allocation failure/);
  assert.deepEqual(revoked, ["blob:first.png"]);
  assert.equal(state.pending(scope).length, 0);
});

test("new-session migration moves output, files, and the submission lock as one scope", async () => {
  const { state } = await fixture(), fresh = { agentId: "fixture" }, session = { agentId: "fixture", sessionId: "created" };
  state.saveOutputIntent(fresh, true);
  state.addPending(fresh, [file("first.png", "image/png"), file("second.txt")]);
  const receipt = state.startSubmission(fresh, "fictional new-session draft");
  assert.ok(receipt);
  assert.equal(state.startSubmission(fresh, "blocked"), null);
  assert.equal(state.addPending(fresh, [file("blocked.txt")]), false);
  assert.equal(state.removePending(fresh, state.pending(fresh)[0]!.localId), false);

  assert.equal(state.rememberCreatedSession(fresh, { ...session, revision: "revision-1" }), true);
  assert.deepEqual(state.createdSession(fresh), { agentId: "fixture", sessionId: "created", revision: "revision-1" });
  const promoted = state.promoteSubmission(receipt, fresh, session);
  assert.ok(promoted);
  assert.equal(state.readOutputIntent(fresh), false);
  assert.equal(state.readOutputIntent(session), true);
  assert.equal(state.pending(fresh).length, 0);
  assert.equal(state.pending(session).length, 2);
  assert.equal(state.isSubmitting(fresh), false);
  assert.equal(state.isSubmitting(session), true);
  assert.equal(state.readDraft(session), "fictional new-session draft");
  assert.equal(state.finishSubmission(receipt), false, "the pre-promotion receipt cannot unlock the promoted submission");
  assert.equal(state.finishSubmission(promoted), true);
  assert.equal(state.isSubmitting(session), false);
});

test("promotion fails closed on target set failure and retries the same created session once", async () => {
  const storage = new FaultStorage(), state = await stateWithStorage(storage), fresh = { agentId: "fixture" }, target = { agentId: "fixture", sessionId: "created-once", revision: "revision-1" };
  const targetDraftKey = "ark-panel:draft:v1:fixture:created-once";
  state.saveOutputIntent(fresh, true);state.addPending(fresh, [file("visible.txt")]);
  let createCount = 0;
  const created = () => {
    const existing = state.createdSession(fresh);if (existing)return existing;
    createCount++;assert.equal(state.rememberCreatedSession(fresh, target), true);return state.createdSession(fresh)!;
  };

  const first = state.startSubmission(fresh, "draft");assert.ok(first);created();
  storage.setFault = key => key === targetDraftKey ? "skip" : undefined;
  assert.equal(state.promoteSubmission(first, fresh, target), false);
  assert.equal(state.isSubmitting(fresh), true);
  assert.deepEqual(state.pending(fresh).map(item => item.file.name), ["visible.txt"]);
  assert.equal(state.pending(target).length, 0);
  assert.equal(state.finishSubmission(first), true, "a failed promotion unlocks the visible source composer");

  storage.setFault = null;
  const second = state.startSubmission(fresh, "draft");assert.ok(second);created();
  const promoted = state.promoteSubmission(second, fresh, target);assert.ok(promoted);
  assert.equal(createCount, 1, "an explicit retry reuses the already-created record");
  assert.equal(state.createdSession(fresh), null);
  assert.equal(state.pending(fresh).length, 0);
  assert.deepEqual(state.pending(target).map(item => item.file.name), ["visible.txt"]);
  assert.equal(state.readOutputIntent(target), true);
  assert.equal(state.finishSubmission(promoted), true);
});

test("promotion detects source remove failure without moving receipt or pending state", async () => {
  const storage = new FaultStorage(), state = await stateWithStorage(storage), fresh = { agentId: "fixture" }, target = { agentId: "fixture", sessionId: "remove-fails" };
  const sourceOutputKey = "ark-panel:request-outputs:v1:new:fixture";
  state.saveOutputIntent(fresh, true);state.addPending(fresh, [file("source.txt")]);state.rememberCreatedSession(fresh, target);
  const receipt = state.startSubmission(fresh, "source draft");assert.ok(receipt);
  storage.removeFault = key => key === sourceOutputKey ? "skip" : undefined;

  assert.equal(state.promoteSubmission(receipt, fresh, target), false);
  assert.equal(state.isSubmitting(fresh), true);
  assert.equal(state.isSubmitting(target), false);
  assert.deepEqual(state.pending(fresh).map(item => item.file.name), ["source.txt"]);
  assert.equal(state.currentDraft(fresh), "source draft");
  assert.equal(state.createdSession(fresh)?.sessionId, "remove-fails");
});

test("promotion retry converges after cleanup and source compensation failures", async () => {
  const storage = new FaultStorage(), state = await stateWithStorage(storage), fresh = { agentId: "fixture" }, target = { agentId: "fixture", sessionId: "compensation" };
  const sourceOutputKey = "ark-panel:request-outputs:v1:new:fixture", targetDraftKey = "ark-panel:draft:v1:fixture:compensation", targetOutputKey = "ark-panel:request-outputs:v1:session:fixture:compensation";
  state.saveOutputIntent(fresh, true);state.addPending(fresh, [file("compensation.txt")]);state.rememberCreatedSession(fresh, target);
  const first = state.startSubmission(fresh, "first draft");assert.ok(first);
  storage.setFault = key => key === targetOutputKey ? "skip" : undefined;
  storage.removeFault = key => key === targetDraftKey ? "skip" : undefined;
  assert.equal(state.promoteSubmission(first, fresh, target), false);
  assert.equal(storage.getItem(targetDraftKey), "first draft", "failed best-effort cleanup may leave only a known draft copy");
  assert.deepEqual(state.pending(fresh).map(item => item.file.name), ["compensation.txt"]);
  state.finishSubmission(first);

  storage.setFault = null;storage.removeFault = key => {
    if (key !== sourceOutputKey)return;
    storage.values.delete(key);storage.setFault = changed => changed === sourceOutputKey ? (() => { throw new Error("restore blocked"); })() : undefined;
    throw new Error("remove reported failure after deletion");
  };
  const second = state.startSubmission(fresh, "edited retry draft");assert.ok(second);
  assert.equal(state.promoteSubmission(second, fresh, target), false);
  assert.equal(storage.getItem(sourceOutputKey), null, "source restoration is best effort, not an atomicity claim");
  assert.deepEqual(state.pending(fresh).map(item => item.file.name), ["compensation.txt"]);
  state.finishSubmission(second);

  storage.setFault = null;storage.removeFault = null;
  const third = state.startSubmission(fresh, "edited retry draft");assert.ok(third);
  const promoted = state.promoteSubmission(third, fresh, target);assert.ok(promoted);
  assert.equal(state.readDraft(target), "edited retry draft");
  assert.equal(state.readOutputIntent(target), true, "the in-memory intent mirror survives failed source compensation");
  assert.equal(state.finishSubmission(promoted), true);
});

test("promotion rejects cross-agent and occupied targets without partial migration", async () => {
  const { state } = await fixture(), fresh = { agentId: "fixture" }, occupied = { agentId: "fixture", sessionId: "occupied" };
  state.saveOutputIntent(fresh, true);
  state.addPending(fresh, [file("source.txt")]);
  const receipt = state.startSubmission(fresh, "draft");assert.ok(receipt);

  assert.equal(state.rememberCreatedSession(fresh, { agentId: "other", sessionId: "created" }), false);
  assert.equal(state.promoteSubmission(receipt, fresh, { agentId: "other", sessionId: "created" }), false);
  assert.equal(state.rememberCreatedSession(fresh, occupied), true);
  state.saveOutputIntent(occupied, true);
  assert.equal(state.promoteSubmission(receipt, fresh, occupied), false);
  assert.equal(state.readOutputIntent(fresh), true);
  assert.deepEqual(state.pending(fresh).map(item => item.file.name), ["source.txt"]);
  assert.equal(state.isSubmitting(fresh), true);
  assert.equal(state.readDraft(occupied), "");
  assert.equal(state.finishSubmission(receipt), true);
});

test("opaque receipts prevent a late finish from unlocking a successor", async () => {
  const { state } = await fixture(), scope = { agentId: "fixture", sessionId: "receipt" };
  const first = state.startSubmission(scope, "first");assert.ok(first);
  assert.equal(state.commitSubmission(first, "run-first", []), true);
  const second = state.startSubmission(scope, "second");assert.ok(second);
  assert.equal(state.finishSubmission(first), false);
  assert.equal(state.isSubmitting(scope), true);
  await assert.rejects(state.uploadSubmission(first, "receipt", async () => ({ id: "must-not-upload" })), error => errorCode(error) === "SUBMISSION_NOT_ACTIVE");
  assert.equal(state.finishSubmission(second), true);
  assert.equal(state.discardCompletionOwnership("run-first"), true);
});

test("attachment retry reuses uploaded IDs and exposes only frozen copies", async () => {
  const { state } = await fixture(), scope = { agentId: "fixture", sessionId: "retry" }, calls: string[] = [];
  state.addPending(scope, [file("cached.png", "image/png"), file("retry.txt")]);
  const first = state.startSubmission(scope, "retry draft");assert.ok(first);
  await assert.rejects(state.uploadSubmission(first, "retry", async value => {
    calls.push(value.name);
    if (value.name === "retry.txt") throw new Error("fictional upload failure");
    return { attachmentId: "attachment-cached" };
  }), /fictional upload failure/);
  state.finishSubmission(first);

  const second = state.startSubmission(scope, "retry draft");assert.ok(second);
  const uploaded = await state.uploadSubmission(second, "retry", async value => {
    calls.push(value.name);
    return { attachmentId: "attachment-retried" };
  });
  state.finishSubmission(second);
  assert.deepEqual(calls, ["cached.png", "retry.txt", "retry.txt"]);
  assert.deepEqual(uploaded.map(item => item.attachmentId), ["attachment-cached", "attachment-retried"]);
  assert.equal(Object.isFrozen(uploaded), true);
  assert.equal(uploaded.every(Object.isFrozen), true);
  assert.equal(Object.isFrozen(state.pending(scope)[0]!.uploaded), true);
});

test("malformed upload responses are never cached for retry", async () => {
  const { state } = await fixture(), scope = { agentId: "fixture", sessionId: "invalid-upload" };
  state.addPending(scope, [file("response.txt")]);
  const first = state.startSubmission(scope, "invalid response");assert.ok(first);let calls = 0;
  await assert.rejects(state.uploadSubmission(first, "invalid-upload", async () => { calls++; return {}; }), error => errorCode(error) === "ATTACHMENT_INVALID_RESPONSE");
  state.finishSubmission(first);
  const second = state.startSubmission(scope, "invalid response");assert.ok(second);
  const uploaded = await state.uploadSubmission(second, "invalid-upload", async () => { calls++; return { id: "valid-id" }; });
  state.finishSubmission(second);
  assert.equal(calls, 2);
  assert.equal(uploaded[0]?.id, "valid-id");
});

test("a throwing URL revoker cannot retain or double-release internal state", async () => {
  const createComposerState = await loadFactory(), storage = new MemoryStorage(), scope = { agentId: "fixture", sessionId: "revoke" };
  let attempts = 0;
  const state = createComposerState({ storage, createObjectURL: () => "blob:throws", revokeObjectURL: () => { attempts++; throw new Error("fictional revoke failure"); } });
  state.addPending(scope, [file("throws.png", "image/png")]);
  const id = state.pending(scope)[0]!.localId;
  assert.equal(state.removePending(scope, id), true);
  assert.equal(state.removePending(scope, id), false);
  assert.equal(state.pending(scope).length, 0);
  assert.equal(attempts, 1);
});

test("acceptance consumes only its output intent and terminal state obeys draft ownership", async () => {
  const { state, revoked } = await fixture(), scope = { agentId: "fixture", sessionId: "owned" }, other = { agentId: "fixture", sessionId: "other" };
  state.saveOutputIntent(scope, true);state.saveOutputIntent(other, true);
  state.acceptOutputIntent(scope, false);
  assert.equal(state.readOutputIntent(scope), true);
  state.acceptOutputIntent(scope, true);
  assert.equal(state.readOutputIntent(scope), false);
  assert.equal(state.readOutputIntent(other), true);

  state.saveDraft(scope, "submitted draft");
  state.addPending(scope, [file("submitted.png", "image/png"), file("submitted-too.png", "image/png")]);
  const receipt = state.startSubmission(scope, "submitted draft");assert.ok(receipt);
  const uploaded = await state.uploadSubmission(receipt, "owned", async value => ({ attachmentId: `id-${value.name}` }));
  const attachmentIds = uploaded.map(item => item.attachmentId);
  assert.equal(state.commitSubmission(receipt, "run-owned", attachmentIds), true);
  state.addPending(scope, [file("newer.png", "image/png")]);

  assert.equal(state.readDraft(scope), "submitted draft", "failed/aborted coordination leaves the module untouched");
  assert.equal(state.pending(scope).length, 3);
  const completed = state.complete(scope, { runId: "run-owned", submittedDraft: "submitted draft", submittedAttachmentIds: attachmentIds }, "submitted draft");
  assert.deepEqual(completed, { owned: true, released: 2 });
  assert.equal(Object.isFrozen(completed), true);
  assert.equal(state.readDraft(scope), "");
  assert.deepEqual(state.pending(scope).map(item => item.file.name), ["newer.png"]);
  assert.equal(revoked.length, 2);
});

test("a newer same-session draft prevents completed cleanup and every Blob release", async () => {
  const { state, revoked } = await fixture(), scope = { agentId: "fixture", sessionId: "newer-draft" };
  state.saveDraft(scope, "submitted draft");
  state.addPending(scope, [file("submitted.png", "image/png")]);
  const receipt = state.startSubmission(scope, "submitted draft");assert.ok(receipt);
  const [uploaded] = await state.uploadSubmission(receipt, "newer-draft", async () => ({ id: "uploaded-id" }));
  assert.equal(state.commitSubmission(receipt, "run-newer", [uploaded?.id]), true);
  state.saveDraft(scope, "newer local draft");

  const result = state.complete(scope, { runId: "run-newer", submittedDraft: "submitted draft", submittedAttachmentIds: [uploaded?.id] }, "newer local draft");
  assert.deepEqual(result, { owned: false, released: 0 });
  assert.equal(state.readDraft(scope), "newer local draft");
  assert.equal(state.pending(scope).length, 1);
  assert.deepEqual(revoked, []);
});

test("attachment-only completion cannot clear newer textarea input", async () => {
  const { state, revoked } = await fixture(), scope = { agentId: "fixture", sessionId: "attachment-only" };
  state.saveDraft(scope, "");state.addPending(scope, [file("only.png", "image/png")]);
  const receipt = state.startSubmission(scope, "");assert.ok(receipt);
  const [uploaded] = await state.uploadSubmission(receipt, "attachment-only", async () => ({ attachmentId: "attachment-only-id" }));
  assert.equal(state.commitSubmission(receipt, "run-attachment-only", [uploaded?.attachmentId]), true);
  state.saveDraft(scope, "new textarea input");

  const result = state.complete(scope, { runId: "run-attachment-only", submittedDraft: "", submittedAttachmentIds: [uploaded?.attachmentId] }, "new textarea input");
  assert.deepEqual(result, { owned: false, released: 0 });
  assert.equal(state.currentDraft(scope), "new textarea input");
  assert.deepEqual(state.pending(scope).map(item => item.file.name), ["only.png"]);
  assert.deepEqual(revoked, []);
});

test("failed and aborted terminals only discard bookkeeping", async () => {
  const { state, revoked } = await fixture(), scope = { agentId: "fixture", sessionId: "failed" };
  state.saveDraft(scope, "retry me");state.addPending(scope, [file("retry.png", "image/png")]);
  const receipt = state.startSubmission(scope, "retry me");assert.ok(receipt);
  const [uploaded] = await state.uploadSubmission(receipt, "failed", async () => ({ id: "retry-id" }));
  assert.equal(state.commitSubmission(receipt, "run-failed", [uploaded?.id]), true);
  assert.equal(state.discardCompletionOwnership("run-failed"), true);
  assert.equal(state.currentDraft(scope), "retry me");
  assert.deepEqual(state.pending(scope).map(item => item.file.name), ["retry.png"]);
  assert.deepEqual(revoked, []);
  assert.deepEqual(state.complete(scope, { runId: "run-failed", submittedDraft: "retry me", submittedAttachmentIds: [uploaded?.id] }, "retry me"), { owned: false, released: 0 });
});

test("composer state has no implicit DOM, browser-global, localization, or generation dependency", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile("src/frontend/composer-state.js", "utf8"));
  assert.doesNotMatch(source, /\b(?:window|document|localStorage|sessionStorage|globalThis)\b/);
  assert.doesNotMatch(source, /(?:from|import\()\s*["'][^"']*(?:i18n|run-recovery|generation)/);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.match(source, /export function createComposerState/);
  assert.match(source, /Object\.freeze/);
});
