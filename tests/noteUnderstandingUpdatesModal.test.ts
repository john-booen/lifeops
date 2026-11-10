import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { StoreHost } from "../src/store/settingsSlice";
const test = vi.hoisted(() => ({ fields: [] as any[], list: vi.fn(), prepare: vi.fn() }));
vi.mock("../src/noteUnderstandingUpdates", () => ({ listUnderstandingUpdates: test.list, prepareUnderstandingUpdate: test.prepare }));
vi.mock("obsidian", () => {
  function element(tag = "div", info: any = {}): any { const value: any = { tag, textContent: info.text ?? "", disabled: false, onclick: undefined, empty: vi.fn(), addClass: vi.fn(), setText(text: string) { value.textContent = text; }, createEl: (tag: string, info?: any) => element(tag, info), createDiv: (info?: any) => element("div", info), querySelectorAll: (tag: string) => test.fields.filter(f => f.tag === tag) }; test.fields.push(value); return value; }
  return { Modal: class { contentEl = element(); constructor(public app: unknown) {} close() { (this as any).onClose(); } } };
});
const { NoteUnderstandingUpdatesModal } = await import("../src/noteUnderstandingUpdatesModal");
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0)), buttons = () => test.fields.filter(f => f.tag === "button"), find = (text: string) => buttons().find(f => f.textContent === text);
const row = { token: "fiction", path: "Notes/fiction.md", status: "needs_review", versions: 1 };
function open(compose = vi.fn(async (_message: string, current: () => void) => current())) { const closed = vi.fn(), modal = new NoteUnderstandingUpdatesModal({} as App, {} as StoreHost, compose, () => {}, closed); modal.onOpen(); return { modal, closed, compose }; }
beforeEach(() => { test.fields.length = 0; test.list.mockReset().mockResolvedValue({ rows: [row], remainingSources: 0 }); test.prepare.mockReset().mockImplementation(async (_row: any, context: any, compose: any) => { context.assertCurrent(); await compose("请重新核对纯虚构原文", context.assertCurrent); context.assertCurrent(); }); });
describe("understanding update window has a separate send and stoppable preparation", () => {
  it("only offers a compose action for a changed or new original", async () => {
    test.list.mockResolvedValue({ rows: [row, { ...row, path: "Notes/current.md", status: "current_candidate" }, { ...row, path: "Notes/missing.md", status: "missing" }], remainingSources: 2 }); const { compose, closed } = open(); await tick(); expect(buttons().filter(b => b.textContent === "放入对话，核对后发送")).toHaveLength(1);
    await find("放入对话，核对后发送").onclick(); expect(compose).toHaveBeenCalledTimes(1); expect(closed).toHaveBeenCalledTimes(1); expect(test.fields.some(f => f.textContent.includes("已有当前版本候选"))).toBe(true);
  });
  it("allows closing immediately while the local status read is still pending", async () => {
    let release!: (value: any) => void; test.list.mockImplementation(() => new Promise(resolve => { release = resolve; })); const { closed } = open(); await find("关闭").onclick(); release({ rows: [row], remainingSources: 0 }); await tick(); expect(closed).toHaveBeenCalledTimes(1); expect(find("放入对话，核对后发送")).toBeUndefined(); expect(test.prepare).not.toHaveBeenCalled();
  });
  it("keeps close usable while composer navigation waits and rejects the late insertion", async () => {
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }), inserted = vi.fn(); const compose = vi.fn(async (_message: string, current: () => void) => { await wait; current(); inserted(); }); const { closed } = open(compose); await tick(); const pending = find("放入对话，核对后发送").onclick(); expect(find("关闭").disabled).toBe(false); find("关闭").onclick(); release(); await pending; expect(inserted).not.toHaveBeenCalled(); expect(closed).toHaveBeenCalledTimes(1);
  });
  it("does not reuse an old row after refresh", async () => {
    open(); await tick(); const old = find("放入对话，核对后发送"); find("刷新状态").onclick(); await tick(); await old.onclick(); expect(test.prepare).not.toHaveBeenCalled();
  });
});
