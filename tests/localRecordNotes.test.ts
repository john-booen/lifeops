import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../src/agentRuntime";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { factRecoveryPath } from "../src/dataFoundation/factOperation";
import { OperationLedger } from "../src/dataFoundation/operationLedger";
import { ensureLocalRecordNote, localRecordNotePath, type LocalRecordKind, type LocalRecordNoteInput } from "../src/localRecordNotes";
import type { StoreHost } from "../src/store/settingsSlice";

vi.mock("obsidian", () => ({
  App: class {}, Notice: class {}, TFile: class {}, TFolder: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/")
}));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: AgentRuntime;
const date = "2026-09-14";
const kinds: LocalRecordKind[] = ["morning", "evening", "trading-review"];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-local-records-"));
  vault = new DiskVault(root);
  store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  runtime = new AgentRuntime({ store, refreshViews: async () => undefined });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function create(input: LocalRecordNoteInput, id = `create-${input.kind}`) {
  let note: Awaited<ReturnType<typeof ensureLocalRecordNote>> | undefined;
  const result = await runtime.executeLocalOperation("open_local_record", { ...input }, async scope => {
    note = await ensureLocalRecordNote(scope, input);
  }, id);
  return { result, note };
}

describe("local handwritten records through the real Runtime and disk Vault", () => {
  it.each(kinds)("creates %s using existing paths, with a verified reversible record", async kind => {
    const input = { kind, date };
    const expectedPath = kind === "trading-review" ? store.tradingReviewPath(date)
      : store.dailyNotePath(date, kind === "morning" ? "早" : "晚");
    expect(localRecordNotePath(store, input)).toBe(expectedPath);
    expect(vault.writes).toEqual([]);
    const { result, note } = await create(input);
    expect(result.success, result.output).toBe(true);
    expect(note).toEqual({ path: expectedPath, created: true });
    const text = await vault.bytes(expectedPath);
    expect(text).toContain(date);
    if (kind === "trading-review") expect(text).toContain("## 使用的模型与入场依据");
    else expect(text).toBe(`# ${date}${kind === "morning" ? "早" : "晚"}\n\n`);
    expect(text).not.toContain("AI");
    expect(await new OperationLedger(store).latestReversible()).toMatchObject({
      operationId: `create-${kind}`, status: "verified",
      result: { undo: { kind: "restore_guarded_files", files: [{ path: expectedPath, before: null, after: text }] } }
    });
  });

  it.each(kinds)("reopens an edited %s without altering any byte or making any write", async kind => {
    const input = { kind, date }, path = localRecordNotePath(store, input);
    const original = "---\r\n我的字段: 保留\r\n---\r\n# 自由书写\r\n\r\n今天做了什么，由我自己记录。  \r\n";
    await vault.seed(path, original);
    expect(await ensureLocalRecordNote(store, input)).toEqual({ path, created: false });
    expect(await ensureLocalRecordNote(store, input)).toEqual({ path, created: false });
    expect(await vault.bytes(path)).toBe(original);
    expect(vault.writes).toEqual([]);
  });

  it("does not insert a template into an existing empty journal", async () => {
    const input = { kind: "morning" as const, date }, path = localRecordNotePath(store, input);
    await vault.seed(path, "");
    expect((await ensureLocalRecordNote(store, input)).created).toBe(false);
    expect(await vault.bytes(path)).toBe("");
    expect(vault.writes).toEqual([]);
  });

  it("keeps a backdated leap-day record separate from today's records and configured folders", async () => {
    store.settings.folders.dailyRoot = "我的记录/日记";
    store.settings.folders.tradingReviews = "我的记录/交易";
    for (const kind of kinds) {
      const { result, note } = await create({ kind, date: "2024-02-29" });
      expect(result.success, result.output).toBe(true);
      expect(note!.path).toBe(kind === "trading-review" ? "我的记录/交易/2024/2月/2024-02-29.md"
        : `我的记录/日记/2024/02/2024-02-29${kind === "morning" ? "早" : "晚"}.md`);
      expect(store.getFile(localRecordNotePath(store, { kind, date }))).toBeNull();
    }
  });

  it.each(["", "2026-2-03", "2026-02-29", "1900-02-29", "2026-04-31", "2026-13-01", "2026-00-01", "2026-01-00", "0000-01-01", "2026-09-14T00:00:00Z", "../2026-09-14", "2026-09-14\n"])("rejects invalid date %j before any read or write", async invalid => {
    const getFile = vi.spyOn(store, "getFile");
    const input = { kind: "morning" as const, date: invalid };
    expect(() => localRecordNotePath(store, input)).toThrow("日期");
    await expect(ensureLocalRecordNote(store, input)).rejects.toThrow("日期");
    expect(getFile).not.toHaveBeenCalled();
    expect(vault.writes).toEqual([]);
  });

  it.each(["journal", "Morning", "../morning", "", null])( "rejects an unknown kind %j with no writes", async kind => {
    await expect(ensureLocalRecordNote(store, { kind, date } as LocalRecordNoteInput)).rejects.toThrow("请选择");
    expect(vault.writes).toEqual([]);
  });

  it.each(["../外部", "/绝对路径", "日记/../其他", "日记/.隐藏", "日记\\其他", "日记//其他", "C:/日记", "", "日记/\u0000"])("rejects unsafe configured directory %j before creating folders", async folder => {
    store.settings.folders.dailyRoot = folder;
    await expect(ensureLocalRecordNote(store, { kind: "morning", date })).rejects.toThrow("目录");
    expect(vault.writes).toEqual([]);
  });

  it("rejects a record directory inside the operation ledger area", async () => {
    store.settings.folders.tradingReviews = store.path(store.settings.folders.aiReports, "Operations");
    await expect(ensureLocalRecordNote(store, { kind: "trading-review", date })).rejects.toThrow("目录");
    expect(vault.writes).toEqual([]);
  });

  it("recovers from a disk save failure and allows a clean retry", async () => {
    const input = { kind: "evening" as const, date }, path = localRecordNotePath(store, input);
    const originalCreate = vault.create.bind(vault);
    let failOnce = true;
    vault.create = async (target, content) => {
      if (target === path && failOnce) { failOnce = false; throw new Error("模拟磁盘保存失败"); }
      return originalCreate(target, content);
    };
    const failed = await create(input, "disk-failure");
    expect(failed.result.success).toBe(false);
    expect(failed.result.output).toContain("保存没有完成");
    expect(store.getFile(path)).toBeNull();
    expect(JSON.parse(await vault.bytes(factRecoveryPath(store))).status).toBe("rolled_back");
    const retried = await create(input, "retry-after-failure");
    expect(retried.result.success, retried.result.output).toBe(true);
    expect(await vault.bytes(path)).toBe(`# ${date}晚\n\n`);
  });

  it("rolls back a new template if saving its audit fails", async () => {
    const input = { kind: "trading-review" as const, date }, path = localRecordNotePath(store, input);
    const originalProcess = vault.process.bind(vault);
    let failOnce = true;
    vault.process = async (file, updater) => {
      if (file.path.endsWith("operation-ledger.json") && store.getFile(path) && failOnce) {
        failOnce = false;
        throw new Error("模拟保存操作记录失败");
      }
      return originalProcess(file, updater);
    };
    expect((await create(input)).result.success).toBe(false);
    expect(store.getFile(path)).toBeNull();
    expect(JSON.parse(await vault.bytes(factRecoveryPath(store))).status).toBe("rolled_back");
  });

  it.each(kinds)("can undo a newly created %s template", async kind => {
    const input = { kind, date }, path = localRecordNotePath(store, input);
    expect((await create(input)).result.success).toBe(true);
    await runtime.undoOperation(`create-${kind}`);
    expect(store.getFile(path)).toBeNull();
  });

  it("refuses template undo after the user has written their journal", async () => {
    const input = { kind: "morning" as const, date }, path = localRecordNotePath(store, input);
    await create(input);
    const handwritten = `${await vault.bytes(path)}\n今天我已经写下真实记录，不能撤销掉。\n`;
    await vault.modify(store.getFile(path)!, handwritten);
    await expect(runtime.undoOperation("create-morning")).rejects.toThrow("变化");
    expect(await vault.bytes(path)).toBe(handwritten);
  });
});
