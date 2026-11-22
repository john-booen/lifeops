import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SummaryEvidenceHost } from "../src/features/summaries/evidenceUi";
import type { SummaryEvidence } from "../src/features/summaries/evidence";
const fake = vi.hoisted(() => ({ fields: [] as any[], read: vi.fn(), allowed: vi.fn() }));
vi.mock("obsidian", () => {
  const element = (tag = "div", info: any = {}): any => {
    const node = { tag, info, children: [] as any[], text: info.text ?? "", disabled: false, onclick: undefined as any,
      addClass() {}, empty() { this.children = []; this.text = ""; }, setText(text: string) { this.text = text; },
      createEl(tag: string, info?: any) { const child = element(tag, info); this.children.push(child); return child; },
      createDiv(info?: any) { return this.createEl("div", info); } };
    fake.fields.push(node); return node;
  };
  return { Modal: class { contentEl = element(); constructor(public app: unknown) {} open() { (this as any).onOpen(); } close() { (this as any).onClose(); } } };
});
vi.mock("../src/features/summaries/evidence", () => ({ readSummaryEvidence: fake.read, summaryEvidencePathAllowed: fake.allowed }));
const { SummaryEvidenceModal, registerSummaryEvidenceUi } = await import("../src/features/summaries/evidenceUi");
let host: SummaryEvidenceHost, data: SummaryEvidence, opens: ReturnType<typeof vi.fn>, cleanups: (() => void)[];
const report = "Allowed/摘要/周/2026-W45.md", source = "Allowed/2026-11-03早.md";
const last = (tag: string, text?: string) => [...fake.fields].reverse().find(field => field.tag === tag && (text === undefined || field.info.text === text));
const flush = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };
const open = async () => { const modal = new SummaryEvidenceModal(host, report); cleanups.push(() => modal.close()); modal.onOpen(); await flush(); return modal; };
beforeEach(() => {
  vi.useFakeTimers(); fake.fields.length = 0; fake.read.mockReset(); fake.allowed.mockReset().mockImplementation((_store, path) => path.startsWith("Allowed/"));
  cleanups = []; opens = vi.fn(async () => {});
  host = { app: { workspace: { getLeaf: () => ({ openFile: opens }), getActiveFile: () => ({ path: report }), on: vi.fn() } } as never,
    store: {} as never, unloaded: false, register: callback => cleanups.push(callback), registerEvent: vi.fn(), addCommand: vi.fn() };
  data = { path: report, period: { level: "week", key: "2026-W45", from: "2026-11-02", to: "2026-11-08" }, through: "2026-11-08",
    generatedBy: "model", edited: false, savedInputCount: 7, sourceScopeCurrent: true,
    days: [{ date: "2026-11-03", files: 2, notes: [{ date: "2026-11-03", path: source }] }],
    journalFiles: 2, journalDays: 1, omittedFiles: 0, children: [], assertDisplayCurrent: vi.fn(), assertCurrent: vi.fn(async () => {}),
    fileFor: vi.fn(async path => ({ path }) as never) };
  fake.read.mockResolvedValue(data);
});
afterEach(() => { cleanups.forEach(close => close()); vi.useRealTimers(); vi.restoreAllMocks(); });

it("opens the selected original rather than treating two diary files as two days", async () => {
  const modal = await open();
  expect(fake.fields.some(field => field.text.includes("找到日记2篇，分布在1天"))).toBe(true);
  const button = fake.fields.find(field => field.info.attr?.["data-source-path"] === source);
  await button.onclick();
  expect(data.fileFor).toHaveBeenCalledWith(source); expect(opens).toHaveBeenCalledWith({ path: source }, { state: { mode: "preview" } });
  expect(modal.contentEl.children).toEqual([]); expect(vi.getTimerCount()).toBe(0);
});

it("drops a pending local read after the viewer closes", async () => {
  let release!: (value: SummaryEvidence) => void; fake.read.mockReturnValue(new Promise(done => { release = done; }));
  const modal = await open(), options = fake.read.mock.calls[0][2]; modal.close(); release(data); await flush();
  expect(options.signal.aborted).toBe(true); expect(fake.fields.some(field => field.tag === "table")).toBe(false);
  expect(opens).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it.each(["store", "unload"])("does not display a pending read after host %s changes", async change => {
  let release!: (value: SummaryEvidence) => void; fake.read.mockReturnValue(new Promise(done => { release = done; }));
  await open(); if (change === "store") host.store = {} as never; else host.unloaded = true;
  release(data); await flush(); expect(fake.fields.some(field => field.tag === "table")).toBe(false);
  expect(opens).not.toHaveBeenCalled();
});

it("clears stale filenames and refuses a retained old button after invalidation", async () => {
  await open(); const body = last("div");
  const old = fake.fields.find(field => field.info.attr?.["data-source-path"] === source);
  vi.mocked(data.assertDisplayCurrent).mockImplementation(() => { throw Error("fictional privacy change"); });
  await vi.advanceTimersByTimeAsync(500); expect(body.children).toEqual([]);
  await old.onclick(); expect(data.fileFor).not.toHaveBeenCalled(); expect(opens).not.toHaveBeenCalled();
  expect(fake.fields.find(field => field.info.attr?.role === "status").text).toContain("刷新");
});

it("does not let an older failed source-opening request erase a newly refreshed view", async () => {
  let reject!: (error: Error) => void; vi.mocked(data.fileFor).mockReturnValue(new Promise((_done, fail) => { reject = fail; }));
  await open(); const button = fake.fields.find(field => field.info.attr?.["data-source-path"] === source), pending = button.onclick();
  const replacement = { ...data, journalFiles: 3 }; fake.read.mockResolvedValue(replacement);
  last("button", "刷新依据").onclick(); await flush(); const body = last("div");
  reject(Error("fictional stale source")); await pending;
  expect(body.children.length).toBeGreaterThan(0); expect(opens).not.toHaveBeenCalled();
});

it("offers the command and file menu only for allowed summaries, and refuses a late menu action", async () => {
  registerSummaryEvidenceUi(host);
  const command = vi.mocked(host.addCommand).mock.calls[0][0]; expect(command.checkCallback?.(true)).toBe(true);
  fake.allowed.mockReturnValue(false); expect(command.checkCallback?.(false)).toBe(false); expect(fake.read).not.toHaveBeenCalled();
  fake.allowed.mockReturnValue(true);
  const handler = vi.mocked(host.app.workspace.on).mock.calls[0][1] as (...args: any[]) => void;
  let click!: () => void;
  const item = { setTitle() { return item; }, setIcon() { return item; }, onClick(callback: () => void) { click = callback; return item; } };
  handler({ addItem(callback: (item: any) => void) { callback(item); } }, { path: report });
  host.unloaded = true; click(); await flush(); expect(fake.read).not.toHaveBeenCalled();
});

it("adds one header action per summary view and removes it when the view changes or unloads", () => {
  const action = { setAttribute: vi.fn(), remove: vi.fn() }, addAction = vi.fn(() => action);
  const view = { file: { path: report }, addAction };
  host.app.workspace.getLeavesOfType = vi.fn(() => [{ view }] as never);
  registerSummaryEvidenceUi(host); expect(addAction).toHaveBeenCalledTimes(1);
  const events = vi.mocked(host.app.workspace.on).mock.calls as unknown as [string, () => void][];
  const refresh = events.find(([event]) => event === "layout-change")![1];
  refresh(); expect(addAction).toHaveBeenCalledTimes(1);
  fake.allowed.mockReturnValue(false); refresh(); expect(action.remove).toHaveBeenCalledTimes(1);
  fake.allowed.mockReturnValue(true); refresh(); expect(addAction).toHaveBeenCalledTimes(2);
  host.unloaded = true; refresh(); expect(action.remove).toHaveBeenCalledTimes(2);
});
