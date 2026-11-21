import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { beforeAll, afterAll, afterEach, expect, it, vi } from "vitest";
import type { StoreHost } from "../src/store/settingsSlice";
import { DEFAULT_SETTINGS } from "../src/defaults";
vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, TFolder: class {}, Notice: class {},
  normalizePath: (s: string) => s.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), requestUrl: vi.fn(),
  parseYaml: JSON.parse, stringifyYaml: JSON.stringify }));
const { createFsApp } = await import("./helpers/fsApp");
const { LifeOpsStore } = await import("../src/store");
const { AgentRuntime } = await import("../src/agentRuntime");
const { recoverFactOperation, hasPendingFactOperation } = await import("../src/dataFoundation/factOperation");
const { PhoneInbox } = await import("../src/features/phoneInbox/service");
const { PHONE_INBOX_PATH, parsePhoneInbox, phoneInboxWriteId } = await import("../src/features/phoneInbox/model");
const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
const { taskBatchManifestPath } = await import("../src/features/tasks/batchWrite");
let bundleRoot: string, executable: string;
const roots: string[] = [];
beforeAll(async () => {
  bundleRoot = await mkdtemp(join(tmpdir(), "lifeops-phone-batch-child-")); executable = join(bundleRoot, "child.mjs");
  await build({ entryPoints: [resolve("tests/helpers/taskBatchChild.ts")], outfile: executable, bundle: true, platform: "node",
    format: "esm", target: "node22", alias: { obsidian: resolve("tests/helpers/obsidianFileMock.ts") }, logLevel: "silent" });
});
afterAll(async () => { await rm(bundleRoot, { recursive: true, force: true }); });
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.each(["after-third-task", "after-marker", "after-audit"])("recovers a real process kill at %s without a partial batch or repeated model call", async phase => {
  const root = await mkdtemp(join(tmpdir(), "lifeops-phone-batch-recovery-")); roots.push(root);
  const child = spawnSync(process.execPath, [executable, root, phase], { encoding: "utf8", timeout: 10_000 });
  expect(child.error).toBeUndefined(); expect(child.signal, child.stderr).toBe("SIGKILL");
  const settings = structuredClone(DEFAULT_SETTINGS), app = createFsApp(join(root, "vault"));
  const store = new LifeOpsStore(app, settings) as unknown as StoreHost;
  const raw = await store.readPath(PHONE_INBOX_PATH);
  const operationId = phoneInboxWriteId(parsePhoneInbox(raw, "2066-01-10")[0].id);
  expect(await hasPendingFactOperation(store)).toBe(true);
  const recovery = await recoverFactOperation(store);
  expect(recovery).toBe(phase === "after-audit" ? "kept" : "restored");
  expect(await hasPendingFactOperation(store)).toBe(false);
  const rows = (await store.readTaskDb()).tasks;
  expect(rows).toHaveLength(phase === "after-audit" ? 6 : 1);
  expect(rows.some(row => row.title === "虚构保留的独立任务")).toBe(true);
  expect(Boolean(store.getFile(taskBatchManifestPath(store, operationId)))).toBe(phase === "after-audit");
  if (phase === "after-audit") {
    const runtime = new AgentRuntime({ store, refreshViews: async () => {} });
    const submit = vi.fn(async () => { throw Error("Committed batch must be recovered from its ledger"); });
    const inbox = new PhoneInbox({ store: () => store, enabled: () => true, submit,
      confirm: async () => {}, undo: id => runtime.undoOperation(id), notify: () => {} }, new LifeOpsEventBus());
    try {
      await inbox.scan(); await inbox.scan();
      const [receipt] = await inbox.list();
      expect(receipt).toMatchObject({ status: "saved", operationId, taskBatch: { created: 5, existing: 0 } });
      expect(submit).not.toHaveBeenCalled();
      await inbox.resolve(receipt.id, "undo");
      expect((await store.readTaskDb()).tasks.map(row => row.title)).toEqual(["虚构保留的独立任务"]);
    } finally { inbox.stop(); }
  }
  expect(await store.readPath(PHONE_INBOX_PATH)).toBe(raw);
});
