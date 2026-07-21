import { listMemoryFiles, readMemoryFile, type MemoryFileDocument, type MemoryFileSummary } from "../storage/memory-files.js";

export class PanelMemoryApi {
  constructor(private readonly workspaces: ReadonlyMap<string, string>) {}

  private workspace(agentId: string): string {
    const workspace = this.workspaces.get(agentId);
    if (!workspace) throw new Error("MEMORY_AGENT_NOT_CONFIGURED");
    return workspace;
  }

  async list(agentId: string): Promise<MemoryFileSummary[]> { return await listMemoryFiles(this.workspace(agentId)); }
  async read(agentId: string, path: string): Promise<MemoryFileDocument> { return await readMemoryFile(this.workspace(agentId), path); }
}
