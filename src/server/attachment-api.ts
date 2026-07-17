import { randomUUID } from "node:crypto";
import { listPanelSessions } from "../storage/panel-sessions.js";
import { getSessionAttachment, readSessionAttachmentBytes, storeSessionAttachment,
  type AttachmentManifest } from "../storage/attachments.js";

export interface PublicAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export class PanelAttachmentApi {
  constructor(private readonly dataRoot: string, private readonly agentIds: readonly string[]) {}

  private async owner(recordId: string): Promise<string> {
    for (const agentId of this.agentIds) {
      if ((await listPanelSessions(this.dataRoot, agentId)).some((item) => item.recordId === recordId)) return agentId;
    }
    throw new Error("PANEL_SESSION_NOT_FOUND");
  }

  private public(manifest: AttachmentManifest): PublicAttachment {
    return { id: manifest.attachmentId, fileName: manifest.fileName, mimeType: manifest.mimeType, sizeBytes: manifest.size };
  }

  async upload(recordId: string, input: { fileName: string; mimeType: string; bytes: Uint8Array }): Promise<PublicAttachment> {
    const agentId = await this.owner(recordId);
    const stored = await storeSessionAttachment(this.dataRoot, input, {
      agentId, recordId, messageId: `pending_${randomUUID()}`, role: "user"
    });
    return this.public(stored.manifest);
  }

  async download(attachmentId: string): Promise<{ fileName: string; mimeType: string; bytes: Buffer } | undefined> {
    for (const agentId of this.agentIds) {
      for (const session of await listPanelSessions(this.dataRoot, agentId)) {
        try {
          const stored = await getSessionAttachment(this.dataRoot, agentId, session.recordId, attachmentId);
          return { fileName: stored.manifest.fileName, mimeType: stored.manifest.mimeType,
            bytes: await readSessionAttachmentBytes(this.dataRoot, agentId, session.recordId, attachmentId) };
        } catch (error) {
          if (error instanceof Error && error.message === "ATTACHMENT_NOT_OWNED_BY_SESSION") continue;
          throw error;
        }
      }
    }
    return undefined;
  }
}
