import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  App: class {}, TFile: class {}, TFolder: class {}, Notice: class {},
  requestUrl: () => { throw Error("Unexpected provider request"); },
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/")
}));
const { createFsApp } = await import("./helpers/fsApp");
const { LifeOpsStore } = await import("../src/store");
const { DEFAULT_SETTINGS } = await import("../src/defaults");
// @ts-expect-error Node fixture generator is tested with the production store.
const { makeEvalVault } = await import("../scripts/make-eval-vault.mjs");
let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

it("provides file behavior and metadata through the same disk-backed app", async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-fs-app-"));
  const app = createFsApp(root);
  await app.vault.createFolder("notes");
  const file = await app.vault.create("notes/example.md", '---\ndate: "2026-11-12"\n---\nfirst');
  const changed: string[] = [];
  const subscription = app.vault.on("modify", (value: unknown) => changed.push((value as { path: string }).path));
  await app.vault.process(file, (text) => text + "\nsecond");
  expect(app.vault.getMarkdownFiles()).toHaveLength(1);
  expect(app.metadataCache.getFileCache(file)?.frontmatter?.date).toBe("2026-11-12");
  expect(await readFile(join(root, file.path), "utf8")).toContain("second");
  expect(changed).toEqual(["notes/example.md"]);
  app.vault.offref(subscription);
  await app.vault.modify(file, "third");
  expect(changed).toHaveLength(1);
  expect(await app.vault.adapter.read(file.path)).toBe("third");
  await app.vault.delete(file);
  expect(app.vault.getMarkdownFiles()).toHaveLength(0);
});

it("can write a task through the production store with the generated JSON and mirror", async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-fs-app-eval-"));
  await makeEvalVault(root);
  const app = createFsApp(root);
  const store = new LifeOpsStore(app, structuredClone(DEFAULT_SETTINGS));
  await store.initializeVault();
  const before = await store.readTaskDb({ readOnly: true });
  const task = await store.createTask({ title: "虚构检查任务", date: "2026-11-13", time: "15:00" });
  const after = await store.readTaskDb({ readOnly: true });
  expect(after.tasks).toHaveLength(before.tasks.length + 1);
  expect(after.tasks.find((row) => row.id === task.id)).toMatchObject({ title: "虚构检查任务", date: "2026-11-13" });
  expect(await app.vault.adapter.read("LifeOps/Goals/Tasks/任务看板.md")).toContain(`ID=${task.id}`);
});
