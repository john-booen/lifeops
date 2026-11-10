import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { decodeFactRecovery, encodeFactRecovery, MAX_RECOVERY_BYTES } from "../src/dataFoundation/recoveryEncoding";
import { fileRevision, inspectFactRecovery, type RecoveryDocument } from "../src/dataFoundation/factOperation";
import type { StoreHost } from "../src/store/settingsSlice";
vi.mock("obsidian", () => ({ normalizePath: (p: string) => p }));
const store = { settings: DEFAULT_SETTINGS, path: (...parts: string[]) => parts.join("/") } as unknown as StoreHost;
const source = '纯虚构中文、CRLF\r\n引号"与反斜杠\\、🙂\n'.repeat(4_000);
function document(before: string | null = source, after: string | null = "原段落\r\n"): RecoveryDocument {
  return { version: 1, operationId: "encoding-fixture", status: "pending", entries: [{ path: `${DEFAULT_SETTINGS.folders.ideas}/纯虚构编码.md`, before, after, beforeHash: fileRevision(before), afterHash: fileRevision(after) }] };
}
function wire() { return JSON.parse(encodeFactRecovery(document())); }
function packed(bytes: Buffer) { return { encoding: "gzip-base64-v1", utf8Bytes: bytes.length, data: gzipSync(bytes).toString("base64") }; }

describe("bounded recovery disk representation", () => {
  it("keeps legacy small records, null, empty text and absent previous distinct", () => {
    const original = document(null, "");
    expect(encodeFactRecovery(original)).toBe(`${JSON.stringify(original, null, 2)}\n`);
    expect(inspectFactRecovery(store, encodeFactRecovery(original))).toEqual(original);
    expect(Object.hasOwn(decodeFactRecovery(original) as object, "previous")).toBe(false);
  });
  it("round-trips Chinese, emoji, CRLF, escaping and the exact previous version", () => {
    const original = document();
    original.entries[0].previous = source + "旧版本";
    original.entries[0].previousHash = fileRevision(original.entries[0].previous);
    const raw = encodeFactRecovery(original);
    expect(JSON.parse(raw).version).toBe(2);
    expect(raw).not.toContain("纯虚构中文");
    expect(inspectFactRecovery(store, raw)).toEqual(original);
  });
  it.each(["unknown-codec", "bad-base64", "noncanonical-base64", "extra-property", "bad-length", "zero-length", "fractional-length", "gzip-corrupt", "bad-isize", "truncated", "tail", "junk", "second-member"])("rejects %s without revealing snapshots", kind => {
    const value = wire(), item = value.entries[0].before;
    if (kind === "unknown-codec") item.encoding = "another-codec";
    if (kind === "bad-base64") item.data += "\n";
    if (kind === "noncanonical-base64") item.data = "eB==";
    if (kind === "extra-property") item.secret = source;
    if (kind === "bad-length") item.utf8Bytes++;
    if (kind === "zero-length") item.utf8Bytes = 0;
    if (kind === "fractional-length") item.utf8Bytes = 1.5;
    const bytes = Buffer.from(item.data, "base64");
    if (kind === "gzip-corrupt") { bytes[bytes.length - 8] ^= 1; item.data = bytes.toString("base64"); }
    if (kind === "bad-isize") { bytes[bytes.length - 4] ^= 1; item.data = bytes.toString("base64"); }
    if (kind === "truncated") item.data = bytes.subarray(0, -2).toString("base64");
    if (kind === "tail") item.data = Buffer.concat([bytes, Buffer.alloc(2)]).toString("base64");
    if (kind === "junk") item.data = Buffer.concat([bytes, Buffer.from("junk")]).toString("base64");
    if (kind === "second-member") item.data = Buffer.concat([bytes, gzipSync(Buffer.alloc(0))]).toString("base64");
    try { inspectFactRecovery(store, JSON.stringify(value)); throw new Error("accepted malformed fixture"); }
    catch (error) { expect((error as Error).message).toContain("恢复记录无法安全读取"); expect((error as Error).message).not.toContain("纯虚构中文"); }
  });
  it("checks the original snapshot hash after decompression", () => {
    const value = wire(); value.entries[0].beforeHash = "0".repeat(64);
    expect(() => inspectFactRecovery(store, JSON.stringify(value))).toThrow("停止覆盖");
  });
  it("rejects invalid UTF8 without silently changing recovered text", () => {
    const value = wire(); value.entries[0].before = packed(Buffer.from([0xff]));
    expect(() => inspectFactRecovery(store, JSON.stringify(value))).toThrow("恢复记录无法安全读取");
  });
  it("limits decompression before allocating a declared small snapshot", () => {
    const value = wire(); value.entries[0].before = packed(Buffer.alloc(1024 * 1024, 65)); value.entries[0].before.utf8Bytes = 1;
    expect(() => inspectFactRecovery(store, JSON.stringify(value))).toThrow("恢复记录无法安全读取");
  });
  it("bounds individual snapshots and the total decoded bytes across entries", () => {
    const value = wire(); value.entries[0].before.utf8Bytes = MAX_RECOVERY_BYTES + 1;
    expect(() => decodeFactRecovery(value)).toThrow("恢复记录无法安全读取");
    const large = packed(Buffer.alloc(6 * 1024 * 1024, 65));
    expect(() => decodeFactRecovery({ version: 2, entries: [{ before: large }, { after: large }, { previous: large }] })).toThrow("恢复记录无法安全读取");
    expect(() => decodeFactRecovery({ version: 2, entries: [{ before: large }, { after: "B".repeat(11 * 1024 * 1024) }] })).toThrow("恢复记录无法安全读取");
  });
  it("keeps physical and aggregate writer limits, including non-snapshot metadata", () => {
    expect(() => encodeFactRecovery(document("A".repeat(9 * 1024 * 1024), "B".repeat(9 * 1024 * 1024)))).toThrow("恢复记录无法安全读取");
    const oversizedMetadata = { ...document(null, ""), extension: "A".repeat(MAX_RECOVERY_BYTES) };
    expect(() => encodeFactRecovery(oversizedMetadata)).toThrow("恢复记录无法安全读取");
  });
  it.each([
    ["an unknown version", 999],
    ["v3 without ledgerUndo", 3]
  ])("rejects %s", (_kind, version) => {
    expect(() => inspectFactRecovery(store, JSON.stringify({ ...wire(), version }))).toThrow("版本");
  });
  it("rejects missing v2 encoding and encoded snapshots mislabeled v1", () => {
    expect(() => inspectFactRecovery(store, JSON.stringify({ ...document(), version: 2 }))).toThrow("恢复记录无法安全读取");
    expect(() => inspectFactRecovery(store, JSON.stringify({ ...wire(), version: 1 }))).toThrow("停止覆盖");
  });
  it("does not authorize an encoded path outside the Vault", () => {
    const value = wire(); value.entries[0].path = "../原记录.md";
    expect(() => inspectFactRecovery(store, JSON.stringify(value))).toThrow("停止覆盖");
  });
  it("rejects a lone surrogate in a v2 plain snapshot before recovery can write", () => {
    const value = wire(); value.entries[0].after = "\ud800"; value.entries[0].afterHash = fileRevision("\ud800");
    expect(() => inspectFactRecovery(store, JSON.stringify(value))).toThrow("恢复记录无法安全读取");
  });
});
