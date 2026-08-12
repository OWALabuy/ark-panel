import { randomUUID } from "node:crypto";
import { getSessionAttachment, readSessionAttachmentBytes, storeSessionAttachment,
  type AttachmentManifest } from "../storage/attachments.js";
import { SessionReadIndex } from "../storage/index.js";
import { sharp, type Metadata } from "./safe-raster.js";

export interface PublicAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

const previewMimeByFormat = new Map<string, string>([["png", "image/png"], ["jpeg", "image/jpeg"], ["webp", "image/webp"]]);
const MAX_PREVIEW_DIMENSION = 8192;
const MAX_PREVIEW_PIXELS = 40_000_000;

export class PanelAttachmentApi {
  private readonly readIndex: SessionReadIndex;
  constructor(private readonly dataRoot: string, private readonly agentIds: readonly string[], readIndex?: SessionReadIndex) {
    this.readIndex = readIndex && agentIds.every(agentId => readIndex.hasAgent(agentId)) ? readIndex :
      new SessionReadIndex(agentIds.map(agentId => ({ agentId })), dataRoot);
  }

  async initialize(): Promise<void> { await this.readIndex.initialize(); }

  private async owner(recordId: string): Promise<string> {
    const entry = await this.readIndex.lookup(recordId);
    if (entry?.sourceKind === "panel" && this.agentIds.includes(entry.agentId)) return entry.agentId;
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
    for (const session of await this.readIndex.snapshot()) {
      if (session.sourceKind === "panel" && this.agentIds.includes(session.agentId)) {
        try {
          const stored = await getSessionAttachment(this.dataRoot, session.agentId, session.recordId, attachmentId);
          return { fileName: stored.manifest.fileName, mimeType: stored.manifest.mimeType,
            bytes: await readSessionAttachmentBytes(this.dataRoot, session.agentId, session.recordId, attachmentId) };
        } catch (error) {
          if (error instanceof Error && error.message === "ATTACHMENT_NOT_OWNED_BY_SESSION") continue;
          throw error;
        }
      }
    }
    return undefined;
  }

  async preview(attachmentId: string): Promise<{ mimeType: string; bytes: Buffer } | undefined> {
    const file = await this.download(attachmentId); if (!file) return undefined;
    try {
      const image = sharp(file.bytes, { animated: true, limitInputPixels: MAX_PREVIEW_PIXELS });
      const metadata: Metadata = await image.metadata();
      const mimeType = metadata.format ? previewMimeByFormat.get(metadata.format) : undefined;
      if (!mimeType || !metadata.width || !metadata.height || metadata.width > MAX_PREVIEW_DIMENSION || metadata.height > MAX_PREVIEW_DIMENSION || (metadata.pages ?? 1) !== 1) {
        throw new Error("ATTACHMENT_PREVIEW_UNSUPPORTED");
      }
      // metadata() does not decode compressed pixels. stats() forces a complete decode
      // without materialising the bounded-but-large raw image in a JavaScript Buffer.
      await image.stats();
      return { mimeType, bytes: file.bytes };
    } catch {
      throw new Error("ATTACHMENT_PREVIEW_UNSUPPORTED");
    }
  }
}
