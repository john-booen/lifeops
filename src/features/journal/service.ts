import { Notice } from "obsidian";
import type LifeOpsPlugin from "../../main";
import { todayString } from "../../date";
import { createReadonlyRecordLibrary, type ReadonlyRecordLibrary } from "../../readonlyRecordLibrary";
import { ensureLocalRecordNote, localRecordNotePath, type LocalRecordKind } from "../../localRecordNotes";
import { LocalRecordNoteModal } from "../../localRecordNoteModal";
import { CalendarNoteModal } from "../../modals";
import { fileRevision } from "../../dataFoundation/factOperation";
import { previewLegacyJournalLayout } from "../../legacyJournalLayout";
import type { StoreHost } from "../../store/settingsSlice";
import type { ToolCallResult } from "../../agentRuntime";
import type { OperationUndoDescriptor } from "../../dataFoundation/operationLedger";

export interface JournalHost {
  app: LifeOpsPlugin["app"];
  createAgentRuntime: LifeOpsPlugin["createAgentRuntime"];
  lifecycleGeneration: LifeOpsPlugin["lifecycleGeneration"];
  openLocalRecordNote: LifeOpsPlugin["openLocalRecordNote"];
  refreshViews: LifeOpsPlugin["refreshViews"];
  saveLocalOperation: LifeOpsPlugin["saveLocalOperation"];
  store: LifeOpsPlugin["store"];
  unloaded: LifeOpsPlugin["unloaded"];
}

export function openLocalRecordPicker(this: JournalHost): void {
  new LocalRecordNoteModal(this.app, (input, isCurrent) => this.openLocalRecordNote(input.kind, input.date, isCurrent)).open();
}

export function createRecordLibrary(this: JournalHost): ReadonlyRecordLibrary {
  const ownerStore = this.store;
  const store = ownerStore as unknown as StoreHost;
  const generation = this.lifecycleGeneration;
  const assertCurrent = () => {
    if (this.unloaded || this.lifecycleGeneration !== generation || this.store !== ownerStore) throw Error("记录库已关闭，请重新打开。");
  };
  assertCurrent();
  return createReadonlyRecordLibrary(store, async (file, signal) => {
    assertCurrent(); signal.throwIfAborted();
    await this.app.workspace.getLeaf("tab").openFile(file, { state: { mode: "preview" } });
    assertCurrent(); signal.throwIfAborted();
  }, assertCurrent);
}

export async function openLocalRecordNote(this: JournalHost, kind: LocalRecordKind, date = todayString(), isCurrent: () => boolean = () => true): Promise<void> {
  try {
    if (this.unloaded || !isCurrent()) return;
    const store = this.store as unknown as StoreHost;
    const path = localRecordNotePath(store, { kind, date });
    if (!store.getFile(path)) {
      await this.saveLocalOperation("local_openRecordNote", { kind, date }, store => ensureLocalRecordNote(store, { kind, date }));
    }
    if (this.unloaded || !isCurrent()) return;
    const file = store.getFile(path);
    if (!file) throw new Error("Record unavailable");
    await this.app.workspace.getLeaf("tab").openFile(file, { state: { mode: "source" } });
    await this.refreshViews();
  } catch {
    new Notice("记录没有打开，已有内容已保留。请重试或把这条提示告诉我。");
    throw new Error("记录没有打开。");
  }
}

export function openCalendarNoteModal(this: JournalHost, date: string): void {
  new CalendarNoteModal(this.app, date, async (note) => {
    await this.saveLocalOperation("local_appendCalendarNote", { arguments: [date, note] }, store => store.appendCalendarNote(date, note));
    await this.refreshViews();
    new Notice("LifeOps 已保存当天备注");
  }).open();
}

export async function normalizeLegacyJournalLayout(this: JournalHost, path: string, expectedHash: string): Promise<{
    path: string; operationId: string; changed: boolean; beforeHash: string; afterHash: string; removedPrefixBytes: number;
  }> {
  const host = this.store as unknown as StoreHost;
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || !path || path.includes("\\") || /^[\/~]|^[a-z][a-z\d+.-]*:/i.test(path)
    || /[\u0000-\u001f]/.test(path) || path.split("/").some(part => !part || part === "." || part === "..")
    || !path.startsWith(`${host.settings.folders.dailyRoot}/`) || !host.isManagedSourcePath(path)) {
    throw new Error("旧日记整理需要受管理日记的准确路径和预览时的完整内容散列。");
  }
  const file = host.getFile(path);
  if (!file || file.path !== path) throw new Error("指定日记不存在，未新建或替换其他文件。");
  const observed = await host.app.vault.read(file);
  if (fileRevision(observed) === expectedHash) {
    const preview = previewLegacyJournalLayout(path, observed);
    if (!preview.eligible) throw new Error(preview.reason);
  }
  // Same path/hash denotes the same explicit operation. A cached result is
  // still checked against today's source bytes below before reporting success.
  const operationId = `local:normalize_legacy_journal_layout:${fileRevision(`${path}\u0000${expectedHash}`)}`;
  const result = await this.createAgentRuntime().executeLocalOperation("local_normalize_legacy_journal_layout", { path, expectedHash }, async store => {
    if (!store.isManagedSourcePath(path) || !path.startsWith(`${store.settings.folders.dailyRoot}/`)) throw new Error("日记路径已不在允许范围，未修改原文。");
    const target = store.getFile(path);
    if (!target || target.path !== path) throw new Error("指定日记不存在，未新建文件。");
    const original = await store.app.vault.read(target);
    if (target.path !== path || store.getFile(path)?.path !== path) throw new Error("日记在读取期间被移动，已停止整理。");
    if (fileRevision(original) !== expectedHash) throw new Error("日记在预览后发生变化，已保留后来编辑，请重新预览。");
    const preview = previewLegacyJournalLayout(path, original);
    if (!preview.eligible) throw new Error(preview.reason);
    await store.app.vault.process(target, current => {
      if (target.path !== path) throw new Error("日记在整理前被移动，已停止写入。");
      if (current !== original) throw new Error("日记在整理前发生变化，已停止覆盖。");
      return preview.content;
    });
    if (await store.app.vault.read(target) !== preview.content) throw new Error("整理后的正文读回不一致，请检查恢复记录。");
  }, operationId);
  if (!result.success) throw new Error(result.output);
  const undo = (result as ToolCallResult & { undo?: OperationUndoDescriptor }).undo;
  const change = undo?.kind === "restore_guarded_files" && undo.files.length === 1 ? undo.files[0] : null;
  if (!change || change.path !== path || change.beforeHash !== expectedHash || typeof change.before !== "string" || typeof change.after !== "string") {
    throw new Error("整理操作缺少准确恢复凭据，请检查操作记录。");
  }
  const current = host.getFile(path);
  if (!current || current.path !== path || await host.app.vault.read(current) !== change.after) {
    throw new Error("日记在整理后又发生变化，已保留当前内容，不能复用旧整理结果。");
  }
  return { path, operationId, changed: observed !== change.after, beforeHash: change.beforeHash, afterHash: change.afterHash,
    removedPrefixBytes: Buffer.byteLength(change.before, "utf8") - Buffer.byteLength(change.after, "utf8") };
}
