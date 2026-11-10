import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";
import type { App } from "obsidian";
const test = vi.hoisted(() => ({ notices: [] as string[], fields: [] as any[] }));
vi.mock("obsidian", () => {
  const element = (tag = "div", info: any = {}): any => { const result = { tag, info, value: info.attr?.value ?? "", disabled: false, onclick: undefined as any, addClass: vi.fn(), empty: vi.fn(), createDiv: (info?: any) => element("div", info), createEl: (tag: string, info?: any) => element(tag, info) }; test.fields.push(result); return result; };
  return { Modal: class { contentEl = element(); constructor(public app: any) {} close() { (this as any).onClose(); } }, Notice: class { constructor(message: string) { test.notices.push(message); } } };
});
const { WeeklyReviewPickerModal } = await import("../src/weeklyReviewPicker");
let store: StoreHost, app: App, hostLive: boolean;
const original = "Notes/2026-10-01.md", generated = "LifeOps/Output/AI/周回顾/2026-10-01.md", excluded = "Notes/纯虚构排除.md";
const fields = (tag: string) => test.fields.filter(f => f.tag === tag), button = (text: string) => fields("button").find(f => f.info.text === text);
function open(prepare = vi.fn(async (_message: string, current: () => void) => { current(); })) {
  const closed = vi.fn(), modal = new WeeklyReviewPickerModal(app, store, prepare, () => { if (!hostLive) throw Error("Fiction host stopped"); }, closed); modal.onOpen(); fields("input")[0].value = "2026-10-01"; fields("input")[1].value = "2026-10-07"; return { modal, prepare, closed };
}
beforeEach(() => { test.notices.length = 0; test.fields.length = 0; hostLive = true;
  app = { vault: { getMarkdownFiles: () => [original, generated, excluded].map(path => ({ path })) }, workspace: { getActiveFile: () => ({ path: original }) } } as unknown as App;
  store = { settings: { ...structuredClone(DEFAULT_SETTINGS), privacy: { excludedVaultPrefixes: [excluded] } }, isManagedSourcePath: () => true, getFile: (path: string) => ({ path }) } as unknown as StoreHost;
});
afterEach(() => vi.restoreAllMocks());
describe("weekly picker prepares a human-readable request without saving or sending it", () => {
  it("filters generated/excluded notes and waits for the user's separate send", async () => {
    const { prepare, closed } = open(); const options = fields("option").map(f => f.info.attr?.value); expect(options).toContain(original); expect(options).not.toContain(generated); expect(options).not.toContain(excluded);
    await button("放入对话，核对后发送").onclick(); expect(prepare).toHaveBeenCalledTimes(1); const message = prepare.mock.calls[0][0]; expect(message).toContain(original); expect(message).toContain("不确认记忆或完成任务"); expect(message).not.toContain("inspect_weekly_review_sources"); expect(closed).toHaveBeenCalledTimes(1);
  });
  it("limits source rows and refuses duplicate paths", async () => {
    const { prepare } = open(); for (let i = 0; i < 8; i++) button("再选一篇").onclick(); expect(fields("select")).toHaveLength(6); fields("select")[1].value = original;
    await button("放入对话，核对后发送").onclick(); expect(prepare).not.toHaveBeenCalled(); expect(test.notices.at(-1)).toContain("不重复");
  });
  it("refuses invalid periods and newly excluded originals before composing", async () => {
    const { prepare } = open(); fields("input")[1].value = "2026-10-08"; await button("放入对话，核对后发送").onclick(); expect(prepare).not.toHaveBeenCalled();
    fields("input")[1].value = "2026-10-07"; store.settings.privacy!.excludedVaultPrefixes = [original]; await button("放入对话，核对后发送").onclick(); expect(prepare).not.toHaveBeenCalled();
  });
  it("prevents late button reuse after closing", async () => {
    const { prepare, modal } = open(), old = button("放入对话，核对后发送"); modal.close(); await old.onclick(); expect(prepare).not.toHaveBeenCalled();
  });
  it("keeps close/host guards inside pending composer navigation", async () => {
    let release!: () => void; const wait = new Promise<void>(done => { release = done; }), compose = vi.fn();
    const prepare = vi.fn(async (_message: string, current: () => void) => { await wait; current(); compose(); }), { modal } = open(prepare);
    const pending = button("放入对话，核对后发送").onclick(); modal.close(); release(); await pending; expect(compose).not.toHaveBeenCalled();
  });
});
