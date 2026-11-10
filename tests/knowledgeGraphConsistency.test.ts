import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { createMemoryCandidate } from "../src/memoryIndex";
import type { KnowledgeGraph, StoreHost } from "../src/store/settingsSlice";

vi.mock("obsidian", () => ({
  App: class {}, Notice: class {}, TFile: class {}, TFolder: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"),
  requestUrl: vi.fn(() => { throw Error("Network forbidden"); })
}));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
type Fixture = { vault: InstanceType<typeof DiskVault>; store: StoreHost };
let root: string, fixture: Fixture;
const authority = JSON.stringify({ version: 1, updatedAt: "2026-10-27T00:00:00Z", records: [], extension: { fixture: "keep-authority" } });
const ledger = JSON.stringify({ version: 1, records: [], extension: { fixture: "keep-ledger" } });
const fixedMtime = 1_790_000_000;
const multiChunk = [
  "# Shared Field Notes", "", "## Overview",
  Array.from({ length: 20 }, (_, i) => `preface${i}`).join(" ") + " sharedanchor",
  "", "## Late Signal", "lateorchid sharedanchor", "", "## Last Signal", "lateorchid sharedanchor"
].join("\n");

async function createFixture(folder: string): Promise<Fixture> {
  await mkdir(folder, { recursive: true });
  const vault = new DiskVault(folder);
  const store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await vault.seed(store.personalMemoryPath(), authority);
  await vault.seed(store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json"), ledger);
  return { vault, store };
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-graph-consistency-"));
  fixture = await createFixture(root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
async function seed(f: Fixture, path: string, text: string): Promise<void> {
  await f.vault.seed(path, text);
  await utimes(f.vault.diskPath(path), fixedMtime, fixedMtime);
}
const graph = (f: Fixture) => f.store.readJson<KnowledgeGraph>(f.store.knowledgeGraphPath(), { generatedAt: "", nodes: [], edges: [] });
// Compare published graph meaning independently of timestamp or array order.
const meaning = (value: KnowledgeGraph) => ({
  nodes: value.nodes.slice().sort((a, b) => a.id.localeCompare(b.id)),
  edges: value.edges.slice().sort((a, b) => JSON.stringify([a.source, a.target, a.type]).localeCompare(JSON.stringify([b.source, b.target, b.type])))
});
const dangling = (value: KnowledgeGraph) => {
  const nodes = new Set(value.nodes.map(node => node.id));
  return value.edges.filter(edge => !nodes.has(edge.source) || !nodes.has(edge.target));
};
async function protectedBytes(f: Fixture) {
  return Promise.all([
    f.store.personalMemoryPath(), f.store.path(f.store.settings.folders.aiReports, "Operations", "operation-ledger.json"),
    f.store.sourceManifestPath(), f.store.memoryIndexPath()
  ].map(async path => ({ path, raw: await f.vault.bytes(path) })));
}

it("gives the same canonical graph for source-order permutations and a full rebuild without changing authorities or histories", async () => {
  const results: KnowledgeGraph[] = [];
  for (const order of [[0, 1, 2], [2, 0, 1]]) {
    const f = await createFixture(join(root, `order-${order.join("")}`));
    const paths = [f.store.path(f.store.settings.folders.ideas, "Alpha.md"), f.store.path(f.store.settings.folders.ideas, "Beta.md"),
      f.store.path(f.store.settings.folders.dailyRoot, "Journal.md")];
    const texts = [multiChunk, "# Beta\n\nsharedanchor betaprivate", "# Journal\n\nsharedanchor journalprivate"];
    for (const [i, path] of paths.entries()) await seed(f, path, texts[i]);
    for (const i of order) await f.store.upsertVaultSource(paths[i]);
    const incremental = await graph(f), originals = await protectedBytes(f);
    await f.store.rebuildKnowledgeStructure();
    const rebuilt = await graph(f);
    for (const original of originals) expect(await f.vault.bytes(original.path)).toBe(original.raw);
    for (const [i, path] of paths.entries()) expect(await f.vault.bytes(path)).toBe(texts[i]);
    expect.soft(rebuilt.nodes.filter(node => node.weight !== 1), "a node represents existence, not rebuild frequency").toEqual([]);
    expect.soft(meaning(rebuilt)).toEqual(meaning(incremental));
    expect.soft(dangling(rebuilt)).toEqual([]);
    results.push(incremental, rebuilt);
  }
  for (const result of results.slice(1)) expect.soft(meaning(result)).toEqual(meaning(results[0]));
});

it("keeps a chunk-only concept as a real endpoint and as a queryable matched concept after full rebuild", async () => {
  const { vault, store } = fixture, path = store.path(store.settings.folders.ideas, "Late Signal.md");
  await seed(fixture, path, multiChunk);
  await store.upsertVaultSource(path);
  const incremental = await graph(fixture);
  expect(incremental.nodes.some(node => node.type === "concept" && node.label === "lateorchid")).toBe(true);
  await store.rebuildKnowledgeStructure();
  const rebuilt = await graph(fixture);
  expect.soft(dangling(rebuilt)).toEqual([]);
  expect.soft(rebuilt.nodes.some(node => node.type === "concept" && node.label === "lateorchid")).toBe(true);
  expect.soft(await store.buildKnowledgeGraphContext("lateorchid")).toContain("matchedConcepts: lateorchid");
  expect(await vault.bytes(path)).toBe(multiChunk);
});

it("deduplicates a note-to-concept relation across chunks and does not inflate it on repeated upserts or rebuilds", async () => {
  const { vault, store } = fixture, path = store.path(store.settings.folders.ideas, "Repeated.md");
  await seed(fixture, path, multiChunk);
  await store.upsertVaultSource(path);
  const original = await graph(fixture), raw = await vault.bytes(store.knowledgeGraphPath());
  const late = original.nodes.find(node => node.type === "concept" && node.label === "lateorchid")!;
  const note = original.nodes.find(node => node.type === "note" && node.path === path)!;
  const related = (value: KnowledgeGraph) => value.edges.filter(edge => edge.source === note.id && edge.target === late.id && edge.type === "related");
  expect(related(original)).toEqual([{ source: note.id, target: late.id, type: "related", weight: 0.5 }]);
  for (let i = 0; i < 3; i++) {
    expect((await store.upsertVaultSource(path)).changed).toBe(false);
    expect(await vault.bytes(store.knowledgeGraphPath())).toBe(raw);
  }
  for (let i = 0; i < 2; i++) {
    await store.rebuildKnowledgeStructure();
    const rebuilt = await graph(fixture);
    expect.soft(related(rebuilt)).toEqual(related(original));
    expect.soft(meaning(rebuilt)).toEqual(meaning(original));
  }
});

it("preserves shared concepts, source identity and memory revision history through modify, rename and deletion while clearing orphan categories", async () => {
  const { vault, store } = fixture, a = store.path(store.settings.folders.dailyRoot, "Alpha.md"), b = store.path(store.settings.folders.ideas, "Beta.md");
  const oldText = "# Journal Alpha\n\nsharedanchor alphaprivate oldstamp", nextText = "# Journal Alpha\n\nsharedanchor alphanew newstamp";
  const otherText = "# Beta\n\nsharedanchor betaprivate";
  const foreign = createMemoryCandidate({ content: "Pure fictional manual candidate kept verbatim", source: "manual-fixture" });
  await vault.seed(store.memoryIndexPath(), JSON.stringify([foreign]));
  await seed(fixture, a, oldText); await seed(fixture, b, otherText);
  await store.upsertVaultSource(a); await store.upsertVaultSource(b);
  const first = (await store.readSourceManifest()).entries.find(entry => entry.path === a)!;
  const previous = (await store.readMemoryIndex()).find(memory => memory.id === first.memoryIds[0])!;
  const foreignBefore = (await store.readMemoryIndex()).find(memory => memory.id === foreign.id)!;
  expect(previous.content).toContain("oldstamp");
  await seed(fixture, a, nextText); await store.upsertVaultSource(a);
  const updated = (await store.readSourceManifest()).entries.find(entry => entry.path === a)!;
  expect(updated.sourceId).toBe(first.sourceId); expect(updated.firstSeenAt).toBe(first.firstSeenAt);
  expect(updated.contentHash).not.toBe(first.contentHash);
  const revised = (await store.readMemoryIndex()).find(memory => memory.id === previous.id)!;
  expect(revised.history.some(history => history.content === previous.content)).toBe(true);
  expect((await graph(fixture)).nodes.some(node => node.type === "concept" && node.label === "alphaprivate")).toBe(false);
  const renamed = store.path(store.settings.folders.dailyRoot, "Renamed Alpha.md");
  await mkdir(dirname(vault.diskPath(renamed)), { recursive: true });
  await vault.rename(store.getFile(a)!, renamed); await store.renameVaultSource(a, renamed);
  const sourceAfterRename = (await store.readSourceManifest()).entries.find(entry => entry.path === renamed)!;
  expect(sourceAfterRename.sourceId).toBe(first.sourceId); expect(sourceAfterRename.previousPaths).toContain(a);
  const renamedMemory = (await store.readMemoryIndex()).find(memory => memory.id === previous.id)!;
  expect(renamedMemory.history).toEqual(revised.history);
  expect(renamedMemory.evidence.some(evidence => evidence.sourceId === first.sourceId && evidence.path === renamed)).toBe(true);
  expect((await graph(fixture)).nodes.some(node => node.path === a)).toBe(false);
  expect(await vault.bytes(renamed)).toBe(nextText); expect(await vault.bytes(b)).toBe(otherText);
  const unchanged = await protectedBytes(fixture);
  await store.rebuildKnowledgeStructure();
  for (const original of unchanged) expect(await vault.bytes(original.path)).toBe(original.raw);
  await vault.delete(store.getFile(renamed)!); await store.removeVaultSource(renamed);
  const kept = await graph(fixture), deleted = (await store.readSourceManifest()).entries.find(entry => entry.sourceId === first.sourceId)!;
  expect(deleted.status).toBe("deleted"); expect(deleted.previousPaths).toContain(a);
  expect(kept.nodes.some(node => node.type === "concept" && node.label === "sharedanchor")).toBe(true);
  expect(kept.nodes.some(node => node.type === "note" && node.path === b)).toBe(true);
  expect.soft(kept.nodes.filter(node => node.type === "category" && node.label === sourceAfterRename.category)).toEqual([]);
  const stale = (await store.readMemoryIndex()).find(memory => memory.id === previous.id)!;
  expect(stale.status).toBe("stale"); expect(stale.history).toEqual(revised.history);
  expect((await store.readMemoryIndex()).find(memory => memory.id === foreign.id)).toEqual(foreignBefore);
  expect(await vault.bytes(store.personalMemoryPath())).toBe(authority);
  expect(await vault.bytes(store.path(store.settings.folders.aiReports, "Operations", "operation-ledger.json"))).toBe(ledger);
  expect(await vault.bytes(b)).toBe(otherText);
  await vault.delete(store.getFile(b)!); await store.removeVaultSource(b);
  expect.soft((await graph(fixture)).nodes).toEqual([]);
  expect((await graph(fixture)).edges).toEqual([]);
});

it("reads only the changed source incrementally and reads each source once for a full graph build", async () => {
  const { vault, store } = fixture;
  const paths = ["Alpha", "Beta", "Gamma"].map(name => store.path(store.settings.folders.ideas, `${name}.md`));
  for (const [i, path] of paths.entries()) { await seed(fixture, path, `# Source ${i}\n\nsharedanchor individual${i}`); await store.upsertVaultSource(path); }
  const reads = vi.spyOn(vault, "read");
  await seed(fixture, paths[0], "# Source 0\n\nsharedanchor changedonlyalpha");
  await store.upsertVaultSource(paths[0]);
  const sourceReads = () => reads.mock.calls.map(([file]) => file.path).filter(path => paths.includes(path));
  expect(sourceReads()).toEqual([paths[0]]);
  reads.mockClear();
  await store.rebuildKnowledgeStructure();
  expect(sourceReads().slice().sort()).toEqual(paths.slice().sort());
});
