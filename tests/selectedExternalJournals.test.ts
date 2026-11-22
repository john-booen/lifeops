import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { App } from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";
vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, Modal: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/"), parseYaml: JSON.parse, stringifyYaml: JSON.stringify }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const { externalSourcePath } = await import("../src/features/externalVault/catalog");
const { previewExternalJournal, selectExternalJournalExcerpt, extractSelectedExternalJournalSignals, listSelectableExternalJournals } = await import("../src/features/externalVault/selectedJournals");
const { readExternalJournalSignals } = await import("../src/features/externalVault/journals");
const { validSignalDocument, signalContextLine } = await import("../src/features/journal/signals");
const { readSelectedJournalResults, readSavedJournalResults, assertSelectedJournalResultsCurrent } = await import("../src/features/externalVault/selectedJournalResults");
const { documentPath } = await import("../src/features/externalVault/journals");
let home: string, original: string, store: StoreHost;
const now = new Date("2026-11-22T12:00:00+08:00"), first = "LifeOps/Journal/2026/11/2026-11-04晚.md", second = "LifeOps/Journal/2026/11/2026-11-05晚.md";
const quote = "试做一个虚构蓝纸分类索引。", another = "精力四分。";
const ref = (path: string) => externalSourcePath("虚构资料", path);
const writeOriginal = async (path: string, body: string) => { await mkdir(dirname(join(original, path)), { recursive: true }); await writeFile(join(original, path), body); };
const select = async (path = first, text = quote) => selectExternalJournalExcerpt(await previewExternalJournal(store, ref(path), now), text);
const execute = (chosen: any[], request: any, controller = new AbortController(), current = () => {}) => extractSelectedExternalJournalSignals(store, chosen, request, controller.signal, current, now);
const answer = (date = "2026-11-04", ideas = [{ text: "虚构索引工具", quote }]) => JSON.stringify({ date, period: "晚", energy: 4, quotes: [{ field: "energy", text: another }], ideas });
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "lifeops-selected-originals-")); original = join(home, "original"); await mkdir(original);
  const daily = join(home, "daily"); await mkdir(daily); const settings = structuredClone(DEFAULT_SETTINGS);
  settings.externalVaults = [{ name: "虚构资料", path: original, folders: ["LifeOps/Journal"] }];
  store = new LifeOpsStore({ vault: new DiskVault(daily) } as unknown as App, settings) as unknown as StoreHost; await store.initializeVault();
  await writeOriginal(first, "# 虚构晚记\n\n" + "未选择的虚构旧段。".repeat(900) + "\n\n" + quote + "\n" + another);
  await writeOriginal(second, "# 虚构次日晚记\n\n准备做一个虚构绿纸索引。\n");
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

it("lists dated metadata and previews locally without a provider or derived write", async () => {
  const rows = await listSelectableExternalJournals(store, now); expect(rows.map(row => row.date)).toEqual(["2026-11-05", "2026-11-04"]);
  const view = await previewExternalJournal(store, ref(first), now); expect(view.text).toContain(quote); expect(view.date).toBe("2026-11-04");
  expect(await readExternalJournalSignals(store, "2026-11-04")).toEqual([]);
});
it("does not guess the current year for an undated-year diary or offer future and non-journal notes", async () => {
  const paths = ["LifeOps/Journal/11-06晚.md", "LifeOps/Journal/2027-11-06晚.md", "LifeOps/Journal/2026-02-30晚.md"];
  for (const path of paths) { await writeOriginal(path, "虚构日期不明原文。"); await expect(previewExternalJournal(store, ref(path), now)).rejects.toThrow("请选择"); }
  expect((await listSelectableExternalJournals(store, now)).map(item => item.reference)).toEqual([ref(second), ref(first)]);
});
it("extracts a late selected paragraph, sends no unselected prefix and preserves original bytes", async () => {
  const before = await readFile(join(original, first)), chosen = await select(); const request = vi.fn(async (messages, options) => {
    await options.beforeTextRequest(); expect(messages[1].content.endsWith(quote)).toBe(true); expect(messages[1].content).not.toContain("未选择的虚构旧段"); return answer();
  });
  expect(await execute([chosen], request)).toMatchObject({ saved: 1, existing: 0, examined: 1 }); expect(request).toHaveBeenCalledTimes(1);
  const signals = await readExternalJournalSignals(store, "2026-11-04"); expect(signals[0].ideas[0].quote).toBe(quote);
  expect(signals[0].energy).toBeNull(); expect(signals[0].sources[0].selectedExcerpt).toEqual({ text: quote, sha256: chosen.excerptHash });
  expect(await readFile(join(original, first))).toEqual(before);
});
it("extracts two dates in one submitted batch and never reads an unselected diary into a request", async () => {
  const left = await select(), right = await select(second, "准备做一个虚构绿纸索引。"); const sent: string[] = [];
  const result = await execute([left, right], async (messages: any) => { const text = messages[1].content; sent.push(text); return text.includes("日期 2026-11-04") ? answer() : answer("2026-11-05", [{ text: "虚构绿纸索引", quote: right.excerpt }]); });
  expect(result).toMatchObject({ saved: 2, examined: 2 }); expect(sent[0]).not.toContain(right.excerpt); expect(sent[1]).not.toContain(quote);
  expect(await readExternalJournalSignals(store, "2026-11-05")).toHaveLength(1);
});
it("does not enlarge an in-flight batch when the caller edits its original selection objects", async () => {
  const chosen = [await select(), await select(second, "准备做一个虚构绿纸索引。")], originalExcerpt = chosen[1].excerpt; let calls = 0;
  const result = await execute(chosen, async (messages: any) => {
    if (++calls === 1) { chosen[1].excerpt = "不在授权片段中的虚构新句。"; return answer(); }
    expect(messages[1].content.endsWith(originalExcerpt)).toBe(true); expect(messages[1].content).not.toContain("虚构新句");
    return answer("2026-11-05", [{ text: "虚构索引", quote: originalExcerpt }]);
  }); expect(result.saved).toBe(2);
});
it.each(["", " ", "不是这篇里的原话", "字".repeat(2001)])("rejects an empty, altered or oversized excerpt before sending: %s", async text => {
  const view = await previewExternalJournal(store, ref(first), now); expect(() => selectExternalJournalExcerpt(view, text)).toThrow("连续原文");
});
it("counts unicode characters while preserving exact whitespace", async () => {
  const text = "😀".repeat(2000); await writeOriginal(first, "\n" + text + "\n"); expect((await select(first, text)).excerpt).toBe(text);
  const view = await previewExternalJournal(store, ref(first), now); expect(() => selectExternalJournalExcerpt(view, text + "\n")).toThrow("最多");
});
it("validates the whole batch before its first request or save", async () => {
  const chosen = [await select(), await select(second, "准备做一个虚构绿纸索引。")]; await writeOriginal(second, "改过的虚构次日晚记");
  const request = vi.fn(); await expect(execute(chosen, request)).rejects.toThrow("已经更新"); expect(request).not.toHaveBeenCalled();
  expect(await readExternalJournalSignals(store, "2026-11-04")).toEqual([]);
});
it.each(["source", "scope", "date", "excerpt", "destination"])("refuses changed %s before requesting", async change => {
  const chosen = await select(), request = vi.fn();
  if (change === "source") await writeOriginal(first, "改过的虚构原文");
  if (change === "scope") store.settings.externalVaults = [];
  if (change === "date") chosen.date = "2026-11-05";
  if (change === "excerpt") chosen.excerpt += "改";
  if (change === "destination") store.settings.privacy = { ...store.settings.privacy, excludedVaultPrefixes: [store.settings.folders.aiReports + "/Signals"] };
  await expect(execute([chosen], request)).rejects.toThrow(); expect(request).not.toHaveBeenCalled();
});
it("rechecks source at the deferred provider boundary and after a response before saving", async () => {
  const chosen = await select(), request = vi.fn(async (_messages, options) => { await writeOriginal(first, "虚构原文已变"); await options.beforeTextRequest(); return answer(); });
  await expect(execute([chosen], request)).rejects.toThrow("已经更新"); expect(await readExternalJournalSignals(store, "2026-11-04")).toEqual([]);
  await writeOriginal(first, quote); const fresh = await select(); await expect(execute([fresh], async () => { await writeOriginal(first, "再次改过"); return answer(); })).rejects.toThrow("已经更新");
  expect(await readExternalJournalSignals(store, "2026-11-04")).toEqual([]);
});
it("skips an already stored excerpt without requesting again", async () => {
  const chosen = await select(), request = vi.fn(async () => answer()); await execute([chosen], request);
  expect(await execute([chosen], request)).toMatchObject({ saved: 0, existing: 1 }); expect(request).toHaveBeenCalledTimes(1);
});
it("preserves a second selected paragraph from the same original and labels partial evidence", async () => {
  const firstSelected = await select(), secondSelected = await select(first, another); await execute([firstSelected], async () => answer());
  await execute([secondSelected], async () => answer()); const signals = await readExternalJournalSignals(store, "2026-11-04");
  expect(signals).toHaveLength(2); expect(signals.map(row => row.sources[0].selectedExcerpt!.text)).toEqual([quote, another]); expect(signals[1].ideas).toEqual([]);
  expect(signalContextLine(signals)).toContain("已选日记片段"); expect(signals[1].energy).toBe(4);
});
it("concurrent submissions save one copy and an original edit invalidates old excerpts", async () => {
  const chosen = await select(); await Promise.all([execute([chosen], async () => answer()), execute([chosen], async () => answer())]);
  expect(await readExternalJournalSignals(store, "2026-11-04")).toHaveLength(1); await writeOriginal(first, quote + "\n新的虚构版本");
  expect(await readExternalJournalSignals(store, "2026-11-04")).toEqual([]); await execute([await select()], async () => answer());
  expect(await readExternalJournalSignals(store, "2026-11-04")).toHaveLength(1);
});
it("cancels without requesting or persisting and rejects duplicate or overlarge batches", async () => {
  const chosen = await select(), request = vi.fn(), controller = new AbortController(); controller.abort();
  await expect(execute([chosen], request, controller)).rejects.toThrow();
  await expect(execute([], request)).rejects.toThrow("1至3"); await expect(execute([chosen, chosen], request)).rejects.toThrow("重复");
  await expect(execute([chosen, chosen, chosen, chosen], request)).rejects.toThrow("1至3"); expect(request).not.toHaveBeenCalled();
});
it("keeps only completed excerpts after interruption and resumes without repeating saved requests", async () => {
  const chosen = [await select(), await select(second, "准备做一个虚构绿纸索引。")]; let calls = 0;
  await expect(execute(chosen, async () => { if (++calls === 2) throw Error("fictional interruption"); return answer(); })).rejects.toThrow("interruption");
  expect(await readExternalJournalSignals(store, "2026-11-04")).toHaveLength(1); const resume = vi.fn(async () => answer("2026-11-05", [{ text: "虚构索引", quote: chosen[1].excerpt }]));
  expect(await execute(chosen, resume)).toMatchObject({ saved: 1, existing: 1 }); expect(resume).toHaveBeenCalledTimes(1);
});
it("bounds format repair and rejects a malformed stored selected-excerpt pin", async () => {
  const request = vi.fn(async () => "not json"); await expect(execute([await select()], request)).rejects.toThrow("暂时无法整理"); expect(request).toHaveBeenCalledTimes(2);
  await execute([await select()], async () => answer()); const rows = await readExternalJournalSignals(store, "2026-11-04");
  expect(validSignalDocument({ version: 1, date: "2026-11-04", 晨: [], 晚: rows }, "2026-11-04")).toBe(true);
  rows[0].sources[0].selectedExcerpt!.text += "伪造"; expect(validSignalDocument({ version: 1, date: "2026-11-04", 晨: [], 晚: rows }, "2026-11-04")).toBe(false);
});

const savedPath = () => join(home, "daily", documentPath(store, "虚构资料", "2026-11-04"));
it("reads exact saved receipts across dates without a new request, task write or original edit", async () => {
  const chosen = [await select(), await select(second, "准备做一个虚构绿纸索引。")], request = vi.fn(async (messages: any) => messages[1].content.includes("11-04") ? answer() : answer("2026-11-05", [{ text: "虚构绿纸索引", quote: chosen[1].excerpt }]));
  await execute(chosen, request); const before = await readFile(savedPath()), tasks = await store.readPath(store.taskDbPath()), raw = await readFile(join(original, first));
  const receipt = await readSelectedJournalResults(store, chosen, () => {}, now);
  expect(receipt.saved).toBe(2); expect(receipt.text).toContain(quote); expect(receipt.text).toContain("2026-11-05"); expect(receipt.text).not.toContain("未选择的虚构旧段"); expect(receipt.text).toContain("尚未创建任务");
  await assertSelectedJournalResultsCurrent(store, receipt, () => {}); expect(request).toHaveBeenCalledTimes(2);
  expect(await readFile(savedPath())).toEqual(before); expect(await store.readPath(store.taskDbPath())).toBe(tasks); expect(await readFile(join(original, first))).toEqual(raw);
});
it("reopens all stored excerpts of the chosen current file, including more than one submission", async () => {
  await execute([await select()], async () => answer()); await execute([await select(first, another)], async () => answer());
  const receipt = await readSavedJournalResults(store, await previewExternalJournal(store, ref(first), now), () => {}, now);
  expect(receipt.saved).toBe(2); expect(receipt.text).toContain("精力：4/5"); expect(receipt.text).toContain("精力四分"); expect(receipt.text).toContain(quote);
  expect(receipt.selections.map(item => item.excerpt)).toEqual([quote, another]);
});
it("labels unsaved excerpts after a partial save and does not infer an empty week", async () => {
  const chosen = [await select(), await select(second, "准备做一个虚构绿纸索引。")]; await execute([chosen[0]], async () => answer());
  const receipt = await readSelectedJournalResults(store, chosen, () => {}, now); expect(receipt.saved).toBe(1); expect(receipt.text).toContain("尚无已保存"); expect(receipt.text).toContain("不代表整篇或整周");
  const empty = await readSavedJournalResults(store, await previewExternalJournal(store, ref(second), now), () => {}, now); expect(empty.saved).toBe(0);
});
it.each(["source", "scope", "derived", "missing"])("refuses a saved receipt before copy after %s changes", async change => {
  const chosen = await select(); await execute([chosen], async () => answer()); const receipt = await readSelectedJournalResults(store, [chosen], () => {}, now);
  if (change === "source") await writeOriginal(first, quote + "改过");
  if (change === "scope") store.settings.externalVaults = [];
  if (change === "derived") { const doc = JSON.parse(await readFile(savedPath(), "utf8")); doc.晚[0].ideas[0].text = "篡改后的虚构解释"; await writeFile(savedPath(), JSON.stringify(doc)); }
  if (change === "missing") await rm(savedPath());
  await expect(assertSelectedJournalResultsCurrent(store, receipt, () => {})).rejects.toThrow();
});
it("rechecks derived quotes and shows literal idea evidence instead of an arbitrary paraphrase", async () => {
  await execute([await select()], async () => answer()); const doc = JSON.parse(await readFile(savedPath(), "utf8"));
  doc.晚[0].plans = [{ text: "源段没有的虚构计划", when: "明天" }]; doc.晚[0].energy = 5; doc.晚[0].quotes = [{ field: "energy", text: another }];
  doc.晚[0].ideas[0].text = "不可信的额外解释"; await writeFile(savedPath(), JSON.stringify(doc));
  const receipt = await readSavedJournalResults(store, await previewExternalJournal(store, ref(first), now), () => {}, now);
  expect(receipt.text).toContain(quote); expect(receipt.text).not.toContain("不可信的额外解释"); expect(receipt.text).not.toContain("源段没有"); expect(receipt.text).not.toContain("精力：");
});
it("does not reopen a stale preview or malformed stored evidence", async () => {
  await execute([await select()], async () => answer()); const preview = await previewExternalJournal(store, ref(first), now);
  await writeOriginal(first, quote + "新内容"); await expect(readSavedJournalResults(store, preview, () => {}, now)).rejects.toThrow("重新预览");
  await writeOriginal(first, preview.text); const doc = JSON.parse(await readFile(savedPath(), "utf8")); doc.晚[0].sources[0].selectedExcerpt.text += "改过"; await writeFile(savedPath(), JSON.stringify(doc));
  await expect(readSavedJournalResults(store, preview, () => {}, now)).rejects.toThrow();
});
it("does not reveal old bulk-extraction records in the selected-excerpt viewer", async () => {
  await execute([await select()], async () => answer()); const doc = JSON.parse(await readFile(savedPath(), "utf8")); delete doc.晚[0].sources[0].selectedExcerpt;
  await writeFile(savedPath(), JSON.stringify(doc)); const receipt = await readSavedJournalResults(store, await previewExternalJournal(store, ref(first), now), () => {}, now); expect(receipt.saved).toBe(0);
});
it("honors cancellation and changes detected while reading a receipt", async () => {
  await execute([await select()], async () => answer()); const chosen = await select(); let calls = 0;
  await expect(readSelectedJournalResults(store, [chosen], () => { if (++calls === 3) store.settings.externalVaults = []; }, now)).rejects.toThrow();
  await expect(readSelectedJournalResults(store, [], () => { throw Error("cancelled"); }, now)).rejects.toThrow("cancelled");
});
