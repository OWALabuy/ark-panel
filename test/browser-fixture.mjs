import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createPanelServer } from "../dist/src/server/app.js";
import { passwordHash } from "../dist/src/server/auth.js";

const FIXED_NOW = Date.parse("2030-01-02T03:04:05.000Z");
const PREVIEW_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const FIXTURE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const terminal = status => ["completed", "failed", "aborted"].includes(status);

function oneShotGate() {
  let pending;
  return {
    arm() {
      if (pending) throw new Error("Fixture gate is already armed");
      let release;
      const promise = new Promise(resolveGate => { release = resolveGate; });
      pending = { promise, release };
    },
    async wait() {
      const current = pending;
      if (!current) return;
      await current.promise;
      if (pending === current) pending = undefined;
    },
    release() {
      const current = pending;
      if (!current) throw new Error("Fixture gate is not armed");
      pending = undefined;
      current.release();
    },
    releaseIfArmed() {
      const current = pending;
      if (!current) return;
      pending = undefined;
      current.release();
    }
  };
}

function initialConversation(recordId, sourceKind, title, entries) {
  return {
    recordId,
    agentId: "fixture",
    sourceKind,
    title,
    revision: "1",
    updatedAt: "2030-01-02T03:04:05.000Z",
    messageCount: entries.length,
    archived: false,
    memoryDisposition: "scratch",
    status: {
      modelOverride: null,
      thinkingLevel: "medium",
      reasoningLevel: null,
      contextBudget: { estimatedTokens: 12000, budgetTokens: 200000, percentage: 6, method: "utf8-bytes-upper-bound-v3" },
      contextUsage: { source: "openclaw-session", totalTokens: 12345, contextTokens: 200000, totalTokensFresh: true, percentage: 6 },
      lastActiveAt: "2030-01-02T03:04:05.000Z"
    },
    document: { header: { type: "session" }, entries }
  };
}

function createFixtureState(externalImages) {
  const conversations = new Map([
    ["fixture-1", initialConversation("fixture-1", "panel", "脱敏浏览器验收", [
      { type: "message", id: "u1", parentId: null, timestamp: "2030-01-02T03:03:00.000Z", message: { role: "user", content: "请检查完全虚构的项目。" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2030-01-02T03:04:00.000Z", stopReason: "stop", message: { role: "assistant", content: [
        { type: "text", text: `## 脱敏安全正文\n\n<script>globalThis.__fixtureXss = true</script>\n\n[危险链接](javascript:globalThis.__fixtureXss=true)\n\n内联公式 $x^2$。\n\n![虚构外部图片](${externalImages.allowedUrl})\n\n![同主机异端口图片](${externalImages.sameHostUrl})` },
        { type: "attachment", attachmentId: "fixture-image", fileName: "fictional-pixel.png", mimeType: "image/png", sizeBytes: PREVIEW_PNG.length, disposition: "input" }
      ] } }
    ])],
    ["fixture-2", initialConversation("fixture-2", "panel", "独立可写会话", [
      { type: "message", id: "fixture-2-u1", parentId: null, timestamp: "2030-01-02T03:02:00.000Z", message: { role: "user", content: "这个会话用于验证会话级运行锁。" } }
    ])],
    ["fixture-active", initialConversation("fixture-active", "active", "只读活会话示例", [
      { type: "message", id: "active-u1", parentId: null, timestamp: "2030-01-02T03:01:00.000Z", message: { role: "user", content: "这是虚构且只读的上游来源。" } }
    ])]
  ]);
  return {
    conversations,
    runs: new Map(),
    listeners: new Map(),
    uploads: new Map(),
    calls: {
      createPanels: [],
      generationCreates: [],
      generationGets: [],
      activeRunGets: [],
      generationRequests: [],
      uploads: []
    },
    nextRecord: 3,
    nextEntry: 1,
    nextTick: 1
  };
}

function snapshotConversation(value) {
  return structuredClone(value);
}

export async function startBrowserFixture({ port = 0 } = {}) {
  const requests = {
    allowed: { count: 0, refererPresent: false, panelCookiePresent: false },
    sameHost: { count: 0 }
  };
  const probe = createServer((req, res) => {
    const pathname = new URL(req.url || "/", "http://fixture.invalid").pathname;
    if (pathname === "/allowed.png") {
      requests.allowed.count++;
      requests.allowed.refererPresent ||= typeof req.headers.referer === "string";
      requests.allowed.panelCookiePresent ||= /(?:^|;\s*)panel_(?:session|csrf)=/.test(req.headers.cookie || "");
    } else if (pathname === "/same-host.png") requests.sameHost.count++;
    else { res.writeHead(404, { "cache-control": "no-store" }); res.end(); return; }
    res.writeHead(200, { "content-type": "image/png", "content-length": PREVIEW_PNG.length,
      "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(PREVIEW_PNG);
  });
  await new Promise((resolveListen, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolveListen);
  });
  const probeAddress = probe.address();
  if (!probeAddress || typeof probeAddress === "string") {
    await new Promise(resolveClose => probe.close(() => resolveClose()));
    throw new Error("Fixture probe did not expose a TCP address");
  }
  const externalImages = {
    allowedUrl: `http://localhost:${probeAddress.port}/allowed.png`,
    sameHostUrl: `http://127.0.0.1:${probeAddress.port}/same-host.png`,
    requests
  };
  const state = createFixtureState(externalImages);
  const gates = { createPanel: oneShotGate(), generationCreate: oneShotGate() };
  const stamp = () => new Date(FIXED_NOW + state.nextTick++ * 1000).toISOString();
  const setConversationStatus = (recordId, patch) => {
    const value = state.conversations.get(recordId);
    if (!value) throw new Error("PANEL_SESSION_NOT_FOUND");
    value.status = { ...value.status, ...structuredClone(patch) };
    return snapshotConversation(value);
  };
  const characterizeCompactionUsage = (recordId, contextUsage) => {
    const value = state.conversations.get(recordId);
    if (!value) throw new Error("PANEL_SESSION_NOT_FOUND");
    const parentId = value.document.entries.at(-1)?.id;
    if (typeof parentId !== "string") throw new Error("FIXTURE_COMPACTION_PARENT_MISSING");
    const id = `fixture-compaction-${state.nextEntry++}`;
    value.document.entries.push({ type: "compaction", id, parentId, timestamp: stamp(), summary: "虚构压缩摘要",
      firstKeptEntryId: parentId, tokensBefore: Number(value.status.contextUsage?.totalTokens) || 0 });
    value.messageCount = value.document.entries.length;
    value.revision = String(Number(value.revision) + 1);
    value.updatedAt = stamp();
    return setConversationStatus(recordId, { contextUsage });
  };
  const sessionRef = value => ({ recordId: value.recordId, agentId: value.agentId, sourceKind: "panel", revision: value.revision });
  const createPanel = (agentId, title) => {
    if (agentId !== "fixture") throw new Error("AGENT_NOT_ALLOWED");
    const id = `fixture-${state.nextRecord++}`;
    const value = initialConversation(id, "panel", title || "未命名会话", []);
    value.updatedAt = stamp();
    state.conversations.set(id, value);
    return value;
  };
  const fork = (recordId, messageId) => {
    const source = state.conversations.get(recordId);
    if (!source) throw new Error("PANEL_SESSION_NOT_FOUND");
    const end = source.document.entries.findIndex(entry => entry.id === messageId);
    if (end < 0) throw new Error("MESSAGE_NOT_FOUND");
    const created = createPanel(source.agentId, `${source.title} · fork`);
    created.document.entries = structuredClone(source.document.entries.slice(0, end + 1));
    created.messageCount = created.document.entries.length;
    created.revision = "1";
    return sessionRef(created);
  };
  const reads = {
    async agents() { return [{ id: "fixture", label: "Fixture", sessionCount: state.conversations.size }]; },
    async sessions(agentId, archived = false) {
      if (agentId && agentId !== "fixture") return [];
      return [...state.conversations.values()]
        .filter(value => Boolean(value.archived) === archived)
        .map(({ document: _document, status: _status, ...record }) => structuredClone(record));
    },
    async conversation(recordId) {
      const value = state.conversations.get(recordId);
      return value ? snapshotConversation(value) : null;
    },
    async projects() { return ["虚构项目"]; },
    async search(query) {
      const needle = query.toLowerCase();
      return [...state.conversations.values()]
        .filter(value => JSON.stringify(value.document).toLowerCase().includes(needle))
        .map(({ document: _document, status: _status, ...record }) => ({ ...structuredClone(record), hits: [{ entryId: "a1", role: "assistant", snippet: "虚构搜索命中：浏览器验收内容" }] }));
    },
    async createPanel(agentId, title) {
      state.calls.createPanels.push({ agentId, title });
      await gates.createPanel.wait();
      return snapshotConversation(createPanel(agentId, title));
    },
    async fork(recordId, messageId) { return fork(recordId, messageId); },
    async editAndFork(recordId, messageId, replacement) {
      const created = fork(recordId, messageId);
      const value = state.conversations.get(created.recordId);
      const target = value.document.entries.find(entry => entry.id === messageId);
      target.message.content = replacement;
      value.title = "编辑重发分支";
      return created;
    },
    async updateSession(recordId, patch) {
      const value = state.conversations.get(recordId);
      if (!value) throw new Error("PANEL_SESSION_NOT_FOUND");
      Object.assign(value, patch, { updatedAt: stamp() });
      return snapshotConversation(value);
    },
    async deleteSession(recordId) {
      const value = state.conversations.get(recordId);
      if (!value) throw new Error("PANEL_SESSION_NOT_FOUND");
      if (value.sourceKind === "panel") { state.conversations.delete(recordId); return { action: "deleted" }; }
      value.archived = true;
      return { action: "hidden" };
    },
    async exportMarkdown(recordId) {
      const value = state.conversations.get(recordId);
      return value ? { filename: `${recordId}.md`, markdown: `# ${value.title}\n\nFictional browser fixture.\n` } : null;
    }
  };

  function publicRun(run) {
    const { message: _message, expectedRevision: _expectedRevision, attachmentIds: _attachmentIds,
      requestOutputs: _requestOutputs, droppedSubscription: _droppedSubscription, ...visible } = run;
    return { ...structuredClone(visible), canAbort: !terminal(run.status) && ["accepted", "running", "materializing"].includes(run.status) };
  }
  function publish(run) {
    run.sequence++;
    run.updatedAt = stamp();
    for (const listener of state.listeners.get(run.runId) || []) listener(publicRun(run));
    if (terminal(run.status)) state.listeners.delete(run.runId);
  }
  function activeRun(recordId) {
    return [...state.runs.values()].find(run => run.recordId === recordId && !terminal(run.status));
  }
  function startRun(run) {
    if (terminal(run.status)) return;
    run.status = "running";
    run.startedAt = stamp();
    run.stream = { revision: 1, state: "streaming", text: "第一段虚构实时预览", tools: [{ callId: "fixture-tool-1", name: "fixture_lookup", phase: "started", args: { query: "fictional-only" } }], items: [{ type: "text", sequence: 1, text: "第一段虚构实时预览" }, { type: "tool", sequence: 2, updatedSequence: 2, callId: "fixture-tool-1", name: "fixture_lookup", phase: "started", args: { query: "fictional-only" } }] };
    publish(run);
  }
  function advanceRun(recordId) {
    const run = activeRun(recordId);
    if (!run) throw new Error(`No active fixture run for ${recordId}`);
    run.stream = { revision: 2, state: "streaming", text: "第一段虚构实时预览\n\n第二段仍为脱敏内容", tools: [{ callId: "fixture-tool-1", name: "fixture_lookup", phase: "completed", args: { query: "fictional-only" }, result: { answer: "fixture-result" }, isError: false }], items: [{ type: "text", sequence: 1, text: "第一段虚构实时预览" }, { type: "tool", sequence: 2, updatedSequence: 3, callId: "fixture-tool-1", name: "fixture_lookup", phase: "completed", args: { query: "fictional-only" }, result: { answer: "fixture-result" }, isError: false }, { type: "text", sequence: 4, text: "第二段仍为脱敏内容" }] };
    publish(run);
    return publicRun(run);
  }
  function completeRun(recordId) {
    const run = activeRun(recordId);
    if (!run) throw new Error(`No active fixture run for ${recordId}`);
    const value = state.conversations.get(recordId);
    if (!value) throw new Error("PANEL_SESSION_NOT_FOUND");
    const suffix = state.nextEntry++;
    value.document.entries.push(
      { type: "message", id: `fixture-user-${suffix}`, timestamp: stamp(), message: { role: "user", content: run.message } },
      { type: "message", id: `fixture-assistant-${suffix}`, timestamp: stamp(), stopReason: "stop", message: { role: "assistant", content: [{ type: "text", text: `虚构 SSE 回复：${run.message}` }] } }
    );
    value.messageCount = value.document.entries.length;
    value.revision = String(Number(value.revision) + 1);
    value.updatedAt = stamp();
    run.status = "completed";
    run.finishedAt = stamp();
    run.revision = value.revision;
    delete run.stream;
    publish(run);
    return publicRun(run);
  }
  function failRun(recordId) {
    const run = activeRun(recordId);
    if (!run) throw new Error(`No active fixture run for ${recordId}`);
    run.status = "failed";
    run.error = { code: "FIXTURE_GENERATION_FAILED", message: "虚构生成失败" };
    run.finishedAt = stamp();
    delete run.stream;
    publish(run);
    return publicRun(run);
  }
  const generation = {
    async create(recordId, message, runId = crypto.randomUUID(), expectedRevision, attachmentIds = [], requestOutputs = false) {
      const normalizedAttachments = [...attachmentIds];
      state.calls.generationRequests.push({ method: "POST", recordId, runId });
      state.calls.generationCreates.push({ recordId, message, runId, expectedRevision,
        attachmentIds: normalizedAttachments, requestOutputs });
      await gates.generationCreate.wait();
      const existing = state.runs.get(runId);
      if (existing) {
        if (existing.recordId !== recordId || existing.message !== message || existing.expectedRevision !== expectedRevision ||
          JSON.stringify(existing.attachmentIds) !== JSON.stringify(normalizedAttachments) || existing.requestOutputs !== requestOutputs) throw new Error("IDEMPOTENCY_KEY_REUSED");
        return { ...publicRun(existing), newlyCreated: false };
      }
      if (!state.conversations.has(recordId)) throw new Error("PANEL_SESSION_NOT_FOUND");
      if (activeRun(recordId)) throw new Error("SESSION_BUSY");
      const now = stamp();
      const run = { runId, recordId, message, expectedRevision, attachmentIds: normalizedAttachments,
        requestOutputs, status: "accepted", sequence: 1, createdAt: now, updatedAt: now };
      state.runs.set(runId, run);
      queueMicrotask(() => startRun(run));
      return { ...publicRun(run), newlyCreated: true };
    },
    async get(runId) {
      state.calls.generationRequests.push({ method: "GET_RUN", runId });
      state.calls.generationGets.push(runId);
      const run = state.runs.get(runId);
      return run ? publicRun(run) : undefined;
    },
    async subscribe(runId, listener) {
      const run = state.runs.get(runId);
      if (!run) return undefined;
      listener(publicRun(run));
      if (terminal(run.status)) return () => {};
      if (run.message === "SSE 断线后终态验收" && !run.droppedSubscription) {
        run.droppedSubscription = true;
        return undefined;
      }
      const set = state.listeners.get(runId) || new Set();
      set.add(listener);
      state.listeners.set(runId, set);
      return () => { set.delete(listener); if (!set.size) state.listeners.delete(runId); };
    },
    async abortRun(runId) {
      const run = state.runs.get(runId);
      if (!run) return undefined;
      if (!terminal(run.status)) { run.status = "aborted"; run.finishedAt = stamp(); delete run.stream; publish(run); }
      return publicRun(run);
    },
    async activeForRecord(recordId) {
      state.calls.generationRequests.push({ method: "GET_ACTIVE", recordId });
      state.calls.activeRunGets.push(recordId);
      const run = activeRun(recordId);
      return run ? publicRun(run) : undefined;
    }
  };

  let settings = { version: 1, locale: "zh-CN", appearance: { theme: "light", accent: "default" }, conversation: { showStatus: true } };
  const experience = {
    assertAgent(agentId) { if (agentId !== "fixture") throw new Error("AGENT_NOT_ALLOWED"); },
    async settings() { return structuredClone(settings); },
    async patchSettings(patch) {
      settings = { version: 1, locale: patch.locale ?? settings.locale, appearance: { ...settings.appearance, ...patch.appearance }, conversation: { ...settings.conversation, ...patch.conversation } };
      return structuredClone(settings);
    },
    async avatar() { return undefined; },
    async putAvatar() { throw new Error("FIXTURE_AVATAR_DISABLED"); },
    async deleteAvatar() { return false; }
  };
  const attachments = {
    async upload(recordId, input) {
      if (!state.conversations.has(recordId)) throw new Error("PANEL_SESSION_NOT_FOUND");
      const id = `fixture-upload-${state.uploads.size + 1}`;
      state.calls.uploads.push({ recordId, attachmentId: id, fileName: input.fileName,
        mimeType: input.mimeType, sizeBytes: input.bytes.length });
      state.uploads.set(id, { recordId, fileName: input.fileName, mimeType: input.mimeType, bytes: Buffer.from(input.bytes) });
      return { id, attachmentId: id, fileName: input.fileName, mimeType: input.mimeType, sizeBytes: input.bytes.length };
    },
    async download(attachmentId) {
      if (attachmentId === "fixture-image") return { fileName: "fictional-pixel.png", mimeType: "image/png", bytes: PREVIEW_PNG };
      const value = state.uploads.get(attachmentId);
      return value ? { fileName: value.fileName, mimeType: value.mimeType, bytes: value.bytes } : undefined;
    },
    async preview(attachmentId) {
      if (attachmentId === "fixture-image") return { mimeType: "image/png", bytes: PREVIEW_PNG };
      const value = state.uploads.get(attachmentId);
      return value?.mimeType === "image/png" ? { mimeType: value.mimeType, bytes: value.bytes } : undefined;
    }
  };

  const allowedHosts = [];
  const publicOrigins = [];
  const server = createPanelServer({
    auth: { username: "fixture", passwordHash: passwordHash("fixture-password", "00112233445566778899aabbccddeeff"), sessionSecret: "fixture-session-secret-32-characters-long" },
    publicDir: fileURLToPath(new URL("../src/frontend/", import.meta.url)),
    now: () => FIXED_NOW,
    reads,
    generation,
    experience,
    attachments,
    allowedHosts,
    publicOrigins
  });
  try {
    await new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolveListen);
    });
  } catch (error) {
    await new Promise(resolveClose => probe.close(() => resolveClose()));
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not expose a TCP address");
  const origin = `http://127.0.0.1:${address.port}`;
  allowedHosts.push(`127.0.0.1:${address.port}`);
  publicOrigins.push(origin);

  let closing;
  let uploadRoot = "";
  const uploadPaths = [];
  return {
    origin,
    state,
    externalImages,
    activeRun: recordId => { const run = activeRun(recordId); return run ? publicRun(run) : undefined; },
    advanceRun,
    completeRun,
    failRun,
    setConversationStatus,
    characterizeCompactionUsage,
    gates,
    makeUploadFile(name, content = "fictional browser attachment\n") {
      if (!uploadRoot) uploadRoot = mkdtempSync(join(FIXTURE_ROOT, ".browser-fixture-"));
      const path = join(uploadRoot, name);
      writeFileSync(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      uploadPaths.push(path);
      return path;
    },
    close() {
      if (closing) return closing;
      closing = (async () => {
        gates.createPanel.releaseIfArmed();
        gates.generationCreate.releaseIfArmed();
        for (const run of state.runs.values()) if (!terminal(run.status)) await generation.abortRun(run.runId);
        const closeServer = value => new Promise((resolveClose, reject) => value.close(error => error ? reject(error) : resolveClose()));
        await Promise.all([closeServer(server), closeServer(probe)]);
        for (const path of uploadPaths) {
          try { unlinkSync(path); }
          catch (error) { if (error?.code !== "ENOENT") throw error; }
        }
        if (uploadRoot) {
          try { rmdirSync(uploadRoot); }
          catch (error) { if (error?.code !== "ENOENT") throw error; }
        }
      })();
      return closing;
    }
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const requestedPort = Number(process.env.PANEL_BROWSER_PORT || "0");
  const fixture = await startBrowserFixture({ port: requestedPort });
  process.stdout.write(`${fixture.origin}\n`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void fixture.close());
}
