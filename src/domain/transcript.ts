export type JsonObject = { [key: string]: unknown };

export interface TranscriptDocument {
  header: JsonObject;
  entries: JsonObject[];
}

export class TranscriptError extends Error {}

function asObject(value: unknown, line: number): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TranscriptError(`第 ${line} 行不是 JSON 对象`);
  }
  return value as JsonObject;
}

export function parseTranscript(input: string): TranscriptDocument {
  const lines = input.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) throw new TranscriptError("transcript 为空");
  const values = lines.map((line, index) => {
    if (!line.trim()) throw new TranscriptError(`第 ${index + 1} 行为空`);
    try { return asObject(JSON.parse(line), index + 1); }
    catch (error) {
      if (error instanceof TranscriptError) throw error;
      throw new TranscriptError(`第 ${index + 1} 行不是完整 JSON`);
    }
  });
  const header = values[0]!;
  if (header.type !== "session") throw new TranscriptError("首行不是 session header");
  return { header, entries: values.slice(1) };
}

export function serializeTranscript(document: TranscriptDocument): string {
  return [...[document.header], ...document.entries].map((value) => JSON.stringify(value)).join("\n") + "\n";
}

export function entryId(entry: JsonObject): string | undefined {
  return typeof entry.id === "string" ? entry.id : undefined;
}

export function parentId(entry: JsonObject): string | null | undefined {
  return entry.parentId === null || typeof entry.parentId === "string" ? entry.parentId : undefined;
}
