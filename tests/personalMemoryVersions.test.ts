import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { createPersonalMemory, emptyPersonalMemoryDocument, personalMemorySourceAssessment,
  reviewPersonalMemoryRecord, upsertPersonalMemoryRecord, type PersonalMemoryRecord } from "../src/personalMemory";
import { readPersonalMemoryWithSources } from "../src/personalMemorySources";
import type { StoreHost } from "../src/store/settingsSlice";
vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, TFolder: class {}, Notice: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const stamp = "2026-10-05T03:00:00.000Z", text = "纯虚构我想先完成一件事情。\n", path = "Notes/纯虚构来源.md";
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost;
const ledgerPath = () => store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json");
const ref = () => ({ sourceId: "note:fictional", path, capturedAt: stamp, contentHash: hash(text), extractionVersion: "note-understanding-v1" });
const candidate = () => createPersonalMemory({ kind: "current_state", content: "纯虚构可能希望减少同时开展的事情", truth: "inference", sourceRefs: [ref()] }, stamp);
const active = () => { const record = candidate(); return reviewPersonalMemoryRecord([record], record.id, { decision: "confirm", sourceRef: { sourceId: "confirmed:fictional", path: ledgerPath(), capturedAt: stamp } }, stamp)[0]; };
async function seed(record: PersonalMemoryRecord, trimmed = false) {
  await vault.seed(path, text);
  await vault.seed(store.personalMemoryPath(), JSON.stringify({ ...emptyPersonalMemoryDocument(stamp), records: [record] }));
  await vault.seed(ledgerPath(), JSON.stringify({ version: 1, records: trimmed ? [] : [{ operationId: "confirmed:fictional", fingerprint: "fictional", toolName: "confirm_review_memory", source: "system", status: "verified", attempts: 1,
    arguments: { type: "review_memory", memoryId: record.id, memoryDecision: "confirm", content: record.content, memoryReviewedContent: record.content, memorySourceDependenciesHash: record.confirmationReceipt?.sourceDependenciesHash }, createdAt: stamp, updatedAt: stamp, result: { success: true, output: "fictional", actions: [] } }] }));
}
const usable = async () => (await readPersonalMemoryWithSources(store)).records[0][personalMemorySourceAssessment]!.usable;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "lifeops-memory-versions-")); vault = new DiskVault(root); store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
describe("explicit note-version dependencies without legacy migration", () => {
  it.each([false, true])("does not let verified/trimmed confirmation bypass changed source (trimmed=%s)", async trimmed => {
    await seed(active(), trimmed); const before = await vault.bytes(store.personalMemoryPath());
    expect(await usable()).toBe(true);
    await vault.seed(path, "纯虚构后来更正的原文\n");
    expect(await usable()).toBe(false);
    expect(await vault.bytes(store.personalMemoryPath())).toBe(before);
    expect(vault.writes).toEqual([]);
  });
  it.each(["missing", "excluded", "read-error"])("requires every declared dependency: %s", async mode => {
    const record = active(); record.sourceRefs.push({ ...ref(), sourceId: "note:second", path: "Notes/纯虚构另一个来源.md" });
    // A newly constructed binding is needed, rather than editing an already-confirmed record.
    const c = createPersonalMemory({ kind: record.kind, content: record.content, truth: "inference", sourceRefs: record.sourceRefs.filter(r => !r.sourceId.startsWith("confirmed:")) }, stamp);
    const confirmed = reviewPersonalMemoryRecord([c], c.id, { decision: "confirm", sourceRef: { sourceId: "confirmed:fictional", path: ledgerPath(), capturedAt: stamp } }, stamp)[0];
    await seed(confirmed); await vault.seed("Notes/纯虚构另一个来源.md", text);
    expect(await usable()).toBe(true);
    if (mode === "missing") await vault.rename(store.getFile("Notes/纯虚构另一个来源.md")!, "Notes/纯虚构移动.md");
    if (mode === "excluded") store.settings.privacy!.excludedVaultPrefixes = ["Notes/纯虚构另一个来源.md"];
    if (mode === "read-error") { const read = store.readPath.bind(store); vi.spyOn(store, "readPath").mockImplementation(p => p === "Notes/纯虚构另一个来源.md" ? Promise.reject(new Error("fictional unavailable")) : read(p)); }
    expect(await usable()).toBe(false);
  });
  it.each(["contentHash", "extractionVersion"])("rejects removal of %s instead of downgrading a receipt", async key => {
    const record = active(); delete (record.sourceRefs[0] as unknown as Record<string, unknown>)[key];
    await seed(record); const before = await vault.bytes(store.personalMemoryPath());
    await expect(usable()).rejects.toThrow(); expect(await vault.bytes(store.personalMemoryPath())).toBe(before);
  });
  it("keeps a same-content version observation separate from an old active record", () => {
    const old = createPersonalMemory({ kind: "current_state", content: candidate().content, sourceRefs: [{ sourceId: "legacy", path, capturedAt: stamp }] }, stamp);
    const confirmed = reviewPersonalMemoryRecord([old], old.id, { decision: "confirm" }, stamp)[0];
    const next = upsertPersonalMemoryRecord([confirmed], candidate(), stamp);
    expect(next).toHaveLength(2); expect(next.find(r => r.id === old.id)).toEqual(confirmed);
    expect(next.filter(r => r.status === "candidate")).toHaveLength(1);
  });
  it("does not erase a hash dependency through deduplication", () => {
    expect(() => createPersonalMemory({ kind: "current_state", content: "纯虚构", sourceRefs: [ref(), { sourceId: ref().sourceId, path, capturedAt: stamp }] }, stamp)).toThrow();
  });
  it("still lets an invalidated record be forgotten and blocks rebuilding the claim", async () => {
    const record = active(); await seed(record); await vault.seed(path, "changed");
    const forgotten = reviewPersonalMemoryRecord([record], record.id, { decision: "forget" }, stamp)[0];
    await seed(forgotten); expect(await usable()).toBe(false);
    expect(upsertPersonalMemoryRecord([forgotten], candidate(), stamp)).toEqual([forgotten]);
  });
  it("keeps legacy confirmed facts independent of unstamped historical diary edits", async () => {
    const c = createPersonalMemory({ kind: "current_state", content: "纯虚构旧确认", sourceRefs: [{ sourceId: "legacy", path, capturedAt: stamp }] }, stamp);
    const record = reviewPersonalMemoryRecord([c], c.id, { decision: "confirm", sourceRef: { sourceId: "confirmed:fictional", path: ledgerPath(), capturedAt: stamp } }, stamp)[0];
    await seed(record); await vault.seed(path, "纯虚构历史后来变化\n"); expect(await usable()).toBe(true);
    expect(record.sourceBinding).toBeUndefined(); expect(record.sourceRefs[0]).not.toHaveProperty("contentHash");
  });
});
