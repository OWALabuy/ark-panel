import { listMemoryFiles, readMemoryFile, type MemoryFileDocument, type MemoryFileSummary } from "../storage/memory-files.js";
import type { MemoryConsolidationStore } from "../storage/memory-consolidation.js";

export class PanelMemoryApi {
  constructor(private readonly workspaces: ReadonlyMap<string, string>, private readonly consolidation?: MemoryConsolidationStore) {}

  private workspace(agentId: string): string {
    const workspace = this.workspaces.get(agentId);
    if (!workspace) throw new Error("MEMORY_AGENT_NOT_CONFIGURED");
    return workspace;
  }

  async list(agentId: string): Promise<Array<MemoryFileSummary & { source?: { recordId: string; confirmedAt: string } }>> {
    const files = await listMemoryFiles(this.workspace(agentId)), ledgers = this.consolidation ? await this.consolidation.ledgers() : [];
    const byPath = new Map(ledgers.filter(item => item.agentId === agentId).map(item => [item.targetPath, { recordId: item.recordId, confirmedAt: item.confirmedAt }]));
    return files.map(file => ({ ...file, ...(byPath.get(file.path) ? { source: byPath.get(file.path)! } : {}) }));
  }
  async read(agentId: string, path: string): Promise<MemoryFileDocument> { return await readMemoryFile(this.workspace(agentId), path); }
}
