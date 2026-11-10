import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { createObservation, type Observation, type ObservationDocument } from "../src/observationStore";
import type { StoreHost } from "../src/store/settingsSlice";

vi.mock("obsidian", () => ({
  App: class {}, Notice: class {}, TFile: class {}, TFolder: class {},
  normalizePath: (value: string) => value.replace(/\\/g, "/").replace(/\/{2,}/g, "/"),
  requestUrl: vi.fn(() => { throw Error("Network forbidden"); })
}));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "lifeops-observation-race-")); vault = new DiskVault(root); store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const row = (id: string, source: Observation["source"], observedAt = new Date().toISOString()) => createObservation({ id, source, kind: "fictional_control", summary: id, observedAt, ttlMs: 3_600_000 });
const document = (observations: Observation[]): ObservationDocument => ({ version: 1, updatedAt: new Date().toISOString(), observations });
const seed = async (observations: Observation[]) => vault.seed(store.observationsPath(), JSON.stringify(document(observations)));
const persisted = async () => JSON.parse(await vault.bytes(store.observationsPath())) as ObservationDocument;

it("prunes expired rows against current bytes without erasing an observation added before atomic update", async () => {
  const expired = row("expired-camera", "camera", "2000-01-01T00:00:00Z"), desktop = row("fresh-desktop", "desktop");
  await seed([expired]);
  vault.beforeProcess = async file => { expect(file.path).toBe(store.observationsPath()); await seed([expired, desktop]); };
  expect((await store.readObservations()).observations).toEqual([desktop]);
  expect((await persisted()).observations).toEqual([desktop]);
});

it("clears only the selected source while preserving a different source added before atomic update", async () => {
  const camera = row("camera", "camera"), task = row("task", "task"), desktop = row("new-desktop", "desktop");
  await seed([camera, task]);
  vault.beforeProcess = async () => { await seed([camera, task, desktop]); };
  await store.clearObservations("camera");
  expect((await persisted()).observations).toEqual([task, desktop]);
});

it("preserves exact persisted bytes and update time when no rows match the cleared source", async () => {
  const raw = JSON.stringify({ observations: [row("retained-desktop", "desktop")], updatedAt: "2026-10-22T07:59:01.255Z", version: 1 }, null, 4) + "\n";
  await vault.seed(store.observationsPath(), raw);
  await store.clearObservations("camera");
  expect(await vault.bytes(store.observationsPath())).toBe(raw);
});

it("appends to the current document instead of replacing an intervening producer's row", async () => {
  const task = row("task", "task"), voice = row("new-voice", "voice");
  await seed([task]);
  vault.beforeProcess = async () => { await seed([task, voice]); };
  const desktop = await store.appendObservation({ id: "new-desktop", source: "desktop", kind: "fictional_control", summary: "desktop" });
  const actual = (await persisted()).observations;
  expect(actual.map(item => item.id).sort()).toEqual([task.id, voice.id, desktop.id].sort());
  expect(actual.find(item => item.id === voice.id)).toEqual(voice);
  expect(actual.find(item => item.id === task.id)).toEqual(task);
});

it.each(["{broken", JSON.stringify({ version: 2, observations: [], future: "must remain" })])("refuses invalid or future current documents without overwriting them", async raw => {
  await vault.seed(store.observationsPath(), raw);
  await expect(store.appendObservation({ source: "task", kind: "test", summary: "fictional" })).rejects.toThrow();
  expect(await vault.bytes(store.observationsPath())).toBe(raw);
});

it("does not turn a creation race into an overwrite of another document", async () => {
  const foreign = JSON.stringify({ version: 2, observations: [], future: "must remain" });
  const originalCreate = vault.create.bind(vault);
  vi.spyOn(vault, "create").mockImplementationOnce(async (path, content) => { await vault.seed(path, foreign); return originalCreate(path, content); });
  await expect(store.appendObservation({ source: "task", kind: "test", summary: "fictional" })).rejects.toThrow();
  expect(await vault.bytes(store.observationsPath())).toBe(foreign);
});

it("preserves concurrent first observations from two Store instances sharing one vault", async () => {
  const other = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS));
  const [desktop, task] = await Promise.all([
    store.appendObservation({ id: "first-desktop", source: "desktop", kind: "test", summary: "fictional desktop" }),
    other.appendObservation({ id: "first-task", source: "task", kind: "test", summary: "fictional task" })
  ]);
  expect((await persisted()).observations.map(item => item.id).sort()).toEqual([desktop.id, task.id].sort());
});

it("releases a failed update so a later valid document can be updated", async () => {
  await vault.seed(store.observationsPath(), "{broken");
  await expect(store.clearObservations("camera")).rejects.toThrow();
  const task = row("repaired-task", "task");
  await seed([task]);
  const desktop = await store.appendObservation({ id: "after-error", source: "desktop", kind: "test", summary: "fictional desktop" });
  expect((await persisted()).observations.map(item => item.id).sort()).toEqual([task.id, desktop.id].sort());
});
