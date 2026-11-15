import type { App } from "obsidian";
import { beforeEach, expect, it, vi } from "vitest";
import type { FactOperationOptions } from "../src/dataFoundation/factOperation";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";

const notices = vi.hoisted(() => [] as string[]);
const windowState = vi.hoisted(() => ({ content: undefined as unknown }));
vi.mock("obsidian", () => {
  class Element {
    children: Element[] = [];
    style = {};
    textContent = "";
    value = "";
    disabled = false;
    checked = false;
    validity = { badInput: false };
    get valueAsNumber() { return Number(this.value); }
    onclick?: () => Promise<void>;
    constructor(readonly tag: string) {}
    empty() { this.children = []; }
    addClass() {}
    setText(text: string) { this.textContent = text; }
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
      open() { windowState.content = this.contentEl; (this as unknown as { onOpen(): void }).onOpen(); }
      close() { (this as unknown as { onClose(): void }).onClose(); }
    },
    Setting: class {
      constructor(private readonly host: Element) {}
      addButton(configure: (button: unknown) => void) {
        const buttonEl = this.host.createEl("button");
        const button = {
          buttonEl,
          setButtonText(text: string) { buttonEl.textContent = text; return button; },
          setDisabled(disabled: boolean) { buttonEl.disabled = disabled; return button; },
          setCta() { return button; },
          onClick(action: () => Promise<void>) { buttonEl.onclick = action; return button; }
        };
        configure(button);
        return this;
      }
    },
    Notice: class { constructor(message: string) { notices.push(message); } },
    normalizePath: (path: string) => path
  };
});

const { HealthCsvImportModal } = await import("../src/features/health/csvImportModal");
const { openHealthScreenshot } = await import("../src/features/health/modal");
type Element = { tag: string; value: string; textContent: string; onclick(): Promise<void>; onchange(): void; children: Element[];
  files?: Array<{ path: string; size: number; arrayBuffer(): Promise<ArrayBuffer> }> };
const valid = "date,sleepHours,steps\n2026-05-25,7.5,8000";

function fixture() {
  const write = vi.fn(async () => {});
  const refreshViews = vi.fn(async () => {});
  const store = {
    settings: { folders: { health: "Health" } },
    path: (...parts: string[]) => parts.join("/"),
    getFile: (path: string) => write.mock.calls.length ? { path } : null,
    readPath: async () => "- 睡眠小时：7.5\n- 步数：8000",
    app: { vault: { adapter: { getBasePath: () => process.cwd(), read: async () => "- 睡眠小时：7.5\n- 步数：8000" } } },
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

it.each(["location", "permission"] as const)("rechecks health CSV %s inside the queued confirmation", async changed => {
  const { save, fill, write, button, store, replaceStore } = fixture();
  save.mockImplementationOnce(async (_name, _args, action, options) => {
    const scope = { ...store, settings: structuredClone(store.settings) };
    if (changed === "location") replaceStore({ ...store });
    else store.settings.privacy = { excludedVaultPrefixes: ["Health/2026-05-25.md"] };
    options?.assertCurrent?.();
    await action(scope);
  });
  fill(valid);
  await button("核对导入内容").onclick();
  await button("确认导入 1 条").onclick();
  expect(save).toHaveBeenCalledOnce();
  expect(write).not.toHaveBeenCalled();
  expect(notices.at(-1)).toContain(changed === "location" ? "重新核对" : "已排除");
});

it.each([
  [false, "location"], [true, "location"], [false, "permission"], [true, "permission"]
] as const)("keeps a health screenshot in scope (queued: %s, change: %s)", async (queued, changed) => {
  const { store, save, write } = fixture();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.privacy!.plaintextCredentialStorageAccepted = true;
  settings.vision = { ...settings.vision, provider: "openai-compatible", endpoint: "https://fiction.invalid/v1/chat/completions",
    apiKey: "fixture-health-token", model: "fixture-health-model", healthScreenshotDisclosureAccepted: true };
  openHealthScreenshot({ app: {} as App, store, settings, register: vi.fn(), refreshViews: async () => {}, saveLocalOperation: save,
    recognizeHealthScreenshot: async () => [{ date: "2026-05-25", steps: 8000 }] });
  const content = windowState.content as Element;
  const field = content.children.find(el => el.tag === "input")!;
  const png = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  field.files = [{ path: import.meta.filename, size: png.length, arrayBuffer: async () => png.buffer }];
  field.onchange();
  await content.children.find(el => el.textContent === "发送并识别")!.onclick();
  const confirm = content.children.find(el => el.textContent === "确认并保存")!;
  const changeScope = () => {
    if (changed === "location") store.settings.folders.health = "虚构扫描期间新目录";
    else store.settings.privacy = { excludedVaultPrefixes: ["Health/2026-05-25.md"] };
  };
  if (queued) {
    save.mockImplementationOnce(async (_name, _args, action, options) => {
      const scope = { ...store, settings: structuredClone(store.settings) };
      changeScope();
      options?.assertCurrent?.();
      await action(scope);
    });
  } else changeScope();
  await confirm.onclick();
  expect(save).toHaveBeenCalledTimes(queued ? 1 : 0);
  expect(write).not.toHaveBeenCalled();
  const message = changed === "location" ? "重新选图" : "已排除";
  expect(content.children.some(el => el.textContent.includes(message))).toBe(true);
});
