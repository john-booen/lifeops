import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";

vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, TFolder: class {}, Modal: class {}, Notice: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/"), parseYaml: JSON.parse, stringifyYaml: JSON.stringify }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const { readSummaryEvidence, SUMMARY_EVIDENCE_FILE_LIMIT } = await import("../src/features/summaries/evidence");
const { readSummaryScope, renderSummary, summaryPath } = await import("../src/features/summaries/notes");
const { summaryPeriod } = await import("../src/features/summaries/periods");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost;
const now = new Date("2026-11-22T16:00:00+08:00");
const metrics = { taskCompletionPercent: null, tasksCompleted: 0, energy: null, tradePnlCny: null, tradePnlUsd: null };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-summary-evidence-")); vault = new DiskVault(root);
  store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const diary = (date: string, suffix = "早") => store.path(store.settings.folders.dailyRoot, date.slice(0, 4), date.slice(5, 7), date + suffix + ".md");
async function report(level: "day" | "week" | "month" = "week", date = "2026-11-03", through?: string) {
  const period = summaryPeriod(level, date), path = summaryPath(store, period), scope = await readSummaryScope(store);
  await vault.seed(path, renderSummary(period, through ?? period.to, scope.hash, metrics, level === "week" ? 7 : 0,
    !through || through === period.to, "model", "虚构旧摘要，其正文不是原始事实证明。"));
  return path;
}
async function bytes() {
  const paths = await readdir(root, { recursive: true, withFileTypes: true });
  const result = await Promise.all(paths.filter(file => file.isFile()).map(async file => {
    const path = join(file.parentPath, file.name); return [path.slice(root.length), (await readFile(path)).toString("base64")];
  }));
  return result.sort(([a], [b]) => String(a).localeCompare(String(b)));
}

it("distinguishes dated originals from child summaries without reading diary bodies or rewriting files", async () => {
  const path = await report(), child = await report("day", "2026-11-03");
  await vault.seed(child, (await vault.bytes(child)) + "\n虚构手写补充。\n");
  for (const [date, suffix] of [["2026-11-03", "早"], ["2026-11-03", "晚"], ["2026-11-05", "晚"]]) await vault.seed(diary(date, suffix), "虚构私密原话，不应进入查看目录。");
  const before = await bytes(), read = vi.spyOn(store, "readPath");
  const view = await readSummaryEvidence(store, path, { now });
  expect(view.period).toMatchObject({ from: "2026-11-02", to: "2026-11-08", level: "week" });
  expect(view.days).toHaveLength(7); expect(view.journalFiles).toBe(3); expect(view.journalDays).toBe(2);
  expect(view.days.find(row => row.date === "2026-11-03")).toMatchObject({ files: 2, notes: expect.any(Array) });
  expect(view.days.filter(row => !row.files)).toHaveLength(5); expect(view.savedInputCount).toBe(7);
  expect(view.children).toEqual([expect.objectContaining({ path: child, generatedBy: "model", edited: true })]);
  expect(view.sourceScopeCurrent).toBe(true); expect(view.edited).toBe(false);
  expect(JSON.stringify(view)).not.toContain("虚构私密原话"); expect(JSON.stringify(view)).not.toContain("虚构旧摘要");
  expect(read.mock.calls.some(([source]) => String(source).startsWith(store.settings.folders.dailyRoot + "/"))).toBe(false);
  expect(await bytes()).toEqual(before);
});

it("stops at the saved report cutoff instead of classifying later dates as missing", async () => {
  const path = await report("week", "2026-11-03", "2026-11-04");
  await vault.seed(diary("2026-11-03"), "虚构范围内。"); await vault.seed(diary("2026-11-05"), "虚构截止后，不能列入。");
  const view = await readSummaryEvidence(store, path, { now });
  expect(view.through).toBe("2026-11-04"); expect(view.days.map(row => row.date)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04"]);
  expect(view.journalDays).toBe(1); expect(JSON.stringify(view.days)).not.toContain("2026-11-05");
});

it("keeps cross-month child weeks separate from originals inside the month", async () => {
  const path = await report("month", "2026-02-01"), child = await report("week", "2026-01-26");
  await vault.seed(diary("2026-01-31"), "虚构上月。"); await vault.seed(diary("2026-02-01"), "虚构本月。");
  await vault.seed(diary("2026-03-01"), "虚构下月。");
  const view = await readSummaryEvidence(store, path, { now });
  expect(view.days).toHaveLength(28); expect(view.journalFiles).toBe(1);
  expect(view.children[0]).toMatchObject({ path: child, period: { from: "2026-01-26", to: "2026-02-01" } });
  expect(view.days.flatMap(row => row.notes).map(row => row.date)).toEqual(["2026-02-01"]);
});

it.each(["excluded", "unmanaged", "configuration"])("does not disclose %s originals", async kind => {
  let excluded = diary("2026-11-03");
  if (kind === "unmanaged") excluded = "Unmanaged/2026-11-03.md";
  if (kind === "configuration") { store.settings.folders.dailyRoot = ".obsidian"; excluded = ".obsidian/2026-11-03.md"; }
  await vault.seed(excluded, "虚构不可展示原文。");
  if (kind === "excluded") store.settings.privacy = { ...store.settings.privacy, excludedVaultPrefixes: [excluded] };
  const path = await report(), view = await readSummaryEvidence(store, path, { now });
  expect(view.journalFiles).toBe(0); expect(view.journalDays).toBe(0);
  expect(JSON.stringify(view.days)).not.toContain(excluded); expect(view.days.every(row => row.notes.length === 0)).toBe(true);
});

it("labels an older report scope as unverified while retaining its current allowed diary links", async () => {
  const path = await report(), source = diary("2026-11-03"); await vault.seed(source, "虚构当前允许原文。");
  store.settings.privacy = { ...store.settings.privacy, excludedVaultPrefixes: ["虚构新排除目录"] };
  const view = await readSummaryEvidence(store, path, { now });
  expect(view.sourceScopeCurrent).toBe(false); expect(view.edited).toBe(null); expect(view.journalFiles).toBe(1);
  expect((await view.fileFor(source)).path).toBe(source);
});

it.each(["outside", "wrong-path", "invalid-date", "future-cutoff", "malformed-header"])("rejects a forged or unavailable report: %s", async mode => {
  const path = await report(); let selected = path;
  if (mode === "outside") { selected = "Unmanaged/虚构摘要.md"; await vault.seed(selected, await vault.bytes(path)); }
  if (mode === "wrong-path") { selected = path.replace("2026-W45", "2026-W46"); await vault.seed(selected, await vault.bytes(path)); }
  if (mode === "invalid-date") await vault.seed(path, (await vault.bytes(path)).replaceAll("2026-11-02", "2026-02-30"));
  if (mode === "future-cutoff") await vault.seed(path, (await vault.bytes(path)).replaceAll("2026-11-08", "2027-11-08"));
  if (mode === "malformed-header") await vault.seed(path, "---\ninvalid { fictional header\n---\n未作事实证明。\n");
  await expect(readSummaryEvidence(store, selected, { now })).rejects.toThrow();
});

it("rejects a scope change during an asynchronous report read", async () => {
  const path = await report(), original = store.readPath.bind(store);
  vi.spyOn(store, "readPath").mockImplementationOnce(async selected => {
    const raw = await original(selected); store.settings.privacy = { ...store.settings.privacy, excludedVaultPrefixes: [path] }; return raw;
  });
  await expect(readSummaryEvidence(store, path, { now })).rejects.toThrow(/范围.*变化/);
});

it.each(["before", "during"])("honors cancellation %s collecting sources", async phase => {
  const path = await report(), controller = new AbortController();
  if (phase === "before") controller.abort();
  else { const original = store.readPath.bind(store); vi.spyOn(store, "readPath").mockImplementationOnce(async selected => {
    const raw = await original(selected); controller.abort(); return raw;
  }); }
  await expect(readSummaryEvidence(store, path, { now, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
});

it.each(["report", "new-diary", "privacy"])("invalidates an open snapshot after %s changes", async change => {
  const path = await report(), view = await readSummaryEvidence(store, path, { now });
  if (change === "report") await vault.seed(path, (await vault.bytes(path)) + "\n虚构后改正文。\n");
  if (change === "new-diary") await vault.seed(diary("2026-11-05"), "虚构后来新增。");
  if (change === "privacy") store.settings.privacy = { ...store.settings.privacy, excludedVaultPrefixes: [path] };
  await expect(view.assertCurrent()).rejects.toThrow(/变化|保存/);
});

it("does not open a managed file outside the displayed source set", async () => {
  const path = await report(), outside = diary("2026-11-15"); await vault.seed(outside, "虚构其他周原文。");
  const view = await readSummaryEvidence(store, path, { now });
  await expect(view.fileFor(outside)).rejects.toThrow(/本次/); expect((await view.fileFor(path)).path).toBe(path);
});

it("limits displayed links while counting all allowed files and dates", async () => {
  const path = await report();
  for (let index = 0; index < SUMMARY_EVIDENCE_FILE_LIMIT + 3; index++) await vault.seed(diary("2026-11-03", "晚-" + index), "虚构未读取正文。");
  const view = await readSummaryEvidence(store, path, { now });
  expect(view.journalFiles).toBe(203); expect(view.journalDays).toBe(1); expect(view.omittedFiles).toBe(3);
  expect(view.days.flatMap(row => row.notes)).toHaveLength(200); expect(view.days.find(row => row.date === "2026-11-03")?.files).toBe(203);
});
