import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";

vi.mock("obsidian", () => ({
  App: class {}, Notice: class {}, TFile: class {}, TFolder: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/")
}));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const { migrateM1Fields } = await import("../src/dataFoundation/migrateM1");
const { OperationLedger } = await import("../src/dataFoundation/operationLedger");

let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-m1-migration-"));
  vault = new DiskVault(root);
  store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault();
  const task = await store.createTask({ title: "旧任务", category: "AI建议" });
  await store.createTask({ title: "自定义分类任务", category: "旧分类" });
  const db = JSON.parse(await vault.bytes(store.taskDbPath()));
  delete db.tasks.find((item: { id: string }) => item.id === task.id).category;
  delete db.taskMirror;
  await vault.seed(store.taskDbPath(), JSON.stringify(db));
  await store.createHabit({ name: "旧习惯", frequencyUnit: "day", frequencyInterval: 1, targetCount: 2 });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("migrates only missing task and habit fields once and preserves the old habit mirror", async () => {
  const habitMirror = await vault.bytes(store.habitMirrorPath());
  expect(await migrateM1Fields(store)).toEqual({ tasks: 1, habits: 1 });
  expect((await store.readTaskDb()).tasks).toMatchObject([
    { title: "旧任务", category: "work" }, { title: "自定义分类任务", category: "旧分类" }
  ]);
  expect(await vault.bytes(store.taskMirrorPath())).toContain("分类=work");
  expect((await store.readHabitDb()).habits[0]).toMatchObject({
    name: "旧习惯", targetCount: 2, target: { kind: "boolean" }, punishment: { enabled: false, rules: [] }
  });
  expect(await vault.bytes(store.habitMirrorPath())).toBe(habitMirror);
  const ledger = new OperationLedger(store);
  expect(await ledger.latestReversible()).toBeNull();
  const paths = [store.taskDbPath(), store.taskMirrorPath(), store.habitDbPath(), ledger.filePath];
  const first = await Promise.all(paths.map(path => vault.bytes(path)));
  expect(await migrateM1Fields(store)).toEqual({ tasks: 0, habits: 0 });
  expect(await Promise.all(paths.map(path => vault.bytes(path)))).toEqual(first);
});

it("retains the original task and habit files if the old task projection has a conflict", async () => {
  const mirror = store.taskMirrorPath();
  await vault.seed(mirror, (await vault.bytes(mirror)).replace("旧任务", "用户另改的任务"));
  const paths = [store.taskDbPath(), mirror, store.habitDbPath()];
  const before = await Promise.all(paths.map(path => vault.bytes(path)));
  await expect(migrateM1Fields(store)).rejects.toThrow("任务记录或看板发生了变化");
  expect(await Promise.all(paths.map(path => vault.bytes(path)))).toEqual(before);
});
