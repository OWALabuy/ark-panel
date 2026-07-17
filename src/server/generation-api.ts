import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { JsonObject, TranscriptDocument } from "../domain/transcript.js";
import { commitPanelTranscript, listPanelSessions, loadPanelSession } from "../storage/panel-sessions.js";
import type { BridgeLifecycleEvent, BridgeOrphanCleanupRequest, BridgeRequest, BridgeResult, BridgeStreamEvent } from "../gateway/adapter.js";
import type { GenerationApi } from "./app.js";
import { ConservativeContextBudget, type ContextBudgetEstimator } from "../domain/context-budget.js";
import { ContextBudgetExceededError } from "../domain/context-budget.js";
import { SessionOperationCoordinator } from "./session-operation.js";
import { PanelRunStore, publicRun, terminalRunStatuses, type PanelRunRecord, type PublicPanelRun, type PublicRunStream, type PublicRunTool } from "./run-store.js";
import { GatewayRunError } from "../gateway/cli-client.js";

interface BridgeRunner { generate(request: BridgeRequest): Promise<BridgeResult>; cleanupOrphanedSession?(request: BridgeOrphanCleanupRequest): Promise<string[]> }
export interface GenerationConfig { dataRoot: string; runtimeByAgent: ReadonlyMap<string, string>; completedCacheLimit?: number; contextBudget?: ContextBudgetEstimator; operations?: SessionOperationCoordinator }
interface InternalRunStream { public: PublicRunStream; lastAssistantSeq: number; toolSeq: Map<string, number> }

function latestEntryId(document: TranscriptDocument): string | null {
  for (let index = document.entries.length - 1; index >= 0; index--) if (typeof document.entries[index]!.id === "string") return document.entries[index]!.id as string;
  return null;
}

export class PanelGenerationApi implements GenerationApi {
  private static readonly MAX_COMPLETED = 512;
  private readonly operations: SessionOperationCoordinator;
  private readonly completed = new Map<string, { recordId: string; message: string; value: { runId: string; entries: unknown[]; revision?: string } }>();
  private readonly inflight = new Map<string, { recordId: string; message: string; promise: Promise<{ runId: string; entries: unknown[]; revision?: string }> }>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly runStore: PanelRunStore;
  private readonly executions = new Map<string, Promise<void>>();
  private readonly creations = new Map<string, { requestHash: string; promise: Promise<PublicPanelRun> }>();
  private creationGate: Promise<void> = Promise.resolve();
  private readonly plannedUserIds = new Map<string, string>();
  private readonly abortRequested = new Set<string>();
  private readonly transitionTails = new Map<string, Promise<void>>();
  private readonly listeners = new Map<string, Set<(run: PublicPanelRun) => void>>();
  private readonly streams = new Map<string, InternalRunStream>();
  private readonly streamTails = new Map<string, Promise<void>>();
  private initialization?: Promise<void>;
  constructor(private readonly bridge: BridgeRunner, private readonly config: GenerationConfig) {
    if (config.completedCacheLimit !== undefined && (!Number.isInteger(config.completedCacheLimit) || config.completedCacheLimit < 1)) throw new Error("completedCacheLimit 必须是正整数");
    this.operations = config.operations ?? new SessionOperationCoordinator();
    this.runStore = new PanelRunStore(config.dataRoot);
  }
  completedCacheSize(): number { return this.completed.size; }

  // 显式停止：按 runId 中断正在进行的推理。与 HTTP 连接解耦，连接断开不会触发这里，
  // 只有用户主动点“停止”才走这条路径。返回是否命中一个进行中的 run。
  abort(runId: string): boolean {
    const controller = this.controllers.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** Startup recovery replays only accepted work and commits already-staged results. A run that reached the
   * gateway without durable entries is never resent; it is cleaned up and receives a stable orphan diagnosis. */
  async initialize(): Promise<void> {
    if (!this.initialization) this.initialization = (async () => {
      await this.runStore.initialize();
      for (const record of await this.runStore.list()) {
        if (terminalRunStatuses.has(record.status)) {
          if (record.cleanupPending && await this.cleanupOrphan(record)) await this.runStore.put({ ...record, sequence: record.sequence + 1, cleanupPending: false, updatedAt: new Date().toISOString() });
          continue;
        }
        const now = new Date().toISOString();
        const committed = record.plannedUserEntryId ? await this.committedRevision(record.recordId, record.plannedUserEntryId) : undefined;
        if (committed) { const cleaned = await this.cleanupOrphan(record); await this.runStore.put(this.scrub({ ...record, sequence: record.sequence + 1, status: "completed", updatedAt: now, finishedAt: now, revision: committed, cleanupPending: !cleaned })); }
        else if (["materializing", "committing"].includes(record.status) && record.message && record.plannedUserEntryId && record.stagedEntries) {
          try { await this.commitRecovered(record); }
          catch {
            const latest = await this.runStore.get(record.runId) ?? record;
            const recovered = latest.plannedUserEntryId ? await this.committedRevision(latest.recordId, latest.plannedUserEntryId) : undefined;
            const cleaned = await this.cleanupOrphan(latest);
            if (recovered) await this.runStore.put(this.scrub({ ...latest, sequence: latest.sequence + 1, status: "completed", updatedAt: now, finishedAt: now, revision: recovered, cleanupPending: !cleaned }));
            else await this.runStore.put(this.scrub({ ...latest, sequence: latest.sequence + 1, status: "failed", updatedAt: now, finishedAt: now, cleanupPending: !cleaned,
              error: { code: "RUN_RECOVERY_COMMIT_FAILED", message: "服务重启后无法安全提交已生成结果。" } }));
          }
        } else if (record.status === "accepted" && record.message && record.plannedUserEntryId) {
          this.plannedUserIds.set(record.runId, record.plannedUserEntryId);
          const execution = this.executeRun(record, record.message, record.expectedRevision).catch(error => { process.stderr.write(`[ark-panel] recovered run failed runId=${record.runId}: ${String(error)}\n`); }).finally(() => this.executions.delete(record.runId));
          this.executions.set(record.runId, execution);
        } else { const cleaned = await this.cleanupOrphan(record); await this.runStore.put(this.scrub({ ...record, sequence: record.sequence + 1, status: "failed", updatedAt: now, finishedAt: now, cleanupPending: !cleaned,
          error: { code: "RUN_ORPHANED_AFTER_RESTART", message: "服务重启后无法安全恢复该任务，请重新发送。" } })); }
      }
    })();
    await this.initialization;
  }

  async create(recordId: string, message: string, runId: string = randomUUID(), expectedRevision?: string): Promise<PublicPanelRun & { newlyCreated?: boolean }> {
    const requestHash = createHash("sha256").update(JSON.stringify({ recordId, message, expectedRevision: expectedRevision ?? null })).digest("hex");
    const pending = this.creations.get(runId); if (pending) { if (pending.requestHash !== requestHash) throw new Error("IDEMPOTENCY_KEY_REUSED"); return { ...await pending.promise, newlyCreated: false }; }
    const creation = this.createOnce(recordId, message, runId, expectedRevision).finally(() => this.creations.delete(runId));
    this.creations.set(runId, { requestHash, promise: creation }); return await creation;
  }

  private async createOnce(recordId: string, message: string, runId: string, expectedRevision?: string): Promise<PublicPanelRun & { newlyCreated?: boolean }> {
    await this.initialize();
    const requestHash = createHash("sha256").update(JSON.stringify({ recordId, message, expectedRevision: expectedRevision ?? null })).digest("hex");
    let release!: () => void; const previous = this.creationGate; this.creationGate = new Promise<void>(resolve => { release = resolve; }); await previous;
    let accepted: PanelRunRecord;
    try {
      const existing = await this.runStore.get(runId);
      if (existing) { if (existing.recordId !== recordId || existing.requestHash !== requestHash) throw new Error("IDEMPOTENCY_KEY_REUSED"); return { ...this.visible(existing), newlyCreated: false }; }
      const active = (await this.runStore.list()).find(item => item.recordId === recordId && !terminalRunStatuses.has(item.status));
      if (active) throw new Error("SESSION_BUSY");
      const now = new Date().toISOString(), plannedUserEntryId = randomUUID();
      accepted = { version: 1, runId, recordId, requestHash, sequence: 1, status: "accepted", createdAt: now, updatedAt: now, message,
        plannedUserEntryId, ...(expectedRevision ? { expectedRevision } : {}) };
      await this.runStore.put(accepted); this.plannedUserIds.set(runId, plannedUserEntryId);
    } finally { release(); }
    const execution = this.executeRun(accepted, message, expectedRevision).catch(error => {
      process.stderr.write(`[ark-panel] run manager failed runId=${runId}: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    }).finally(() => this.executions.delete(runId));
    this.executions.set(runId, execution);
    return { ...this.visible(accepted), newlyCreated: true };
  }

  async get(runId: string): Promise<PublicPanelRun | undefined> {
    await this.initialize(); const record = await this.runStore.get(runId); return record ? this.visible(record) : undefined;
  }

  async activeForRecord(recordId: string): Promise<PublicPanelRun | undefined> {
    await this.initialize(); const active = (await this.runStore.list()).find(item => item.recordId === recordId && !terminalRunStatuses.has(item.status)); return active ? this.visible(active) : undefined;
  }

  async subscribe(runId: string, listener: (run: PublicPanelRun) => void): Promise<(() => void) | undefined> {
    await this.initialize();
    let snapshotSent = false; const queued: PublicPanelRun[] = [];
    const buffered = (run: PublicPanelRun) => { if (!snapshotSent) queued.push(run); else listener(run); };
    const listeners = this.listeners.get(runId) ?? new Set(); listeners.add(buffered); this.listeners.set(runId, listeners);
    const record = await this.runStore.get(runId);
    if (!record) { listeners.delete(buffered); if (!listeners.size) this.listeners.delete(runId); return undefined; }
    const snapshot = this.visible(record); listener(snapshot); snapshotSent = true;
    const snapshotStreamRevision = snapshot.stream?.revision ?? -1;
    for (const run of queued.filter(run => run.sequence > snapshot.sequence || run.sequence === snapshot.sequence && (run.stream?.revision ?? -1) > snapshotStreamRevision)
      .sort((left, right) => left.sequence - right.sequence || (left.stream?.revision ?? -1) - (right.stream?.revision ?? -1))) listener(run);
    if (terminalRunStatuses.has(record.status)) { listeners.delete(buffered); return () => undefined; }
    return () => { listeners.delete(buffered); if (!listeners.size) this.listeners.delete(runId); };
  }

  async abortRun(runId: string): Promise<PublicPanelRun | undefined> {
    await this.initialize(); const record = await this.runStore.get(runId); if (!record) return undefined;
    if (terminalRunStatuses.has(record.status) || ["aborting", "committing", "committed"].includes(record.status)) return this.visible(record);
    if (record.plannedUserEntryId) { const revision = await this.committedRevision(record.recordId, record.plannedUserEntryId); if (revision) return this.visible(await this.transition(record, { status: "completed", finishedAt: new Date().toISOString(), revision })); }
    this.abortRequested.add(runId); const updated = await this.transition(record, { status: "aborting" });
    this.abort(runId);
    return this.visible(updated);
  }

  private async executeRun(accepted: PanelRunRecord, message: string, expectedRevision?: string): Promise<void> {
    let current = await this.transition(accepted, { status: "running", startedAt: new Date().toISOString() });
    try {
      if (this.abortRequested.has(accepted.runId)) throw new Error("BRIDGE_ABORTED");
      const result = await this.generate(accepted.recordId, message, new AbortController().signal, accepted.runId, expectedRevision);
      current = (await this.runStore.get(accepted.runId)) ?? current;
      current = await this.transition(current, { status: "completed", finishedAt: new Date().toISOString(), ...(result.revision ? { revision: result.revision } : {}),
        ...(result.runtimeAgentId ? { runtimeAgentId: result.runtimeAgentId } : {}), ...(result.temporarySessionId ? { temporarySessionId: result.temporarySessionId } : {}),
        ...(result.gatewayRunId ? { gatewayRunId: result.gatewayRunId } : {}) });
    } catch (error) {
      let recoverable = await this.runStore.get(accepted.runId);
      const committed = recoverable?.plannedUserEntryId ? await this.committedRevision(recoverable.recordId, recoverable.plannedUserEntryId) : undefined;
      if (recoverable && committed) { await this.transition(recoverable, { status: "completed", finishedAt: new Date().toISOString(), revision: committed }); return; }
      if (recoverable?.stagedEntries && recoverable.message && recoverable.plannedUserEntryId && !["aborting", "aborted"].includes(recoverable.status)) {
        try { await this.commitRecovered(recoverable); return; }
        catch (recoveryError) { process.stderr.write(`[ark-panel] staged run commit failed runId=${accepted.runId}: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}\n`); }
      }
      recoverable = await this.runStore.get(accepted.runId);
      const committedAfterRecovery = recoverable?.plannedUserEntryId ? await this.committedRevision(recoverable.recordId, recoverable.plannedUserEntryId) : undefined;
      if (recoverable && committedAfterRecovery) { await this.transition(recoverable, { status: "completed", finishedAt: new Date().toISOString(), revision: committedAfterRecovery }); return; }
      const gatewayCode = error instanceof GatewayRunError ? error.code : undefined;
      const abortUnconfirmed = gatewayCode === "GATEWAY_ABORT_RELEASE_TIMEOUT" || error instanceof Error && error.message === "RUN_ABORT_UNCONFIRMED";
      const aborted = error instanceof Error && error.message === "BRIDGE_ABORTED";
      const code = abortUnconfirmed ? "RUN_ABORT_UNCONFIRMED" : aborted ? "RUN_ABORTED" : gatewayCode ?? (error instanceof ContextBudgetExceededError ? error.code : error instanceof Error &&
        ["SESSION_BUSY", "REVISION_CONFLICT", "PANEL_SESSION_NOT_FOUND", "RUNTIME_NOT_CONFIGURED", "IDEMPOTENCY_KEY_REUSED", "SLASH_COMMANDS_UNSUPPORTED"].includes(error.message) ? error.message : "RUN_FAILED");
      const publicMessages: Record<string,string> = { RUN_ABORTED: "任务已停止。", SESSION_BUSY: "该会话正在生成。", REVISION_CONFLICT: "会话已更新，请刷新后重试。",
        PANEL_SESSION_NOT_FOUND: "面板会话不存在。", RUNTIME_NOT_CONFIGURED: "Agent 推理 runtime 未配置。", IDEMPOTENCY_KEY_REUSED: "重试标识已用于其他请求。",
        SLASH_COMMANDS_UNSUPPORTED: "请通过结构化命令入口执行斜杠命令。", GATEWAY_RUN_TIMEOUT: "OpenClaw 运行超时，未提交不完整结果。",
        GATEWAY_RUN_ABORTED: "OpenClaw 中止了本次运行，请重试。", GATEWAY_RUN_FAILED: "OpenClaw 运行失败，请检查服务日志后重试。",
        GATEWAY_RUN_NOT_STARTED: "任务已被 OpenClaw 接受，但在等待期限内未观察到开始执行，请重试。",
        GATEWAY_ABORT_RELEASE_TIMEOUT: "已请求 OpenClaw 停止运行，但未能确认资源释放，请稍后再试。",
        RUN_ABORT_UNCONFIRMED: "已请求停止，但未能确认 OpenClaw 已释放运行资源，请稍后再试。",
        BRIDGE_WATCH_TIMEOUT: "运行可能仍在结束处理中，但面板未能及时确认最终状态，请稍后重试。", RUN_FAILED: "生成失败，请稍后重试。" };
      if (!aborted) this.logRunFailure(accepted, recoverable, error, code);
      current = (await this.runStore.get(accepted.runId)) ?? current;
      current = await this.transition(current, { status: aborted ? "aborted" : "failed", finishedAt: new Date().toISOString(),
        error: { code, message: error instanceof ContextBudgetExceededError ? error.message : publicMessages[code] ?? "生成失败，请稍后重试。" } });
    } finally { this.plannedUserIds.delete(accepted.runId); this.abortRequested.delete(accepted.runId); }
  }

  private logRunFailure(accepted: PanelRunRecord, current: PanelRunRecord | undefined, error: unknown, code: string): void {
    const diagnostics = error instanceof GatewayRunError ? error.diagnostics : undefined;
    process.stderr.write(`${JSON.stringify({ event: "generation_run_failed", panelRunId: accepted.runId, recordId: accepted.recordId,
      runtimeAgentId: current?.runtimeAgentId, temporarySessionId: current?.temporarySessionId,
      gatewayRunId: current?.gatewayRunId ?? diagnostics?.gatewayRunId, code,
      ...(diagnostics ? { waitedMs: diagnostics.waitedMs, gatewayRunTimeoutMs: diagnostics.gatewayRunTimeoutMs,
        watcherGraceMs: diagnostics.watcherGraceMs, lastObserved: diagnostics.lastObserved ?? null } : {}) })}\n`);
  }

  private async transition(record: PanelRunRecord, patch: Partial<PanelRunRecord>): Promise<PanelRunRecord> {
    const previous = this.transitionTails.get(record.runId) ?? Promise.resolve(); let release!:()=>void;
    const currentTail = new Promise<void>(resolve=>{release=resolve}), queued = previous.then(()=>currentTail); this.transitionTails.set(record.runId, queued); await previous;
    try {
      const latest = await this.runStore.get(record.runId) ?? record;
      if (terminalRunStatuses.has(latest.status)) return latest;
      const legal: Record<PanelRunRecord["status"], readonly PanelRunRecord["status"][]> = {
        accepted: ["accepted", "running", "aborting", "failed"], running: ["running", "materializing", "committing", "aborting", "failed", "aborted"],
        materializing: ["materializing", "committing", "aborting", "failed", "aborted"], committing: ["committing", "committed", "completed", "failed"],
        committed: ["committed", "completed"], aborting: ["aborting", "aborted", "completed", "failed"], completed: [], failed: [], aborted: [] };
      if (patch.status && !legal[latest.status].includes(patch.status)) return latest;
      let next: PanelRunRecord = { ...latest, ...patch, sequence: latest.sequence + 1, updatedAt: new Date().toISOString() };
      if (terminalRunStatuses.has(next.status)) { next = this.scrub(next); this.streams.delete(next.runId); }
      await this.runStore.put(next); this.emit(next);
      if (terminalRunStatuses.has(next.status)) this.listeners.delete(next.runId);
      return next;
    } finally { release(); if (this.transitionTails.get(record.runId) === queued) this.transitionTails.delete(record.runId); }
  }

  private visible(record: PanelRunRecord): PublicPanelRun {
    const visible = publicRun(record), stream = this.streams.get(record.runId)?.public;
    return stream && !terminalRunStatuses.has(record.status) ? { ...visible, stream: { ...stream, tools: stream.tools.map(tool => ({ ...tool })) } } : visible;
  }
  private emit(record: PanelRunRecord): void { const visible = this.visible(record); for (const listener of this.listeners.get(record.runId) ?? []) listener(visible); }

  private enqueueBridgeStream(runId: string, event: BridgeStreamEvent): void {
    const previous = this.streamTails.get(runId) ?? Promise.resolve();
    const task = previous.then(async () => {
      const record = await this.runStore.get(runId);
      if (!record || terminalRunStatuses.has(record.status) || record.status === "aborting" || this.abortRequested.has(runId)) return;
      const current = this.streams.get(runId) ?? { public: { revision: 0, state: "connecting", text: "", tools: [] }, lastAssistantSeq: -1, toolSeq: new Map<string, number>() };
      let changed = false;
      if (event.type === "connection") {
        const state = event.state === "connected" ? (current.public.text || current.public.tools.length ? "streaming" : "connecting") : "degraded";
        if (current.public.state !== state) { current.public.state = state; changed = true; }
      } else if (event.type === "assistant_text" && event.upstreamSeq >= current.lastAssistantSeq) {
        if (event.upstreamSeq > current.lastAssistantSeq || event.text !== current.public.text) {
          current.lastAssistantSeq = event.upstreamSeq; current.public.text = event.text; current.public.state = "streaming"; changed = true;
        }
      } else if (event.type === "tool" && event.upstreamSeq > (current.toolSeq.get(event.callId) ?? -1)) {
        const index = current.public.tools.findIndex(tool => tool.callId === event.callId);
        const previousTool = index >= 0 ? current.public.tools[index] : undefined;
        const args = event.args ?? previousTool?.args;
        const tool: PublicRunTool = { callId: event.callId, name: event.name, phase: event.phase, ...(args !== undefined ? { args } : {}) };
        current.toolSeq.set(event.callId, event.upstreamSeq);
        if (index >= 0) current.public.tools[index] = tool; else current.public.tools.push(tool);
        current.public.state = "streaming"; changed = true;
      }
      if (!changed) return;
      current.public.revision++; this.streams.set(runId, current); this.emit(record);
    }).catch(error => { process.stderr.write(`[ark-panel] stream projection failed runId=${runId}: ${error instanceof Error ? error.message : String(error)}\n`); });
    this.streamTails.set(runId, task);
    void task.finally(() => { if (this.streamTails.get(runId) === task) { this.streamTails.delete(runId); } });
  }
  private scrub(record: PanelRunRecord): PanelRunRecord {
    const { message: _message, expectedRevision: _expectedRevision, stagedEntries: _stagedEntries, ...clean } = record; return clean;
  }
  private async committedRevision(recordId: string, userEntryId: string): Promise<string | undefined> {
    for (const agentId of this.config.runtimeByAgent.keys()) try {
      const { document } = await loadPanelSession(this.config.dataRoot, agentId, recordId);
      if (!document.entries.some(entry => entry.id === userEntryId)) continue;
      const stat = await lstat(join(this.config.dataRoot, "sessions", agentId, recordId, "transcript.jsonl")); return `${stat.size}:${stat.mtimeMs}`;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return undefined;
  }
  private async commitRecovered(record: PanelRunRecord): Promise<void> {
    let agentId: string | undefined;
    for (const candidate of this.config.runtimeByAgent.keys()) if ((await listPanelSessions(this.config.dataRoot, candidate)).some(item => item.recordId === record.recordId)) { agentId = candidate; break; }
    if (!agentId || !record.plannedUserEntryId || !record.message || !record.stagedEntries) throw new Error("RUN_RECOVERY_DATA_MISSING");
    const claim = await this.transition(record, { status: "committing" }); if (claim.status !== "committing") throw new Error("RUN_COMMIT_CLAIM_REJECTED");
    const { metadata, document } = await loadPanelSession(this.config.dataRoot, agentId, record.recordId);
    const transcriptPath = join(this.config.dataRoot, "sessions", agentId, record.recordId, "transcript.jsonl"), before = await lstat(transcriptPath);
    if (record.baseRevision && record.baseRevision !== `${before.size}:${before.mtimeMs}`) throw new Error("REVISION_CONFLICT");
    const userEntry: JsonObject = { type: "message", id: record.plannedUserEntryId, parentId: record.baseParentEntryId ?? null, timestamp: record.createdAt,
      message: { role: "user", content: [{ type: "text", text: record.message }], timestamp: Date.parse(record.createdAt) } };
    await commitPanelTranscript(this.config.dataRoot, metadata, { header: document.header, entries: [...document.entries, userEntry, ...(record.stagedEntries as JsonObject[])] });
    const after = await lstat(transcriptPath), now = new Date().toISOString();
    const cleaned = await this.cleanupOrphan(claim);
    await this.transition(claim, { status: "completed", updatedAt: now, finishedAt: now, revision: `${after.size}:${after.mtimeMs}`, cleanupPending: !cleaned });
  }

  private async cleanupOrphan(record: PanelRunRecord): Promise<boolean> {
    if (!record.runtimeAgentId || !record.temporarySessionId || !record.temporarySessionKey) return true;
    if (!this.bridge.cleanupOrphanedSession) return false;
    try { await this.bridge.cleanupOrphanedSession({ runtimeAgentId: record.runtimeAgentId, sessionId: record.temporarySessionId,
      sessionKey: record.temporarySessionKey, ...(record.gatewayRunId ? { gatewayRunId: record.gatewayRunId } : {}) }); return true; }
    catch (error) { process.stderr.write(`[ark-panel] orphan cleanup failed runId=${record.runId}: ${error instanceof Error ? error.message : String(error)}\n`); return false; }
  }

  async generate(recordId: string, message: string, signal: AbortSignal, runId: string = randomUUID(), expectedRevision?: string): Promise<{ runId: string; entries: unknown[]; revision?: string; runtimeAgentId?: string; temporarySessionId?: string; gatewayRunId?: string }> {
    const done = this.completed.get(runId); if (done) {
      if (done.recordId !== recordId || done.message !== message) throw new Error("IDEMPOTENCY_KEY_REUSED"); return done.value;
    }
    const running = this.inflight.get(runId); if (running) {
      if (running.recordId !== recordId || running.message !== message) throw new Error("IDEMPOTENCY_KEY_REUSED"); return await running.promise;
    }
    // 每个 run 拥有自己的 AbortController，按 runId 登记，供显式 abort() 中断。
    // 外部传入的 signal（HTTP 连接、测试）转发进来，但连接断开本身已不再触发 abort。
    const controller = new AbortController(); const forward = () => controller.abort();
    if (this.abortRequested.has(runId)) controller.abort();
    if (signal?.aborted) controller.abort(); else signal?.addEventListener("abort", forward, { once: true });
    this.controllers.set(runId, controller);
    const promise = this.generateOnce(recordId, message, controller.signal, runId, expectedRevision);
    this.inflight.set(runId, { recordId, message, promise });
    try {
      const value = await promise; this.completed.set(runId, { recordId, message, value });
      while (this.completed.size > (this.config.completedCacheLimit ?? PanelGenerationApi.MAX_COMPLETED)) this.completed.delete(this.completed.keys().next().value as string);
      return value;
    }
    finally { this.inflight.delete(runId); this.controllers.delete(runId); signal?.removeEventListener("abort", forward); }
  }

  private async generateOnce(recordId: string, message: string, signal: AbortSignal, runId: string, expectedRevision?: string): Promise<{ runId: string; entries: unknown[]; revision?: string; runtimeAgentId?: string; temporarySessionId?: string; gatewayRunId?: string }> {
    if (message.trimStart().startsWith("/")) throw new Error("SLASH_COMMANDS_UNSUPPORTED");
    return await this.operations.runGeneration(recordId, async () => {
      let agentId: string | undefined;
      for (const candidate of this.config.runtimeByAgent.keys()) {
        if ((await listPanelSessions(this.config.dataRoot, candidate)).some((metadata) => metadata.recordId === recordId)) { agentId = candidate; break; }
      }
      if (!agentId) throw new Error("PANEL_SESSION_NOT_FOUND");
      const runtimeAgentId = this.config.runtimeByAgent.get(agentId); if (!runtimeAgentId) throw new Error("RUNTIME_NOT_CONFIGURED");
      const { metadata, document } = await loadPanelSession(this.config.dataRoot, agentId, recordId);
      const transcriptPath = join(this.config.dataRoot, "sessions", agentId, recordId, "transcript.jsonl");
      const beforeStat = await lstat(transcriptPath); const beforeRevision = `${beforeStat.size}:${beforeStat.mtimeMs}`;
      if (expectedRevision && expectedRevision !== beforeRevision) throw new Error("REVISION_CONFLICT");
      (this.config.contextBudget ?? new ConservativeContextBudget()).assertWithinBudget(document, message);
      const userId = this.plannedUserIds.get(runId) ?? randomUUID(); const now = new Date().toISOString();
      const userEntry: JsonObject = { type: "message", id: userId, parentId: latestEntryId(document), timestamp: now,
        message: { role: "user", content: [{ type: "text", text: message }], timestamp: Date.now() } };
      const managedBeforeBridge = await this.runStore.get(runId); if (managedBeforeBridge) await this.transition(managedBeforeBridge, { status: "running", baseRevision: beforeRevision, baseParentEntryId: latestEntryId(document) });
      const result = await this.bridge.generate({ runtimeAgentId, historyThroughPreviousRun: document, latestUserMessage: message,
        latestUserEntryId: userId, idempotencyKey: runId,
        overrides: { ...(metadata.modelOverride ? { modelOverride: metadata.modelOverride } : {}),
          ...(metadata.thinkingLevel ? { thinkingLevel: metadata.thinkingLevel } : {}),
          ...(metadata.reasoningLevel ? { reasoningLevel: metadata.reasoningLevel } : {}) }, signal,
        lifecycle: async event => await this.recordBridgeLifecycle(runId, event), stream: event => this.enqueueBridgeStream(runId, event), cleanupFailed: async () => {
          const current = await this.runStore.get(runId); if (current) await this.transition(current, { cleanupPending: true });
        } });
      const preCommitState = await this.runStore.get(runId); if (signal.aborted || preCommitState?.status === "aborting") throw new Error("BRIDGE_ABORTED");
      const committed: TranscriptDocument = { header: document.header, entries: [...document.entries, userEntry, ...result.entries] };
      const beforeCommit = await this.runStore.get(runId); const claim = beforeCommit ? await this.transition(beforeCommit, { status: "committing" }) : undefined;
      if (claim && claim.status !== "committing") throw new Error("BRIDGE_ABORTED");
      await commitPanelTranscript(this.config.dataRoot, metadata, committed);
      const afterStat = await lstat(transcriptPath); const revision = `${afterStat.size}:${afterStat.mtimeMs}`;
      const afterCommit = await this.runStore.get(runId); if (afterCommit) await this.transition(afterCommit, { status: "committed", revision });
      return { runId, entries: result.entries, revision,
        runtimeAgentId, temporarySessionId: result.sessionId, gatewayRunId: result.runId };
    });
  }

  private async recordBridgeLifecycle(runId: string, event: BridgeLifecycleEvent): Promise<void> {
    const current = await this.runStore.get(runId); if (!current) return;
    if (current.status === "aborting" || terminalRunStatuses.has(current.status)) return;
    if (event.type === "temporary_session_created") await this.transition(current, { status: "running", runtimeAgentId: event.runtimeAgentId,
      temporarySessionId: event.sessionId, temporarySessionKey: event.sessionKey, temporaryTranscriptPath: event.transcriptPath });
    else if (event.type === "history_materialized") await this.transition(current, { status: "running", previousEntryCount: event.previousEntryCount });
    else if (event.type === "gateway_send_accepted") await this.transition(current, { status: "running", gatewayRunId: event.gatewayRunId });
    else await this.transition(current, { status: "materializing", stagedEntries: event.entries });
  }
}
