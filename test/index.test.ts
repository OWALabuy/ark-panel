import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, open, readdir, rename, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConservativeContextBudget } from "../src/domain/context-budget.js";
import { externalRecordId } from "../src/domain/record-id.js";
import { SessionReadData } from "../src/server/read-data.js";
import { PanelAttachmentApi } from "../src/server/attachment-api.js";
import { mergeSessionIndexAgents, SessionReadIndex, type SessionReadIndexEvent,
  type SessionReadIndexFileSystem } from "../src/storage/index.js";
import { commitPanelTranscript, createPanelSession, deletePanelSession, loadPanelSession,
  inspectPanelSession, updatePanelMetadata } from "../src/storage/panel-sessions.js";
import { deferred, tempFixture, waitFor, withTimeout } from "./test-helpers.js";

function uuid(index: number): string { return `${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`; }
function transcript(id: string, content: string): string {
  return [
    { type: "session", version: 3, id, timestamp: "2026-07-11T00:00:00Z" },
    { type: "message", id: `u-${id}`, parentId: null, message: { role: "user", content } }
  ].map(value => JSON.stringify(value)).join("\n") + "\n";
}
function count(events: readonly SessionReadIndexEvent[], type: SessionReadIndexEvent["type"]): number {
  return events.filter(event => event.type === type).length;
}

function panelDocument(id: string, content: string) {
  return { header: { type: "session", version: 3, id }, entries: [
    { type: "message", id: `u-${id}`, parentId: null, message: { role: "user", content } }
  ] };
}

test("搜索只线性解析候选，暖缓存单条读取不重新枚举且清空后可重建", async t => {
  const root = await tempFixture(t, "panel-index-linear-"), sessions = join(root, "source"), data = join(root, "data");
  await mkdir(sessions); await mkdir(data, { mode: 0o700 });
  const total = 24;
  for (let index = 1; index <= total; index++) {
    const id = uuid(index); await writeFile(join(sessions, `${id}.jsonl`), transcript(id, `linear needle ${index}`));
  }
  const events: SessionReadIndexEvent[] = [];
  const index = new SessionReadIndex([{ agentId: "fixture", sessionsRoot: sessions }], data,
    { onEvent: event => events.push(event) });
  const reads = new SessionReadData([{ agentId: "fixture", sessionsRoot: sessions }], data,
    index, new ConservativeContextBudget());

  assert.equal((await reads.search("needle", "fixture") as unknown[]).length, total);
  assert.equal(count(events, "transcript_loaded"), total, "N 条候选只读取并解析 N 次");
  const listed = await reads.sessions("fixture"), first = listed[0]!;
  const scansBeforeLookup = count(events, "agent_scanned"), loadsBeforeLookup = count(events, "transcript_loaded");
  assert.equal((await reads.conversation(first.recordId) as { recordId: string }).recordId, first.recordId);
  assert.equal(count(events, "agent_scanned"), scansBeforeLookup, "已定位的单条读取不得重新枚举 agent");
  assert.equal(count(events, "transcript_loaded"), loadsBeforeLookup, "未变的单条读取复用解析结果");
  assert.equal((await reads.updateSession(first.recordId, { title: "sidecar title" })).title, "sidecar title");
  assert.equal(count(events, "agent_scanned"), scansBeforeLookup, "sidecar 定点更新不得全量枚举");
  assert.equal(count(events, "transcript_loaded"), loadsBeforeLookup, "sidecar 更新不得重读 transcript");
  await assert.rejects(reads.updateSession("unknown-record", { title: "not found" }), /SESSION_NOT_FOUND/);
  assert.equal(count(events, "agent_scanned"), scansBeforeLookup, "未知 record lookup 也不得全量枚举");

  await reads.search("needle", "fixture");
  assert.equal(count(events, "transcript_loaded"), total, "重复搜索只校验指纹，不重读正文");
  const changedId = uuid(1);
  await writeFile(join(sessions, `${changedId}.jsonl`), transcript(changedId, "changed needle"));
  await reads.search("changed", "fixture");
  assert.equal(count(events, "transcript_loaded"), total + 1, "只有变更的 transcript 被重新解析");

  index.clear();
  assert.equal((await reads.search("needle", "fixture") as unknown[]).length, total);
  assert.equal(count(events, "transcript_loaded"), total * 2 + 1, "删除派生状态后从权威来源完整重建");
  await assert.rejects(lstat(join(data, "index.json")), error => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("源修改、reset 重命名和 panel sidecar/transcript 更新使缓存精确失效", async t => {
  const root = await tempFixture(t, "panel-index-invalidation-"), sessions = join(root, "source"), data = join(root, "data");
  await mkdir(sessions); await mkdir(data, { mode: 0o700 });
  const activeId = uuid(31), resetId = uuid(32), activeName = `${activeId}.jsonl`;
  const resetName = `${resetId}.jsonl.reset.2026-07-11T00-00-00Z`;
  await writeFile(join(sessions, activeName), transcript(activeId, "active old"));
  await writeFile(join(sessions, resetName), transcript(resetId, "reset old"));
  const panel = await createPanelSession(data, "fixture", {
    header: { type: "session", version: 3, id: "panel-header" }, entries: [
      { type: "message", id: "panel-u", parentId: null, message: { role: "user", content: "panel old" } }
    ]
  }, { recordId: "panel-record", title: "old title" });
  const events: SessionReadIndexEvent[] = [];
  const index = new SessionReadIndex([{ agentId: "fixture", sessionsRoot: sessions }], data,
    { onEvent: event => events.push(event) });
  const reads = new SessionReadData([{ agentId: "fixture", sessionsRoot: sessions }], data,
    index, new ConservativeContextBudget());
  assert.equal((await reads.sessions("fixture")).length, 3);
  assert.equal(count(events, "transcript_loaded"), 3);

  await updatePanelMetadata(data, "fixture", panel.recordId, current => ({ ...current, title: "new title" }));
  assert.equal((await reads.sessions("fixture")).find(record => record.recordId === panel.recordId)?.title, "new title");
  assert.equal(count(events, "transcript_loaded"), 4, "metadata 指纹变化只重载一条 panel 记录");
  const loaded = await loadPanelSession(data, "fixture", panel.recordId);
  await commitPanelTranscript(data, loaded.metadata, { ...loaded.document, entries: [...loaded.document.entries,
    { type: "message", id: "panel-a", parentId: "panel-u", message: { role: "assistant", content: "panel fresh needle" } }] });
  assert.deepEqual((await reads.search("fresh", "fixture") as Array<{ recordId: string }>).map(item => item.recordId), [panel.recordId]);
  assert.equal(count(events, "transcript_loaded"), 5);

  await writeFile(join(sessions, activeName), transcript(activeId, "active complete") + '{"type":"message"');
  assert.equal((await reads.conversation(externalRecordId("fixture", "active", activeId)) as { messageCount: number }).messageCount, 1,
    "active 尾部半行不得污染已完成记录");
  assert.equal(count(events, "transcript_loaded"), 6);

  const renamed = `${resetId}.jsonl.reset.2026-07-12T00-00-00Z`;
  const oldRecordId = externalRecordId("fixture", "reset", resetName);
  await rename(join(sessions, resetName), join(sessions, renamed));
  const afterRename = await reads.sessions("fixture", null, true);
  assert.equal(afterRename.some(record => record.recordId === oldRecordId), false);
  assert.equal(afterRename.some(record => record.recordId === externalRecordId("fixture", "reset", renamed)), true);
  assert.equal(count(events, "transcript_loaded"), 7, "reset 新 locator 只解析一次");
});

test("并发冷启动共用一次重建且单条坏记录不会污染后续快照", async t => {
  const root = await tempFixture(t, "panel-index-concurrent-"), sessions = join(root, "source"), data = join(root, "data");
  await mkdir(sessions); await mkdir(data, { mode: 0o700 });
  const id = uuid(41); await writeFile(join(sessions, `${id}.jsonl`), transcript(id, "shared needle"));
  const broken = await createPanelSession(data, "fixture", { header: { type: "session", version: 3, id: "broken" }, entries: [] },
    { recordId: "broken" });
  await writeFile(join(data, "sessions", "fixture", broken.recordId, "transcript.jsonl"), "{broken", { mode: 0o600 });
  const events: SessionReadIndexEvent[] = [], diagnostics: string[] = [];
  const index = new SessionReadIndex([{ agentId: "fixture", sessionsRoot: sessions }], data, {
    onEvent: event => events.push(event), onPanelDiagnostic: event => diagnostics.push(event.reason)
  });
  const reads = new SessionReadData([{ agentId: "fixture", sessionsRoot: sessions }], data,
    index, new ConservativeContextBudget());
  const [left, right] = await Promise.all([reads.search("needle"), reads.sessions("fixture")]);
  assert.equal((left as unknown[]).length, 1); assert.equal(right.length, 1);
  assert.equal(count(events, "agent_scanned"), 1); assert.equal(count(events, "transcript_loaded"), 1);
  assert.deepEqual(diagnostics, ["TRANSCRIPT_INVALID"]);
  await reads.sessions("fixture");
  assert.deepEqual(diagnostics, ["TRANSCRIPT_INVALID"], "未变的坏记录按指纹隔离，不反复读取或泄漏内容");
});

test("panel create/update/delete 定点维护 locator，不触发全局会话扫描", async t => {
  const root = await tempFixture(t, "panel-index-mutation-"), sessions = join(root, "source"), data = join(root, "data");
  await mkdir(sessions); await mkdir(data, { mode: 0o700 });
  const events: SessionReadIndexEvent[] = [];
  const index = new SessionReadIndex([{ agentId: "fixture", sessionsRoot: sessions }], data,
    { onEvent: event => events.push(event) });
  const reads = new SessionReadData([{ agentId: "fixture", sessionsRoot: sessions }], data,
    index, new ConservativeContextBudget());
  await index.initialize();
  const scans = count(events, "agent_scanned");
  const created = await reads.createPanel("fixture", "created") as { recordId: string };
  assert.equal(count(events, "agent_scanned"), scans);
  assert.equal((await reads.updateSession(created.recordId, { title: "updated", archived: true })).title, "updated");
  assert.equal(count(events, "agent_scanned"), scans);
  assert.deepEqual(await reads.deleteSession(created.recordId, true), { action: "deleted" });
  assert.equal(count(events, "agent_scanned"), scans);
  assert.equal(await reads.conversation(created.recordId), null);
});

test("复合 identity 保留跨 agent/source 碰撞，record-only 操作稳定 fail-closed", async t => {
  const root = await tempFixture(t, "panel-index-collision-"), alphaRoot = join(root, "alpha-source"),
    betaRoot = join(root, "beta-source"), data = join(root, "data");
  await mkdir(alphaRoot); await mkdir(betaRoot); await mkdir(data, { mode: 0o700 });
  const activeId = uuid(71), activeRecord = externalRecordId("alpha", "active", activeId);
  await writeFile(join(alphaRoot, `${activeId}.jsonl`), transcript(activeId, "collision needle active"));
  await createPanelSession(data, "alpha", panelDocument("panel-cross-source", "collision needle panel"),
    { recordId: activeRecord });
  for (const agentId of ["alpha", "beta"]) {
    await createPanelSession(data, agentId, panelDocument(`panel-${agentId}`, `collision needle ${agentId}`),
      { recordId: "duplicate-record" });
  }
  const agents = [{ agentId: "alpha", sessionsRoot: alphaRoot }, { agentId: "beta", sessionsRoot: betaRoot }];
  const index = new SessionReadIndex(agents, data), reads = new SessionReadData(agents, data, index);
  const listed = await reads.sessions(undefined, null, true);
  assert.equal(listed.filter(item => item.recordId === "duplicate-record").length, 2);
  assert.equal(listed.filter(item => item.recordId === activeRecord).length, 2);
  assert.equal((await reads.search("collision needle") as unknown[]).length, 4,
    "列表和搜索必须保留所有复合 identity，而不能按 recordId 覆盖");
  assert.equal(await reads.conversation("duplicate-record"), null);
  assert.equal(await reads.conversation(activeRecord), null);
  await assert.rejects(reads.updateSession("duplicate-record", { title: "ambiguous" }), /SESSION_NOT_FOUND/);
  const attachments = new PanelAttachmentApi(data, ["alpha", "beta"], index);
  await assert.rejects(attachments.upload("duplicate-record", {
    fileName: "fixture.txt", mimeType: "text/plain", bytes: Buffer.from("fixture")
  }), /PANEL_SESSION_NOT_FOUND/);

  await updatePanelMetadata(data, "beta", "duplicate-record", current => ({ ...current, archived: true }));
  await deletePanelSession(data, "beta", "duplicate-record"); index.forgetPanel("beta", "duplicate-record");
  assert.equal((await index.lookup("duplicate-record"))?.agentId, "alpha",
    "精确删除一个 identity 不得移除另一个 agent 的同 ID 记录");
  index.forgetPanel("alpha", activeRecord);
  assert.equal((await index.lookup(activeRecord))?.sourceKind, "active",
    "精确移除 panel identity 不得移除同 agent 的 external identity");
  await index.refreshPanel("alpha", activeRecord);
  assert.equal(await index.lookup(activeRecord), undefined, "重新加入第二候选后仍须 fail-closed");
});

test("权威 create/update/fork/edit 提交后索引刷新失败不反转成功且可由全量快照自愈", async t => {
  const root = await tempFixture(t, "panel-index-post-commit-"), sessions = join(root, "source"), data = join(root, "data");
  await mkdir(sessions); await mkdir(data, { mode: 0o700 });
  const sourceId = uuid(72); await writeFile(join(sessions, `${sourceId}.jsonl`), transcript(sourceId, "source for fork"));
  let armed = false, failures = 0;
  const index = new SessionReadIndex([{ agentId: "fixture", sessionsRoot: sessions }], data, {
    beforeTargetRefresh: identity => {
      if (armed && identity.sourceKind === "panel") {
        armed = false; failures++; throw new Error("fixture post-publish refresh failure");
      }
    }
  });
  const reads = new SessionReadData([{ agentId: "fixture", sessionsRoot: sessions }], data, index);
  await index.initialize();
  const failNextRefresh = async (operation: () => Promise<unknown>): Promise<unknown> => {
    const expected = failures + 1; armed = true; const result = await operation();
    await waitFor(() => failures === expected, "post-publish refresh failure"); return result;
  };
  const created = await failNextRefresh(() => reads.createPanel("fixture", "created")) as { recordId: string; revision: string };
  assert.equal((await loadPanelSession(data, "fixture", created.recordId)).metadata.title, "created");
  assert.match(created.revision, /^\d+:\d+(?:\.\d+)?$/, "create DTO revision 来自发布前已 fsync 的 transcript stat");
  assert.equal(created.revision, (await inspectPanelSession(data, "fixture", created.recordId))?.revision,
    "发布前捕获的 revision 必须精确匹配已发布权威 transcript");
  assert.ok(await reads.conversation(created.recordId), "一次正常重试应从标脏 locator 自愈");
  const updated = await failNextRefresh(() => reads.updateSession(created.recordId, { title: "committed update" })) as { title: string };
  assert.equal(updated.title, "committed update");
  assert.equal((await loadPanelSession(data, "fixture", created.recordId)).metadata.title, "committed update");

  const sourceRecord = externalRecordId("fixture", "active", sourceId), messageId = `u-${sourceId}`;
  const forked = await failNextRefresh(() => reads.fork(sourceRecord, messageId)) as { recordId: string };
  const edited = await failNextRefresh(() => reads.editAndFork(sourceRecord, messageId, "replacement")) as { recordId: string };
  assert.equal((await loadPanelSession(data, "fixture", forked.recordId)).metadata.parentRecordId, sourceRecord);
  assert.equal((await loadPanelSession(data, "fixture", edited.recordId)).metadata.parentRecordId, sourceRecord);
  assert.equal(failures, 4);
  assert.deepEqual((await reads.sessions("fixture", null, true)).filter(item =>
    [created.recordId, forked.recordId, edited.recordId].includes(item.recordId)).map(item => item.recordId).sort(),
  [created.recordId, edited.recordId, forked.recordId].sort(), "下次全量快照重建所有已提交记录");
});

test("global/per-agent epoch 使 clear 和 delete 作废在途 full/panel/targeted 发布", async t => {
  const root = await tempFixture(t, "panel-index-epoch-"), sessions = join(root, "source"), data = join(root, "data");
  await mkdir(sessions); await mkdir(data, { mode: 0o700 });
  await createPanelSession(data, "fixture", panelDocument("epoch", "epoch fixture"), { recordId: "epoch-record" });
  let block: { type: "full" | "panel" | "targeted"; reached: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; used: boolean } | undefined;
  const index = new SessionReadIndex([{ agentId: "fixture", sessionsRoot: sessions }], data, {
    beforePublish: async probe => {
      if (block && !block.used && probe.type === block.type) {
        block.used = true; block.reached.resolve(); await block.release.promise;
      }
    }
  });
  const arm = (type: "full" | "panel" | "targeted") => block = { type, reached: deferred(), release: deferred(), used: false };

  arm("full"); const coldSnapshot = index.snapshot();
  await withTimeout(block!.reached.promise, "cold full publish gate"); index.clear(); block!.release.resolve();
  assert.deepEqual((await coldSnapshot).map(item => item.recordId), ["epoch-record"],
    "被 clear 作废的 cold snapshot 必须重试而不是返回空库");

  await updatePanelMetadata(data, "fixture", "epoch-record", current => ({ ...current, title: "targeted" }));
  arm("targeted"); const targeted = index.refreshPanel("fixture", "epoch-record");
  await withTimeout(block!.reached.promise, "targeted publish gate"); index.clear(); block!.release.resolve();
  assert.equal(await targeted, undefined, "clear 后旧 targeted snapshot 不得重新发布");
  assert.equal((await index.snapshot())[0]?.metadata.title, "targeted");

  index.clear(); arm("full"); const deletingSnapshot = index.snapshot();
  await withTimeout(block!.reached.promise, "deleting full publish gate");
  await updatePanelMetadata(data, "fixture", "epoch-record", current => ({ ...current, archived: true }));
  await deletePanelSession(data, "fixture", "epoch-record"); index.forgetPanel("fixture", "epoch-record");
  block!.release.resolve();
  assert.deepEqual(await deletingSnapshot, [], "delete tombstone/epoch 必须使旧 full scan 重试且不能复活记录");

  await createPanelSession(data, "fixture", panelDocument("panel-epoch", "panel epoch fixture"),
    { recordId: "panel-epoch-record" });
  arm("panel"); const coldPanelSnapshot = index.snapshotPanelSessions(["fixture"]);
  await withTimeout(block!.reached.promise, "cold panel publish gate"); index.clear(); block!.release.resolve();
  assert.deepEqual((await coldPanelSnapshot).map(item => item.recordId), ["panel-epoch-record"],
    "被 clear 作废的 panel-only snapshot 必须重试而不是返回空库");

  arm("panel"); const deletingPanelSnapshot = index.snapshotPanelSessions(["fixture"]);
  await withTimeout(block!.reached.promise, "deleting panel publish gate");
  await updatePanelMetadata(data, "fixture", "panel-epoch-record", current => ({ ...current, archived: true }));
  await deletePanelSession(data, "fixture", "panel-epoch-record"); index.forgetPanel("fixture", "panel-epoch-record");
  block!.release.resolve();
  assert.deepEqual(await deletingPanelSnapshot, [],
    "delete tombstone/epoch 必须使旧 panel-only scan 重试且不能复活记录");
});

test("warm direct lookup 仅探测 exact source root，统计真实 lstat/readdir/open/read 调用", async t => {
  const root = await tempFixture(t, "panel-index-direct-io-"), alphaRoot = join(root, "alpha-source"),
    betaRoot = join(root, "beta-source"), missingBeta = join(root, "beta-away"), data = join(root, "data");
  await mkdir(alphaRoot); await mkdir(betaRoot); await mkdir(data, { mode: 0o700 });
  const alphaId = uuid(73), betaId = uuid(74);
  await writeFile(join(alphaRoot, `${alphaId}.jsonl`), transcript(alphaId, "alpha old"));
  await writeFile(join(betaRoot, `${betaId}.jsonl`), transcript(betaId, "beta old"));
  await createPanelSession(data, "alpha", panelDocument("direct-panel", "panel direct"), { recordId: "panel-direct" });
  const calls = { lstat: [] as string[], readdir: [] as string[], open: [] as string[], read: 0 };
  const fileSystem: SessionReadIndexFileSystem = {
    lstat: async path => { calls.lstat.push(path); return await lstat(path); },
    readdir: async path => { calls.readdir.push(path); return await readdir(path); },
    open: async (path, flags) => {
      calls.open.push(path); const handle = await open(path, flags);
      return { stat: async () => await handle.stat(), close: async () => await handle.close(),
        read: async (buffer, offset, length, position) => {
          calls.read++; return await handle.read(buffer, offset, length, position);
        } };
    }
  };
  const index = new SessionReadIndex([
    { agentId: "alpha", sessionsRoot: alphaRoot }, { agentId: "beta", sessionsRoot: betaRoot }
  ], data, { fileSystem });
  await index.initialize(); await rename(betaRoot, missingBeta);
  calls.lstat.length = 0; calls.readdir.length = 0; calls.open.length = 0; calls.read = 0;
  assert.equal((await index.lookup("panel-direct"))?.sourceKind, "panel");
  assert.equal(calls.lstat.length + calls.readdir.length + calls.open.length + calls.read, 0,
    "panel direct lookup 不得探测任何 external root");

  await writeFile(join(alphaRoot, `${alphaId}.jsonl`), transcript(alphaId, "alpha changed and longer"));
  assert.equal((await index.lookup(externalRecordId("alpha", "active", alphaId)))?.sourceKind, "active");
  assert.equal(calls.readdir.length, 0); assert.ok(calls.lstat.length >= 3);
  assert.equal(calls.open.length, 1); assert.ok(calls.read > 0);
  assert.equal([...calls.lstat, ...calls.open].every(path => path === alphaRoot || path.startsWith(`${alphaRoot}/`)), true,
    "external direct lookup 只验证自身 root/file，不得触碰无关 agent root");
});

test("并发 refresh 完成顺序不改变稳定 DTO tie-break，生产 DI 合并且拒绝第二套错配索引", async t => {
  const root = await tempFixture(t, "panel-index-order-di-"), alphaRoot = join(root, "alpha"),
    betaRoot = join(root, "beta"), data = join(root, "data");
  await mkdir(alphaRoot); await mkdir(betaRoot); await mkdir(data, { mode: 0o700 });
  const alphaId = uuid(75), betaId = uuid(76), fixed = new Date("2026-07-11T00:00:00.000Z");
  const alphaPath = join(alphaRoot, `${alphaId}.jsonl`), betaPath = join(betaRoot, `${betaId}.jsonl`);
  await writeFile(alphaPath, transcript(alphaId, "same timestamp")); await writeFile(betaPath, transcript(betaId, "same timestamp"));
  await utimes(alphaPath, fixed, fixed); await utimes(betaPath, fixed, fixed);
  const agents = [{ agentId: "alpha", sessionsRoot: alphaRoot }, { agentId: "beta", sessionsRoot: betaRoot }];
  const orderWithBlockedAgent = async (blockedAgent: string): Promise<string[]> => {
    const reached = deferred(), release = deferred(); let used = false;
    const index = new SessionReadIndex(agents, data, { beforePublish: async probe => {
      if (!used && probe.type === "full" && probe.agentId === blockedAgent) {
        used = true; reached.resolve(); await release.promise;
      }
    } });
    const reads = new SessionReadData(agents, data, index), pending = reads.sessions(undefined, null, true);
    await withTimeout(reached.promise, `${blockedAgent} publish gate`); release.resolve();
    return (await pending).map(item => item.agentId);
  };
  assert.deepEqual(await orderWithBlockedAgent("alpha"), ["alpha", "beta"]);
  assert.deepEqual(await orderWithBlockedAgent("beta"), ["alpha", "beta"]);

  assert.deepEqual(mergeSessionIndexAgents([agents[0]!], ["alpha", "beta"]), [agents[0]!, { agentId: "beta" }]);
  const runtimeOnly = await createPanelSession(data, "beta", panelDocument("runtime-only", "runtime only"),
    { recordId: "runtime-only-record" });
  const shared = new SessionReadIndex(mergeSessionIndexAgents([agents[0]!], ["beta"]), data);
  const reads = new SessionReadData([agents[0]!], data, shared);
  const attachments = new PanelAttachmentApi(data, ["beta"], shared);
  assert.equal(reads.sessionIndex(), shared); await attachments.initialize();
  assert.equal((await reads.sessions(undefined, null, true)).some(item => item.agentId === "beta"), false,
    "共享索引的 runtime-only agent 不得扩张 read API allowlist");
  assert.equal(await reads.conversation(runtimeOnly.recordId), null,
    "runtime-only recordId 不得通过 direct read 绕过 read agent allowlist");
  await assert.rejects(reads.updateSession(runtimeOnly.recordId, { title: "not allowed" }), /SESSION_NOT_FOUND/);
  assert.equal((await attachments.upload(runtimeOnly.recordId, {
    fileName: "fixture.txt", mimeType: "text/plain", bytes: Buffer.from("fixture")
  })).fileName, "fixture.txt", "附件 API 必须复用同一索引读取 runtime-only panel owner");
  const runtimeAgentRoot = join(data, "sessions", "beta"); await chmod(runtimeAgentRoot, 0o777);
  assert.equal((await reads.sessions(undefined, null, true)).every(item => item.agentId === "alpha"), true,
    "read snapshot 只扫描 read allowlist，不得被不安全的 runtime-only agent 拖垮");
  await chmod(runtimeAgentRoot, 0o700); await rename(alphaRoot, join(root, "alpha-away"));
  const second = await attachments.upload(runtimeOnly.recordId, {
    fileName: "second.txt", mimeType: "text/plain", bytes: Buffer.from("second")
  });
  const downloaded = await attachments.download(second.id);
  assert.equal(downloaded?.fileName, "second.txt",
    "attachment snapshot 只扫描 runtime allowlist，不得探测离线 read-only root");
  assert.throws(() => new SessionReadData([agents[0]!], join(root, "other-data"), shared), /READ_INDEX_CONFIGURATION_MISMATCH/);
  assert.throws(() => new PanelAttachmentApi(data, ["missing"], shared), /READ_INDEX_CONFIGURATION_MISMATCH/);
});
