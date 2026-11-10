import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";
import type { InjectedContext } from "../src/contextInjection";
import { recordConversationMemory } from "../src/memorySystem";
import { emptyPersonalMemoryDocument } from "../src/personalMemory";

vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost;
const context = { time: { date: "2026-09-23", timeOfDay: "morning" }, taskSummary: { totalActive: 0, overdue: 0, dueToday: 0 } } as InjectedContext;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const candidate = { kind: "core_profile" as const, content: "用户喜欢简短回复", sourceRefs: [{ sourceId: "conversation:test", path: "conversation.md", capturedAt: "2026-09-23T00:00:00Z" }] };
function memoryLogPath() { return store.path(store.settings.folders.aiReports, "Memory", "conversation-memory.jsonl"); }
function conversationPath() { return store.path(store.settings.folders.aiReports, "Conversations", "2026-09-23.md"); }
function append(kind: "conversation" | "memory", isCurrent: () => boolean) {
  return kind === "conversation"
    ? store.appendAgentConversation("测试输入", "迟到回复", "2026-09-23", isCurrent)
    : recordConversationMemory(store, "我喜欢简短回复", "迟到回复", context, isCurrent);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-conversation-cancel-"));
  vault = new DiskVault(root);
  store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("cancelled conversation persistence on actual temporary files", () => {
  it.each(["conversation", "memory"] as const)("blocks a late %s file creation after folder preparation", async kind => {
    let current = true;
    const entered = deferred(), release = deferred();
    const ensureFolder = store.ensureFolder.bind(store);
    vi.spyOn(store, "ensureFolder").mockImplementation(async path => {
      await ensureFolder(path);
      entered.resolve();
      await release.promise;
    });
    const pending = append(kind, () => current);
    await entered.promise;
    current = false;
    release.resolve();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(store.getFile(kind === "conversation" ? conversationPath() : memoryLogPath())).toBeNull();
    expect(store.getFile(store.personalMemoryPath())).toBeNull();
    expect(vault.writes.filter(write => write.kind !== "createFolder")).toEqual([]);
  });

  it.each(["conversation", "memory"] as const)("preserves existing %s bytes when cancellation precedes the process callback", async kind => {
    const path = kind === "conversation" ? conversationPath() : memoryLogPath();
    await vault.seed(path, "already saved\n");
    let current = true;
    const entered = deferred(), release = deferred();
    vault.beforeProcess = async () => { entered.resolve(); await release.promise; };
    const pending = append(kind, () => current);
    await entered.promise;
    current = false;
    release.resolve();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(await vault.bytes(path)).toBe("already saved\n");
    expect(store.getFile(store.personalMemoryPath())).toBeNull();
    expect(vault.writes).toEqual([]);
  });

  it("checks cancellation when the recorded candidate callback finally starts", async () => {
    let current = true;
    const entered = deferred(), release = deferred();
    const run = store.runFactOperation!.bind(store);
    vi.spyOn(store, "runFactOperation").mockImplementation((identity, execute, finalize) => run(identity, async scoped => {
      entered.resolve();
      await release.promise;
      return execute(scoped);
    }, finalize));
    const upsert = vi.spyOn(LifeOpsStore.prototype, "upsertPersonalMemory");
    const pending = recordConversationMemory(store, "我喜欢简短回复", "收到", context, () => current);
    await entered.promise;
    current = false;
    release.resolve();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(upsert).not.toHaveBeenCalled();
    expect(store.getFile(store.personalMemoryPath())).toBeNull();
    expect(await vault.bytes(memoryLogPath())).toContain("我喜欢简短回复");
  });

  it("does not recreate a candidate after cancellation during its initial read", async () => {
    let current = true;
    const entered = deferred(), release = deferred();
    const read = LifeOpsStore.prototype.readPersonalMemories;
    vi.spyOn(LifeOpsStore.prototype, "readPersonalMemories").mockImplementation(async function (this: InstanceType<typeof LifeOpsStore>) {
      const document = await read.call(this);
      entered.resolve();
      await release.promise;
      return document;
    });
    const pending = recordConversationMemory(store, "我喜欢简短回复", "收到", context, () => current);
    await entered.promise;
    current = false;
    release.resolve();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(store.getFile(store.personalMemoryPath())).toBeNull();
  });

  it("does not create a candidate after its persistence folder finishes preparing", async () => {
    let current = true;
    const entered = deferred(), release = deferred();
    const ensureFolder = store.ensureFolder.bind(store);
    vi.spyOn(store, "ensureFolder").mockImplementation(async path => {
      await ensureFolder(path);
      entered.resolve();
      await release.promise;
    });
    const pending = store.upsertPersonalMemory(candidate, () => current);
    await entered.promise;
    current = false;
    release.resolve();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(store.getFile(store.personalMemoryPath())).toBeNull();
    expect(vault.writes.filter(write => write.kind !== "createFolder")).toEqual([]);
  });

  it("checks a candidate again inside the actual existing-file update", async () => {
    const original = JSON.stringify(emptyPersonalMemoryDocument());
    await vault.seed(store.personalMemoryPath(), original);
    let current = true;
    const entered = deferred(), release = deferred();
    vault.beforeProcess = async () => { entered.resolve(); await release.promise; };
    const pending = store.upsertPersonalMemory(candidate, () => current);
    await entered.promise;
    current = false;
    release.resolve();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(await vault.bytes(store.personalMemoryPath())).toBe(original);
    expect(vault.writes).toEqual([]);
  });

  it("preserves an already committed candidate when cancellation is observed after the operation", async () => {
    let current = true;
    const run = store.runFactOperation!.bind(store);
    vi.spyOn(store, "runFactOperation").mockImplementation(async (identity, execute, finalize) => {
      const result = await run(identity, execute, finalize);
      current = false;
      return result;
    });
    await expect(recordConversationMemory(store, "我喜欢简短回复", "收到", context, () => current)).rejects.toMatchObject({ name: "AbortError" });
    expect((await store.readPersonalMemories()).records).toEqual([
      expect.objectContaining({ content: "我喜欢简短回复", status: "candidate" })
    ]);
  });

});
