import { createHash } from "node:crypto";

export interface GenerationRequestIdentity {
  recordId: string;
  message: string;
  expectedRevision?: string | undefined;
  attachmentIds?: readonly string[] | undefined;
  requestOutputs?: boolean | undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Stable identity written by current durable v1 runs. */
export function generationRequestFingerprint(request: GenerationRequestIdentity): string {
  if (request.requestOutputs !== undefined && typeof request.requestOutputs !== "boolean") throw new Error("REQUEST_OUTPUTS_INVALID");
  const canonical = JSON.stringify({
    recordId: request.recordId,
    message: request.message,
    expectedRevision: request.expectedRevision ?? null,
    attachmentIds: [...(request.attachmentIds ?? [])],
    // requestOutputs was added after durable run fingerprints shipped. Omitting false preserves
    // every existing false/default hash while still making true a distinct request.
    ...(request.requestOutputs === true ? { requestOutputs: true } : {})
  });
  return sha256(canonical);
}

/** Match current hashes plus the original pre-attachment durable shape without rewriting storage. */
export function generationRequestFingerprintMatches(request: GenerationRequestIdentity, fingerprint: string): boolean {
  if (generationRequestFingerprint(request) === fingerprint) return true;
  if ((request.attachmentIds?.length ?? 0) !== 0 || request.requestOutputs === true) return false;
  const legacyCanonical = JSON.stringify({
    recordId: request.recordId,
    message: request.message,
    expectedRevision: request.expectedRevision ?? null
  });
  return sha256(legacyCanonical) === fingerprint;
}
