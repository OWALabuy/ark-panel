import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

type Scope = { agentId?: string | null; sessionId?: string | null };
type FakeFile = { name: string; type: string; size: number };
type Receipt = { token?: unknown; scope?: unknown };
type Uploaded = { id?: unknown; attachmentId?: unknown };
type Run = Record<string, unknown>;
type Composer = {
  scopeKey(scope: Scope): string;
  saveOutputIntent(scope: Scope, enabled: boolean): boolean;
  addPending(scope: Scope, files: Iterable<FakeFile>): boolean;
  pending(scope: Scope): readonly { file: FakeFile; uploaded?: Uploaded }[];
  isSubmitting(scope: Scope): boolean;
  startSubmission(scope: Scope, message: string): Receipt | null;
  createdSession(scope: Scope): unknown;
  rememberCreatedSession(from: Scope, to: { agentId: string; sessionId: string; revision: string }): boolean;
  promoteSubmission(receipt: Receipt, from: Scope, to: Scope): Receipt | false;
  readOutputIntent(scope: Scope): boolean;
  uploadSubmission(receipt: Receipt, recordId: string, upload: (file: FakeFile) => Promise<Uploaded | null | undefined>): Promise<readonly Uploaded[]>;
  commitSubmission(receipt: Receipt, runId: string, attachmentIds: Iterable<string>): boolean;
  finishSubmission(receipt: Receipt): boolean;
};
type SubmitInput = { scope: Scope; message: string; revision?: string; requestOutputs?: boolean; sessionTitle?: string };
type Result = { kind: string; stage?: string; scope: Scope; recordId: string; run?: Run; error?: unknown };
type Coordinator = { submit(input: SubmitInput): Promise<Result> };

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

class FaultStorage extends MemoryStorage {
  blockedKey = "";
  override setItem(key: string, value: string) { if (key !== this.blockedKey) super.setItem(key, value); }
}

type Overrides = {
  composer?: Composer;
  createSession?(input: { agentId: string; title: string }): Promise<unknown>;
  onSessionPromoted?(created: { agentId: string; sessionId: string; revision: string }): Promise<{ revision?: unknown } | void> | { revision?: unknown } | void;
  uploadAttachment?(recordId: string, file: FakeFile): Promise<Uploaded | null | undefined>;
  randomUUID?(): unknown;
  rememberProvisional?(run: Run): Run;
  createRun?(request: Record<string, unknown>): Promise<unknown>;
  rememberAccepted?(snapshot: unknown, provisional: Run): Run;
  consumeAccepted?(run: Run): void;
  settle?(run: Run): Promise<boolean>;
  watch?(run: Run): unknown;
  discard?(run: Run): void;
  isUncertainCreateError?(error: unknown): boolean;
  reconcile?(run: Run): unknown;
  onSubmissionChanged?(scope: Scope): void;
};

const moduleUrl = (file: string) => pathToFileURL(join(process.cwd(), `src/frontend/${file}`)).href;

async function composer(storage: MemoryStorage = new MemoryStorage()): Promise<Composer> {
  const loaded = await import(`${moduleUrl("composer-state.js")}?generation-submission`) as {
    createComposerState(dependencies: { storage: MemoryStorage; createObjectURL(file: FakeFile): string; revokeObjectURL(url: string): void }): Composer;
  };
  return loaded.createComposerState({ storage, createObjectURL: file => `blob:${file.name}`, revokeObjectURL() {} });
}

async function coordinator(ports: Overrides): Promise<Coordinator> {
  const loaded = await import(`${moduleUrl("generation-submission.js")}?direct`) as {
    createGenerationSubmissionCoordinator(ports: Overrides & { composer: Composer }): Coordinator;
  };
  return loaded.createGenerationSubmissionCoordinator(ports as Overrides & { composer: Composer });
}

function file(name: string): FakeFile { return { name, type: "text/plain", size: 32 }; }

async function fixture(overrides: Overrides = {}) {
  const events: string[] = [], requests: Record<string, unknown>[] = [], state = overrides.composer ?? await composer();
  let nextRun = 1;
  const ports: Overrides & { composer: Composer } = {
    composer: state,
    createSession: async input => { events.push(`create-session:${input.agentId}:${input.title}`); return { agentId: input.agentId, sessionId: "created-session", revision: "created-revision" }; },
    onSessionPromoted: created => { events.push(`promoted:${created.sessionId}`); },
    uploadAttachment: async (recordId, value) => { events.push(`upload:${recordId}:${value.name}`); return { id: `attachment-${value.name}` }; },
    randomUUID: () => `00000000-0000-4000-8000-${String(nextRun++).padStart(12, "0")}`,
    // Registry persistence is an established non-throwing port contract: once
    // commit transfers composer ownership, the coordinator cannot unlock it.
    rememberProvisional: run => { events.push("remember-provisional"); return { ...run, locallyRemembered: true }; },
    createRun: async request => { events.push("create-run"); requests.push(request); return { ...request, status: "accepted" }; },
    rememberAccepted: (snapshot, provisional) => { events.push("remember-accepted"); return { ...provisional, ...(snapshot as Run), createPhase: "acknowledged" }; },
    consumeAccepted: () => { events.push("consume-accepted"); },
    settle: async () => { events.push("settle"); return false; },
    watch: () => { events.push("watch"); },
    discard: () => { events.push("discard"); },
    isUncertainCreateError: error => (error as { uncertain?: boolean })?.uncertain === true,
    reconcile: () => { events.push("reconcile"); },
    onSubmissionChanged: scope => { events.push(`changed:${scope.sessionId || "new"}`); },
    ...overrides
  };
  return { events, requests, state, submission: await coordinator(ports) };
}

test("existing-session submission locks synchronously and passes the frozen request to one run create", async () => {
  const { events, requests, state, submission } = await fixture(), scope = { agentId: "fixture-agent", sessionId: "existing-session" };
  const pending = submission.submit({ scope, message: "fresh message", revision: "revision-1", requestOutputs: true });
  assert.equal(state.isSubmitting(scope), true, "startSubmission runs before submit reaches its first await");
  const result = await pending;

  assert.equal(result.kind, "accepted");
  assert.equal(result.recordId, "existing-session");
  assert.deepEqual(events.filter(value => value.startsWith("changed:")), ["changed:existing-session"], "success publishes only the synchronous lock notification");
  assert.equal(events.some(value => value.startsWith("create-session:")), false);
  assert.deepEqual(requests, [{
    recordId: "existing-session", runId: "00000000-0000-4000-8000-000000000001", message: "fresh message",
    revision: "revision-1", attachmentIds: [], requestOutputs: true
  }]);
});

test("new-session promotion retries the one latched session, never uploads before success, and uses the refreshed revision", async () => {
  const storage = new FaultStorage(), state = await composer(storage), fresh = { agentId: "fixture-agent" };
  state.saveOutputIntent(fresh, true); state.addPending(fresh, [file("promoted.txt")]);
  storage.blockedKey = "ark-panel:draft:v1:fixture-agent:created-once";
  let creates = 0, uploads = 0, runCreates = 0;
  const { events, submission } = await fixture({
    composer: state,
    createSession: async input => { creates++; assert.deepEqual(input, { agentId: "fixture-agent", title: "New title" }); return { agentId: input.agentId, sessionId: "created-once", revision: "created-revision" }; },
    onSessionPromoted: async created => { assert.equal(created.sessionId, "created-once"); return { revision: "opened-revision" }; },
    uploadAttachment: async (_recordId, value) => { uploads++; return { attachmentId: `uploaded-${value.name}` }; },
    createRun: async request => { runCreates++; assert.equal(request.revision, "opened-revision"); assert.equal(request.requestOutputs, true); return { ...request, status: "accepted" }; }
  });

  const first = await submission.submit({ scope: fresh, message: "new conversation", sessionTitle: "New title" });
  assert.equal(first.kind, "failed"); assert.equal(first.stage, "promotion");
  assert.equal(creates, 1); assert.equal(uploads, 0); assert.equal(runCreates, 0);
  assert.deepEqual(state.createdSession(fresh), { agentId: "fixture-agent", sessionId: "created-once", revision: "created-revision" });

  storage.blockedKey = "";
  const second = await submission.submit({ scope: fresh, message: "new conversation", sessionTitle: "New title" });
  assert.equal(second.kind, "accepted"); assert.equal(second.recordId, "created-once");
  assert.equal(creates, 1, "retry reuses the created-session latch");
  assert.equal(uploads, 1); assert.equal(runCreates, 1);
});

test("created-session responses are validated before promotion or upload", async () => {
  let uploads = 0, runCreates = 0;
  const { events, state, submission } = await fixture({
    createSession: async () => ({ agentId: "wrong-agent", sessionId: "must-not-use" }),
    uploadAttachment: async () => { uploads++; return { id: "unused" }; },
    createRun: async () => { runCreates++; return {}; }
  });
  const scope = { agentId: "fixture-agent" }, result = await submission.submit({ scope, message: "invalid session" });
  assert.equal(result.kind, "failed"); assert.equal(result.stage, "session");
  assert.equal((result.error as { code?: string }).code, "SUBMISSION_SESSION_INVALID");
  assert.equal(state.isSubmitting(scope), false); assert.equal(uploads, 0); assert.equal(runCreates, 0);
  assert.deepEqual(events.filter(value => value.startsWith("changed:")), ["changed:new", "changed:new"], "pre-commit failure publishes lock then unlock");
});

test("a partial upload failure unlocks retry and reuses every already uploaded attachment id", async () => {
  const state = await composer(), scope = { agentId: "fixture-agent", sessionId: "upload-retry" };
  state.addPending(scope, [file("first.txt"), file("second.txt")]);
  const calls: string[] = []; let failSecond = true;
  const { requests, submission } = await fixture({
    composer: state,
    uploadAttachment: async (_recordId, value) => {
      calls.push(value.name);
      if (value.name === "second.txt" && failSecond) throw new Error("fixture upload failure");
      return { id: `id-${value.name}` };
    }
  });

  const first = await submission.submit({ scope, message: "retry attachments" });
  assert.equal(first.kind, "failed"); assert.equal(first.stage, "upload"); assert.equal(state.isSubmitting(scope), false);
  failSecond = false;
  const second = await submission.submit({ scope, message: "retry attachments" });
  assert.equal(second.kind, "accepted");
  assert.deepEqual(calls, ["first.txt", "second.txt", "second.txt"]);
  assert.deepEqual(requests[0]?.attachmentIds, ["id-first.txt", "id-second.txt"]);
});

test("invalid upload output fails before UUID, commit, provisional memory, or run creation", async () => {
  const state = await composer(), scope = { agentId: "fixture-agent", sessionId: "invalid-upload" };
  state.addPending(scope, [file("invalid.txt")]); let uuids = 0, provisionals = 0, creates = 0;
  const { events, submission } = await fixture({
    composer: state, uploadAttachment: async () => ({}), randomUUID: () => { uuids++; return "unused"; },
    rememberProvisional: run => { provisionals++; return run; }, createRun: async () => { creates++; return {}; }
  });
  const result = await submission.submit({ scope, message: "invalid response" });
  assert.equal(result.kind, "failed"); assert.equal(result.stage, "upload");
  assert.equal((result.error as { code?: string }).code, "ATTACHMENT_INVALID_RESPONSE");
  assert.equal(uuids, 0); assert.equal(provisionals, 0); assert.equal(creates, 0); assert.equal(state.isSubmitting(scope), false);
});

test("commit rejection finishes the receipt and cannot publish a provisional run", async () => {
  const state = await composer(), scope = { agentId: "fixture-agent", sessionId: "commit-failure" };
  let provisionals = 0, creates = 0;
  const rejected = { ...state, commitSubmission: () => false } satisfies Composer;
  const { events, submission } = await fixture({
    composer: rejected, rememberProvisional: run => { provisionals++; return run; }, createRun: async () => { creates++; return {}; }
  });
  const result = await submission.submit({ scope, message: "do not commit" });
  assert.equal(result.kind, "failed"); assert.equal(result.stage, "commit");
  assert.equal((result.error as { code?: string }).code, "SUBMISSION_COMMIT_FAILED");
  assert.equal(provisionals, 0); assert.equal(creates, 0); assert.equal(state.isSubmitting(scope), false);
  assert.deepEqual(events.filter(value => value.startsWith("changed:")), ["changed:commit-failure", "changed:commit-failure"]);
});

test("accepted processing remembers, consumes, settles, then watches only nonterminal runs", async () => {
  for (const terminal of [false, true]) {
    const { events, submission } = await fixture({ settle: async () => { events.push("settle"); return terminal; } });
    const result = await submission.submit({ scope: { agentId: "fixture-agent", sessionId: terminal ? "terminal" : "running" }, message: "ordered" });
    assert.equal(result.kind, "accepted");
    assert.deepEqual(events.filter(value => ["remember-provisional", "create-run", "remember-accepted", "consume-accepted", "settle", "watch"].includes(value)), terminal
      ? ["remember-provisional", "create-run", "remember-accepted", "consume-accepted", "settle"]
      : ["remember-provisional", "create-run", "remember-accepted", "consume-accepted", "settle", "watch"]);
  }
});

test("certain create failure discards the provisional while uncertain failure delegates reconciliation", async () => {
  for (const uncertain of [false, true]) {
    const failure = Object.assign(new Error(uncertain ? "uncertain" : "certain"), { uncertain });
    const { events, submission } = await fixture({ createRun: async () => { throw failure; } });
    const result = await submission.submit({ scope: { agentId: "fixture-agent", sessionId: uncertain ? "uncertain" : "certain" }, message: "create failure" });
    assert.equal(result.kind, uncertain ? "reconciling" : "failed");
    if (!uncertain) assert.equal(result.stage, "create");
    assert.deepEqual(events.filter(value => value === "discard" || value === "reconcile"), [uncertain ? "reconcile" : "discard"]);
    assert.deepEqual(events.filter(value => value.startsWith("changed:")), [`changed:${uncertain ? "uncertain" : "certain"}`], "post-commit create handling must not transiently unlock the composer");
  }
});

test("submission coordinator has no implicit browser, localization, transport, or run-policy dependency", async () => {
  const source = await readFile("src/frontend/generation-submission.js", "utf8");
  assert.doesNotMatch(source, /(?:^|\n)\s*import\s/m);
  assert.doesNotMatch(source, /\b(?:document|window|globalThis|fetch|crypto)\b/);
  assert.doesNotMatch(source, /(?:i18n|run-recovery-policy|run-creation-reconciler)/);
});
