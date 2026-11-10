import { gzipSync, gunzipSync, inflateRawSync } from "node:zlib";
import type { RecoveryDocument } from "./factOperation";

export const MAX_RECOVERY_BYTES = 16 * 1024 * 1024;
const COMPRESSION_THRESHOLD = 64 * 1024;
const fields = ["before", "after", "previous"] as const;
interface EncodedSnapshot { encoding: "gzip-base64-v1"; utf8Bytes: number; data: string }
export class RecoveryCapacityError extends Error {
  constructor() { super("恢复记录无法安全读取，已停止操作并保留原文件。"); this.name = "RecoveryCapacityError"; }
}
function capacity(): never { throw new RecoveryCapacityError(); }

function refuse(): never { throw new Error("恢复记录无法安全读取，已停止操作并保留原文件。"); }
function snapshotBytes(text: string): Buffer {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.toString("utf8") !== text) refuse();
  return bytes;
}

/** Only the disk envelope changes. Runtime hashes and undo still use exact text. */
export function encodeFactRecovery(document: RecoveryDocument): string {
  let total = document.ledgerUndo ? controlBytes(document) : 0, compressed = false;
  if (total > MAX_RECOVERY_BYTES) capacity();
  const pack = (text: string): string | EncodedSnapshot => {
    const bytes = snapshotBytes(text);
    total += bytes.length;
    if (total > MAX_RECOVERY_BYTES) capacity();
    if (bytes.length < COMPRESSION_THRESHOLD) return text;
    const encoded: EncodedSnapshot = { encoding: "gzip-base64-v1", utf8Bytes: bytes.length, data: gzipSync(bytes).toString("base64") };
    if (Buffer.byteLength(JSON.stringify(encoded)) < bytes.length) { compressed = true; return encoded; }
    return text;
  };
  const ledgerUndo = document.ledgerUndo ? { ...document.ledgerUndo, before: pack(document.ledgerUndo.before) } : undefined;
  const entries = document.entries.map(entry => {
    const wire: Record<string, unknown> = { ...entry };
    for (const field of fields) {
      const text = entry[field];
      if (typeof text !== "string") continue;
      wire[field] = pack(text);
    }
    return wire;
  });
  const raw = `${JSON.stringify({ ...document, version: ledgerUndo ? 3 : compressed ? 2 : 1, entries,
    ...(ledgerUndo ? { ledgerUndo } : {}) }, null, 2)}\n`;
  if (Buffer.byteLength(raw, "utf8") > MAX_RECOVERY_BYTES) capacity();
  return raw;
}

/** Decodes into the established v1 in-memory form before path/hash validation. */
export function decodeFactRecovery(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse();
  const document = value as Record<string, unknown>;
  const delta = document.ledgerUndo;
  if (document.version === 3 && (!delta || typeof delta !== "object" || Array.isArray(delta))) {
    throw new Error("恢复记录版本不受支持，已停止操作并保留原文件。");
  }
  if (document.version !== 3 && delta !== undefined) refuse();
  if (document.version === 1) return value;
  if (![2, 3].includes(document.version as number) || !Array.isArray(document.entries)) refuse();
  let total = document.version === 3 ? controlBytes(document) : 0, encodedCount = 0;
  if (total > MAX_RECOVERY_BYTES) refuse();
  const unpack = (text: unknown): unknown => {
      if (text === null) return null;
      if (typeof text === "string") { total += snapshotBytes(text).length; if (total > MAX_RECOVERY_BYTES) refuse(); return text; }
      if (!text || typeof text !== "object" || Array.isArray(text)) refuse();
      const encoded = text as Record<string, unknown>;
      if (Object.keys(encoded).sort().join(",") !== "data,encoding,utf8Bytes" || encoded.encoding !== "gzip-base64-v1"
        || !Number.isSafeInteger(encoded.utf8Bytes) || (encoded.utf8Bytes as number) <= 0
        || (encoded.utf8Bytes as number) > MAX_RECOVERY_BYTES - total
        || typeof encoded.data !== "string" || encoded.data.length > MAX_RECOVERY_BYTES
        || encoded.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded.data)) refuse();
      const bytes = Buffer.from(encoded.data, "base64"), limit = encoded.utf8Bytes as number;
      if (bytes.toString("base64") !== encoded.data || bytes.length < 18
        || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8 || bytes[3] !== 0) refuse();
      try {
        // Reject extra members or trailing bytes, including otherwise ignored zero padding.
        const body = bytes.subarray(10, -8);
        const consumed = inflateRawSync(body, { info: true, maxOutputLength: limit + 1 }) as unknown as { engine: { bytesWritten: number } };
        if (consumed.engine.bytesWritten !== body.length) refuse();
        const decoded = gunzipSync(bytes, { maxOutputLength: limit + 1 });
        if (decoded.length !== limit) refuse();
        const text = decoded.toString("utf8");
        if (!Buffer.from(text, "utf8").equals(decoded)) refuse();
        total += limit; encodedCount++;
        return text;
      } catch { refuse(); }
  };
  const ledgerUndo = document.version === 3 ? { ...(delta as Record<string, unknown>), before: unpack((delta as Record<string, unknown>).before) } : undefined;
  const entries = document.entries.map(rawEntry => {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) refuse();
    const entry: Record<string, unknown> = { ...rawEntry };
    for (const field of fields) {
      if (Object.hasOwn(entry, field)) entry[field] = unpack(entry[field]);
    }
    return entry;
  });
  if (document.version === 2 && !encodedCount) refuse();
  return { ...document, version: 1, entries, ...(ledgerUndo ? { ledgerUndo } : {}) };
}

/** v3 counts every independent decoded payload, including control metadata.
 * Ledger after is a bounded deterministic computation, never a second snapshot. */
function controlBytes(document: RecoveryDocument | Record<string, unknown>): number {
  const entries = (document.entries as Array<Record<string, unknown>>).map(entry => {
    const metadata = { ...entry }; for (const field of fields) delete metadata[field]; return metadata;
  });
  const ledger = { ...(document.ledgerUndo as unknown as Record<string, unknown>) }; delete ledger.before;
  return snapshotBytes(JSON.stringify({ ...document, entries, ledgerUndo: ledger })).length;
}
