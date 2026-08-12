import test from "node:test";
import assert from "node:assert/strict";
import { chmod, link, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPanelSession, deletePanelSession, listPanelSessions, commitPanelTranscript, loadPanelSession, updatePanelMetadata,
  type PanelSessionDiagnostic, type PanelSessionPublishStep } from "../src/storage/panel-sessions.js";
import { deferred, tempFixture } from "./test-helpers.js";

const emptyDocument = { header: { type: "session", version: 3, id: "fixture" }, entries: [] };

async function incompleteRecord(root: string, agentId: string, recordId: string,
  files: { metadata?: string; transcript?: string }): Promise<string> {
  const directory = join(root, "sessions", agentId, recordId);
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  if (files.metadata !== undefined) await writeFile(join(directory, "metadata.json"), files.metadata, { mode: 0o600 });
  if (files.transcript !== undefined) await writeFile(join(directory, "transcript.jsonl"), files.transcript, { mode: 0o600 });
  return directory;
}

test("panel 会话 UUID 存入 metadata，可列出并原子提交 transcript", async t => {
  const root = await tempFixture(t, "panel-owned-");
  const document = { header: { type: "session", version: 3, id: "fixture" }, entries: [] };
  const metadata = await createPanelSession(root, "fixture-agent", document, { parentRecordId: "parent", forkedFromMessageId: "msg" });
  assert.equal(metadata.archived, false); assert.equal(metadata.hidden, false); assert.equal(metadata.memoryDisposition, "scratch");
  assert.equal((await listPanelSessions(root, "fixture-agent"))[0]?.recordId, metadata.recordId);
  await commitPanelTranscript(root, metadata, { ...document, entries: [{ type: "message", id: "u", parentId: null, message: { role: "user", content: "虚构内容" } }] });
  const stored = await readFile(join(root, "sessions", "fixture-agent", metadata.recordId, "transcript.jsonl"), "utf8");
  assert.match(stored, /虚构内容/);
});

test("旧 metadata 可直接读取，覆盖项更新采用原子 read-modify-write", async t => {
  const root = await tempFixture(t, "panel-metadata-");
  const document = { header: { type: "session", version: 3, id: "fixture" }, entries: [] };
  const metadata = await createPanelSession(root, "agent", document);
  assert.equal((await loadPanelSession(root, "agent", metadata.recordId)).metadata.modelOverride, undefined);
  await Promise.all([
    updatePanelMetadata(root, "agent", metadata.recordId, current => ({ ...current, modelOverride: "provider/model" })),
    updatePanelMetadata(root, "agent", metadata.recordId, current => ({ ...current, reasoningLevel: "stream" }))
  ]);
  const updated = (await loadPanelSession(root, "agent", metadata.recordId)).metadata;
  assert.equal(updated.modelOverride, "provider/model"); assert.equal(updated.reasoningLevel, "stream");
  const organized = await updatePanelMetadata(root, "agent", metadata.recordId, current => ({ ...current, pinned: true, project: "Panel" }));
  assert.equal(organized.pinned, true); assert.equal(organized.project, "Panel");
  await assert.rejects(updatePanelMetadata(root, "agent", metadata.recordId, current => ({ ...current, project: "bad\nproject" })), /project 格式无效/);
});

test("panel 会话只有归档后且目录内容完全已知时才能删除", async t => {
  const root = await tempFixture(t, "panel-delete-"), document = { header: { type: "session", version: 3 }, entries: [] };
  const first = await createPanelSession(root, "agent", document);
  await assert.rejects(deletePanelSession(root, "agent", first.recordId), /SESSION_NOT_ARCHIVED/);
  await updatePanelMetadata(root, "agent", first.recordId, current => ({ ...current, archived: true }));
  await deletePanelSession(root, "agent", first.recordId);
  assert.equal((await listPanelSessions(root, "agent")).length, 0);

  const unsafe = await createPanelSession(root, "agent", document);
  await updatePanelMetadata(root, "agent", unsafe.recordId, current => ({ ...current, archived: true }));
  await writeFile(join(root, "sessions", "agent", unsafe.recordId, "unknown"), "fixture");
  await assert.rejects(deletePanelSession(root, "agent", unsafe.recordId), /PANEL_SESSION_DELETE_UNSAFE/);
  assert.equal((await loadPanelSession(root, "agent", unsafe.recordId)).metadata.recordId, unsafe.recordId);
});

test("panel 会话在完整 durability 后才以目录 rename 原子发布", async t => {
  const root = await tempFixture(t, "panel-publish-"), steps: PanelSessionPublishStep[] = [];
  const metadata = await createPanelSession(root, "agent", emptyDocument, { recordId: "record" },
    { beforeStep(step) { steps.push(step); } });
  const agentRoot = join(root, "sessions", "agent"), recordRoot = join(agentRoot, metadata.recordId);
  assert.deepEqual(await readdir(agentRoot), ["record"]);
  assert.equal((await lstat(agentRoot)).mode & 0o777, 0o700);
  assert.equal((await lstat(recordRoot)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(recordRoot, "metadata.json"))).mode & 0o777, 0o600);
  assert.equal((await lstat(join(recordRoot, "transcript.jsonl"))).mode & 0o777, 0o600);
  assert.deepEqual(steps, ["sessions-parent-sync", "agent-parent-sync",
    "metadata-write", "metadata-sync", "transcript-write", "transcript-sync",
    "staging-directory-sync", "publish-rename", "published-directory-sync"]);
});

test("父目录 fsync 失败后的重试仍重新建立 sessions 与 agent 目录项耐久性", async t => {
  for (const failingStep of ["sessions-parent-sync", "agent-parent-sync"] as const) await t.test(failingStep, async t => {
    const root = await tempFixture(t, `panel-parent-sync-${failingStep}-`); let syncAttempts = 0;
    const options = { beforeStep(step: PanelSessionPublishStep) {
      if (step !== failingStep) return;
      syncAttempts += 1;
      if (syncAttempts <= 2) throw new Error(`injected ${step} attempt ${syncAttempts}`);
    } };
    await assert.rejects(createPanelSession(root, "agent", emptyDocument, { recordId: "record" }, options),
      new RegExp(`injected ${failingStep} attempt 1`));
    assert.deepEqual(await readdir(root), ["sessions"]); assert.deepEqual(await readdir(join(root, "sessions")), failingStep === "sessions-parent-sync" ? [] : ["agent"]);
    const sessionsRoot = join(root, "sessions"), agentRoot = join(sessionsRoot, "agent");
    if (failingStep === "sessions-parent-sync") {
      await rm(sessionsRoot, { recursive: true }); await mkdir(sessionsRoot, { mode: 0o700 }); await mkdir(agentRoot, { mode: 0o700 });
    } else {
      await rm(agentRoot, { recursive: true }); await mkdir(agentRoot, { mode: 0o700 });
    }
    assert.equal(syncAttempts, 1); assert.deepEqual(await listPanelSessions(root, "agent", () => {}), []);
    await assert.rejects(createPanelSession(root, "agent", emptyDocument, { recordId: "record" }, options),
      new RegExp(`injected ${failingStep} attempt 2`));
    assert.equal(syncAttempts, 2, "第二次尝试不得因目录已存在而跳过父目录 fsync");
    assert.deepEqual(await listPanelSessions(root, "agent", () => {}), []);
    await createPanelSession(root, "agent", emptyDocument, { recordId: "record" }, options);
    assert.equal(syncAttempts, 3);
    assert.deepEqual((await listPanelSessions(root, "agent")).map(item => item.recordId), ["record"]);
  });
});

test("发布的任一写入、sync 或 rename 故障都只留下不可枚举 staging", async t => {
  const failingSteps: PanelSessionPublishStep[] = ["metadata-write", "metadata-sync", "transcript-write", "transcript-sync",
    "staging-directory-sync", "publish-rename", "published-directory-sync"];
  for (const failingStep of failingSteps) await t.test(failingStep, async t => {
    const root = await tempFixture(t, `panel-publish-${failingStep}-`), diagnostics: PanelSessionDiagnostic[] = [];
    await assert.rejects(createPanelSession(root, "agent", emptyDocument, { recordId: "record" }, { beforeStep(step) {
      if (step === failingStep) throw new Error(`injected ${step}`);
    } }), new RegExp(`injected ${failingStep}`));
    const names = await readdir(join(root, "sessions", "agent"));
    assert.equal(names.includes("record"), false); assert.equal(names.length, 1); assert.match(names[0]!, /^\.panel-session-staging-/);
    assert.deepEqual(await listPanelSessions(root, "agent", event => diagnostics.push(event)), []);
    assert.deepEqual(diagnostics.map(event => event.reason), ["STAGING_DIRECTORY"]);
    assert.deepEqual(await readdir(join(root, "sessions", "agent")), names, "扫描不得自动删除 staging 故障证据");
  });
});

test("staging 完整但 publish rename 尚未发生时不可见", async t => {
  const root = await tempFixture(t, "panel-publish-boundary-"), reached = deferred(), release = deferred();
  const creating = createPanelSession(root, "agent", emptyDocument, { recordId: "record" }, { async beforeStep(step) {
    if (step === "publish-rename") { reached.resolve(); await release.promise; }
  } });
  await reached.promise;
  assert.deepEqual(await listPanelSessions(root, "agent", () => {}), []);
  assert.equal((await readdir(join(root, "sessions", "agent"))).some(name => name.startsWith(".panel-session-staging-")), true);
  release.resolve(); await creating;
  assert.deepEqual((await listPanelSessions(root, "agent")).map(item => item.recordId), ["record"]);
});

test("同进程并发创建同一 recordId 只能发布一条完整会话", async t => {
  const root = await tempFixture(t, "panel-publish-concurrent-");
  const attempts = await Promise.allSettled([
    createPanelSession(root, "agent", emptyDocument, { recordId: "record" }),
    createPanelSession(root, "agent", emptyDocument, { recordId: "record" })
  ]);
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  const rejected = attempts.find((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.match(String(rejected?.reason), /PANEL_SESSION_EXISTS/);
  assert.deepEqual(await readdir(join(root, "sessions", "agent")), ["record"]);
  assert.deepEqual((await listPanelSessions(root, "agent")).map(item => item.recordId), ["record"]);
});

test("单条缺文件或坏 JSON 记录被隔离，健康会话与安全诊断保留", async t => {
  const root = await tempFixture(t, "panel-quarantine-"), agentId = "agent", healthy = await createPanelSession(root, agentId, emptyDocument, { recordId: "healthy" });
  const metadata = (recordId: string) => JSON.stringify({ version: 1, recordId, agentId, createdAt: "2026-08-12T00:00:00.000Z" }) + "\n";
  await incompleteRecord(root, agentId, "missing-metadata", { transcript: JSON.stringify(emptyDocument.header) + "\n" });
  await incompleteRecord(root, agentId, "missing-transcript", { metadata: metadata("missing-transcript") });
  await incompleteRecord(root, agentId, "bad-metadata", { metadata: "{private-body-must-not-log", transcript: JSON.stringify(emptyDocument.header) + "\n" });
  await incompleteRecord(root, agentId, "bad-transcript", { metadata: metadata("bad-transcript"), transcript: "{private-transcript-must-not-log\n" });
  const diagnostics: PanelSessionDiagnostic[] = [], listed = await listPanelSessions(root, agentId, event => diagnostics.push(event));
  assert.deepEqual(listed.map(item => item.recordId), [healthy.recordId]);
  assert.deepEqual(new Set(diagnostics.map(event => event.reason)), new Set(["METADATA_MISSING", "TRANSCRIPT_MISSING", "METADATA_INVALID_JSON", "TRANSCRIPT_INVALID"]));
  const serialized = JSON.stringify(diagnostics);
  assert.doesNotMatch(serialized, /private-body|private-transcript/); assert.equal(serialized.includes(root), false);
});

test("staging、不安全权限、符号链接、硬链接和已存在半成品均不被发布或覆盖", async t => {
  const root = await tempFixture(t, "panel-publish-safety-"), agentId = "agent";
  const healthy = await createPanelSession(root, agentId, emptyDocument, { recordId: "healthy" });
  const agentRoot = join(root, "sessions", agentId), outside = join(root, "outside"); await mkdir(outside);
  await symlink(outside, join(agentRoot, "linked-record"));
  await symlink(outside, join(agentRoot, ".panel-session-staging-linked"));
  await link(join(agentRoot, healthy.recordId, "metadata.json"), join(agentRoot, healthy.recordId, "metadata-alias.json"));
  await incompleteRecord(root, agentId, "special-file", {
    metadata: JSON.stringify({ version: 1, recordId: "special-file", agentId, createdAt: "2026-08-12T00:00:00.000Z" }) + "\n"
  });
  await mkdir(join(agentRoot, "special-file", "transcript.jsonl"));
  const publicRecord = await incompleteRecord(root, agentId, "public-record", {
    metadata: JSON.stringify({ version: 1, recordId: "public-record", agentId, createdAt: "2026-08-12T00:00:00.000Z" }) + "\n",
    transcript: JSON.stringify(emptyDocument.header) + "\n"
  });
  await chmod(publicRecord, 0o755);
  const partial = await incompleteRecord(root, agentId, "partial-existing", {});
  await assert.rejects(createPanelSession(root, agentId, emptyDocument, { recordId: "partial-existing" }), /PANEL_SESSION_EXISTS/);
  assert.deepEqual(await readdir(partial), [], "不得用 rename 覆盖既有空半成品目录");
  const diagnostics: PanelSessionDiagnostic[] = [];
  assert.deepEqual(await listPanelSessions(root, agentId, event => diagnostics.push(event)), []);
  assert.deepEqual(new Set(diagnostics.map(event => event.reason)), new Set(["METADATA_UNSAFE", "TRANSCRIPT_UNSAFE", "ENTRY_UNSAFE", "STAGING_DIRECTORY", "METADATA_MISSING"]));
  assert.deepEqual(await readdir(partial), [], "扫描不得自动删除已有半成品");
  assert.equal((await lstat(join(agentRoot, "linked-record"))).isSymbolicLink(), true);
  assert.equal((await lstat(join(agentRoot, ".panel-session-staging-linked"))).isSymbolicLink(), true);
});

test("metadata 或 transcript 被硬链接后拒绝更新，外部字节不变", async t => {
  const root = await tempFixture(t, "panel-hardlink-write-"), metadata = await createPanelSession(root, "agent", emptyDocument, { recordId: "record" });
  const directory = join(root, "sessions", "agent", "record"), metadataPath = join(directory, "metadata.json"), transcriptPath = join(directory, "transcript.jsonl");
  const metadataAlias = join(root, "metadata-alias"), transcriptAlias = join(root, "transcript-alias");
  await link(metadataPath, metadataAlias); await link(transcriptPath, transcriptAlias);
  const metadataBefore = await readFile(metadataAlias, "utf8"), transcriptBefore = await readFile(transcriptAlias, "utf8");
  await assert.rejects(updatePanelMetadata(root, "agent", "record", current => ({ ...current, title: "unsafe" })), /panel 会话文件不安全/);
  await assert.rejects(commitPanelTranscript(root, metadata, { ...emptyDocument, entries: [{ type: "custom", id: "x" }] }), /panel 会话文件不安全/);
  assert.equal(await readFile(metadataAlias, "utf8"), metadataBefore); assert.equal(await readFile(transcriptAlias, "utf8"), transcriptBefore);
});

test("sessions 根不存在时仍返回空列表", async t => {
  const root = await tempFixture(t, "panel-list-empty-"), diagnostics: PanelSessionDiagnostic[] = [];
  assert.deepEqual(await listPanelSessions(root, "agent", event => diagnostics.push(event)), []);
  assert.deepEqual(diagnostics, []);
  await assert.rejects(loadPanelSession(root, "agent", "record"), /PANEL_SESSION_NOT_FOUND/);
  await assert.rejects(updatePanelMetadata(root, "agent", "record", current => current), /PANEL_SESSION_NOT_FOUND/);
  await assert.rejects(deletePanelSession(root, "agent", "record"), /PANEL_SESSION_NOT_FOUND/);
});

test("data 根缺失或不安全时稳定失败，不能降级为空库或会话不存在", async t => {
  const root = await tempFixture(t, "panel-data-root-error-"), missing = join(root, "private-missing-root");
  const unavailable = (error: unknown) => {
    assert.equal((error as Error).message, "PANEL_SESSION_STORAGE_UNAVAILABLE");
    assert.equal(String(error).includes(root), false); return true;
  };
  await assert.rejects(listPanelSessions(missing, "agent"), unavailable);
  await assert.rejects(loadPanelSession(missing, "agent", "record"), unavailable);
  await assert.rejects(updatePanelMetadata(missing, "agent", "record", current => current), unavailable);
  await assert.rejects(deletePanelSession(missing, "agent", "record"), unavailable);
  await assert.rejects(commitPanelTranscript(missing, {
    version: 1, recordId: "record", agentId: "agent", createdAt: "2026-08-12T00:00:00.000Z"
  }, emptyDocument), unavailable);

  const wrong = join(root, "private-wrong-root"); await writeFile(wrong, "not a directory");
  await assert.rejects(listPanelSessions(wrong, "agent"), unavailable);
  const linked = join(root, "private-linked-root"); await symlink(root, linked);
  await assert.rejects(listPanelSessions(linked, "agent"), unavailable);
  const publicRoot = await tempFixture(t, "panel-public-data-root-"); await chmod(publicRoot, 0o755);
  await assert.rejects(listPanelSessions(publicRoot, "agent"), unavailable);

  const unsafeSessionsRoot = await tempFixture(t, "panel-unsafe-sessions-root-"), sessionsRoot = join(unsafeSessionsRoot, "sessions");
  await mkdir(sessionsRoot, { mode: 0o700 }); await chmod(sessionsRoot, 0o755);
  await assert.rejects(listPanelSessions(unsafeSessionsRoot, "agent"), unavailable);
});

test("agentId 和 recordId 的路径穿越在写入前被拒绝", async t => {
  const root = await tempFixture(t, "panel-traversal-");
  await assert.rejects(createPanelSession(root, "../outside-agent", emptyDocument), /agentId 格式无效/);
  await assert.rejects(createPanelSession(root, "agent", emptyDocument, { recordId: "../outside-record" }), /recordId 格式无效/);
  assert.deepEqual(await readdir(root), []);
});
