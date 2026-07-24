import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { currentTranscriptBranch } from "../domain/branch.js";
import type { JsonObject, TranscriptDocument } from "../domain/transcript.js";
import type { BridgeCompactionRequest, BridgeCompactionResult } from "../gateway/adapter.js";
import { commitPanelTranscript, listPanelSessions, loadPanelSession } from "../storage/panel-sessions.js";
import { materializeOpenClawHistory } from "./generation-api.js";
import { SessionOperationCoordinator } from "./session-operation.js";

interface CompactionBridge {
  compact(request: BridgeCompactionRequest): Promise<BridgeCompactionResult>;
}
export interface CompactionConfig {
  dataRoot: string;
  runtimeByAgent: ReadonlyMap<string, string>;
  operations?: SessionOperationCoordinator;
}

function revision(stat: { size: number; mtimeMs: number }): string {
  return `${stat.size}:${stat.mtimeMs}`;
}

export class PanelCompactionApi {
  private readonly operations: SessionOperationCoordinator;
  constructor(private readonly bridge: CompactionBridge, private readonly config: CompactionConfig) {
    this.operations = config.operations ?? new SessionOperationCoordinator();
  }

  async compact(recordId: string, expectedRevision?: string): Promise<{
    compacted: boolean; revision: string; reason?: string;
  }> {
    return await this.operations.runExclusive(recordId, async () => {
      let agentId: string | undefined;
      for (const candidate of this.config.runtimeByAgent.keys()) {
        if ((await listPanelSessions(this.config.dataRoot, candidate)).some(item => item.recordId === recordId)) {
          agentId = candidate; break;
        }
      }
      if (!agentId) throw new Error("PANEL_SESSION_NOT_FOUND");
      const runtimeAgentId = this.config.runtimeByAgent.get(agentId);
      if (!runtimeAgentId) throw new Error("RUNTIME_NOT_CONFIGURED");
      const { metadata, document } = await loadPanelSession(this.config.dataRoot, agentId, recordId);
      const transcriptPath = join(this.config.dataRoot, "sessions", agentId, recordId, "transcript.jsonl");
      const baseRevision = revision(await lstat(transcriptPath));
      if (expectedRevision && expectedRevision !== baseRevision) throw new Error("REVISION_CONFLICT");
      const branch = currentTranscriptBranch(document);
      if (!branch.entries.length) throw new Error("COMPACTION_NOT_NEEDED");
      const history = await materializeOpenClawHistory(this.config.dataRoot, agentId, recordId, branch);
      const result = await this.bridge.compact({ runtimeAgentId, history,
        overrides: { ...(metadata.modelOverride ? { modelOverride: metadata.modelOverride } : {}),
          ...(metadata.thinkingLevel ? { thinkingLevel: metadata.thinkingLevel } : {}),
          ...(metadata.reasoningLevel ? { reasoningLevel: metadata.reasoningLevel } : {}) } });
      const beforeCommitRevision = revision(await lstat(transcriptPath));
      if (beforeCommitRevision !== baseRevision) throw new Error("REVISION_CONFLICT");
      if (!result.compacted || !result.entry) return {
        compacted: false, revision: baseRevision, ...(result.reason ? { reason: result.reason } : {})
      };
      const committed: TranscriptDocument = { header: document.header, entries: [...document.entries, result.entry] };
      await commitPanelTranscript(this.config.dataRoot, metadata, committed);
      return { compacted: true, revision: revision(await lstat(transcriptPath)) };
    });
  }
}
