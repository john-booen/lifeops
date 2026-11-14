import type { App } from "obsidian";
import { beforeEach, expect, it, vi } from "vitest";
import type { FactOperationOptions } from "../src/dataFoundation/factOperation";
import type { StoreHost } from "../src/store/settingsSlice";

const notices = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", () => {
  class Element {
    children: Element[] = [];
    style = {};
    textContent = "";
    value = "";
    disabled = false;
    onclick?: () => Promise<void>;
    constructor(readonly tag: string) {}
    empty() { this.children = []; }
    addClass() {}
    createEl(tag: string, options?: { text?: string }) {
      const child = new Element(tag);
      child.textContent = options?.text ?? "";
      this.children.push(child);
      return child;
    }
  }
  return {
    Modal: class {
      contentEl = new Element("div");
      setTitle() {}
      close() { (this as unknown as { onClose(): void }).onClose(); }
    },
    Notice: class { constructor(message: string) { notices.push(message); } },
    normalizePath: (path: string) => path
  };
});

const { HealthCsvImportModal } = await import("../src/features/health/csvImportModal");
type Element = { tag: string; value: string; textContent: string; onclick(): Promise<void>; children: Element[] };
const valid = "date,sleepHours,steps\n2026-05-25,7.5,8000";

function fixture() {
  const write = vi.fn(async () => {});
  const refreshViews = vi.fn(async () => {});
  const store = {
    settings: { folders: { health: "Health" } },
    path: (...parts: string[]) => parts.join("/"),
    getFile: (path: string) => write.mock.calls.length ? { path } : null,
    readPath: async () => "- 睡眠小时：7.5\n- 步数：8000",
    app: { vault: { adapter: { read: async () => "- 睡眠小时：7.5\n- 步数：8000" } } },
    appendHealthEntry: write
  } as unknown as StoreHost;
  let activeStore = store;
  const save = vi.fn(async (_name: string, _args: Record<string, unknown>, action: (scope: StoreHost) => Promise<unknown>,
    options?: FactOperationOptions) => { options?.assertCurrent?.(); await action(activeStore); });
  const modal = new HealthCsvImportModal({ app: {} as App, store: () => activeStore, register: vi.fn(), refreshViews, saveLocalOperation: save });
  modal.onOpen();
  const children = () => (modal.contentEl as unknown as Element).children;
  const fill = (text: string) => { children().find(el => el.tag === "textarea")!.value = text; };
  const button = (name: string) => children().find(el => el.tag === "button" && el.textContent === name)!;
  return { modal, write, save, fill, button, children, store, replaceStore: (replacement: StoreHost) => { activeStore = replacement; } };
}

beforeEach(() => { notices.length = 0; });

it("requires a separately confirmed preview and preserves the input when returning to edit", async () => {
  const { save, write, fill, button, children } = fixture();
  fill(valid);
  await button("核对导入内容").onclick();
  expect(save).not.toHaveBeenCalled();
  expect(children().find(el => el.tag === "ul")?.children[0].textContent).toContain("睡眠小时 7.5 小时 · 步数 8000 步");
  const stale = button("确认导入 1 条");
  await button("返回修改").onclick();
  await stale.onclick();
  expect(save).not.toHaveBeenCalled();
  expect(children().find(el => el.tag === "textarea")?.value).toBe(valid);
  await button("核对导入内容").onclick();
  await button("确认导入 1 条").onclick();
  expect(save).toHaveBeenCalledOnce();
  expect(save.mock.calls[0][0]).toBe("manual_health_csv_batch");
  expect(write).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ date: "2026-05-25", sleepHours: 7.5, steps: 8000 }));
});

it("keeps invalid rows on the editable form without saving", async () => {
  const { save, fill, button, children } = fixture();
  fill("date,sleepHours\n2026-05-25,25");
  await button("核对导入内容").onclick();
  expect(save).not.toHaveBeenCalled();
  expect(children().some(el => el.tag === "textarea")).toBe(true);
  expect(notices[0]).toContain("第 1 条健康记录");
});

it.each(["store", "folder"] as const)("requires a fresh health CSV preview after the destination %s changes", async (changed) => {
  const { save, fill, write, button, store, replaceStore } = fixture();
  fill(valid);
  await button("核对导入内容").onclick();
  if (changed === "store") replaceStore({ ...store });
  else store.settings.folders.health = "虚构新健康目录";
  await button("确认导入 1 条").onclick();
  expect(save).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(notices.at(-1)).toContain("重新核对");
  await button("返回修改").onclick();
  await button("核对导入内容").onclick();
  await button("确认导入 1 条").onclick();
  expect(write).toHaveBeenCalledOnce();
});
