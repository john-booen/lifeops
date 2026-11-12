import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { providerDisclosureRequired } from "../src/privacy";

const rendered = vi.hoisted(() => ({ rows: [] as Array<{ name?: string; description?: string; buttons: string[]; value?: unknown; checked?: string; change?: (value: string) => Promise<void> }>, text: [] as string[] }));
vi.mock("obsidian", () => {
  class Element {
    empty() {}
    createEl(_tag: string, options?: { text?: string }) { if (options?.text) rendered.text.push(options.text); return new Element(); }
    createDiv() { return new Element(); }
  }
  class Setting {
    row: typeof rendered.rows[number] = { name: "", description: "", buttons: [] };
    constructor(_el: unknown) { rendered.rows.push(this.row); }
    setName(value: string) { this.row.name = value; return this; }
    setDesc(value: string) { this.row.description = value; return this; }
    control(callback: (value: any) => unknown) {
      const control: any = new Proxy({
        inputEl: { addEventListener() {} },
        toggleEl: { setAttribute: (name: string, value: string) => { if (name === "aria-checked") this.row.checked = value; } }
      }, { get: (target, key) => {
        if (key === "inputEl" || key === "toggleEl") return target[key];
        return (...args: unknown[]) => {
          if (key === "setButtonText") this.row.buttons.push(String(args[0]));
          if (key === "setValue") this.row.value = args[0];
          if (key === "onChange") this.row.change = args[0] as typeof this.row.change;
          return control;
        };
      } });
      callback(control); return this;
    }
    addText(callback: (value: any) => unknown) { return this.control(callback); }
    addTextArea(callback: (value: any) => unknown) { return this.control(callback); }
    addDropdown(callback: (value: any) => unknown) { return this.control(callback); }
    addToggle(callback: (value: any) => unknown) { return this.control(callback); }
    addButton(callback: (value: any) => unknown) { return this.control(callback); }
    addSlider(callback: (value: any) => unknown) { return this.control(callback); }
  }
  return {
    App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {}, Modal: class {},
    PluginSettingTab: class { containerEl = new Element(); }, Setting, Platform: { isDesktopApp: true }, Notice: class {},
    normalizePath: (path: string) => path.replace(/\\/g, "/"), setIcon: vi.fn(), requestUrl: vi.fn()
  };
});
const { default: LifeOpsPlugin } = await import("../src/main");
const { LifeOpsAi } = await import("../src/ai");
const { LifeOpsSettingTab } = await import("../src/settingsTab");
const { requestUrl } = await import("obsidian");

beforeEach(() => { rendered.rows.length = 0; rendered.text.length = 0; vi.clearAllMocks(); });
afterEach(() => vi.restoreAllMocks());

describe("cancelled file-video capability", () => {
  it("has no callable selected-video entry even when legacy vision settings remain authorized", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    Object.assign(settings.vision, { provider: "qwen-vl", remoteDataDisclosureAccepted: true, apiKey: "synthetic-key" });
    const plugin = Object.assign(Object.create(LifeOpsPlugin.prototype), { settings });
    const ai = new LifeOpsAi(settings);
    expect(plugin.openVideoAnalysis).toBeUndefined();
    expect(plugin.analyzeVideoSamples).toBeUndefined();
    expect((ai as any).analyzeVideoSamples).toBeUndefined();
    expect(plugin.analyzeVisionSnapshot).toBeUndefined();
    expect(plugin.analyzeCapturedScreen).toBeUndefined();
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it("renders retained sensor settings without a file selector or cancelled video disclosure", () => {
    const settings = structuredClone(DEFAULT_SETTINGS), original = structuredClone(settings), saveSettings = vi.fn();
    new LifeOpsSettingTab({ app: {}, settings, saveSettings } as any).display();
    const text = JSON.stringify(rendered);
    expect(text).not.toMatch(/短视频|视频文件|采样图与问题|选择片段并预览/);
    expect(rendered.rows.some(row => row.name === "摄像头用途")).toBe(false);
    expect(rendered.text).toContain("实时语音对话");
    expect(settings).toEqual(original);
    expect(saveSettings).not.toHaveBeenCalled();
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it("discloses retained camera and screenshot data without authorizing cancelled clip samples", () => {
    const text = providerDisclosureRequired("vision");
    expect(text).toContain("摄像头画面");
    expect(text).toContain("完整屏幕截图");
    expect(text).not.toMatch(/短视频|原视频|音轨|采样图与问题/);
  });
});

describe("text AI service authorization", () => {
  it.each([
    ["AI Provider", "provider", "deepseek"],
    ["AI Endpoint", "endpoint", "https://other.example.invalid/chat"],
    ["AI Fallback Provider", "fallbackProvider", "custom"],
    ["AI Fallback Endpoint", "fallbackEndpoint", "https://fallback.example.invalid/chat"]
  ] as const)("revokes authorization when changing %s", async (name, field, value) => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.ai.provider = "openai-compatible";
    settings.ai.dataDisclosureAccepted = true;
    const saveSettings = vi.fn(async () => {
      expect(settings.ai[field]).toBe(value);
      expect(settings.ai.dataDisclosureAccepted).toBe(false);
    });
    new LifeOpsSettingTab({ app: {}, settings, saveSettings } as any).display();
    const consent = rendered.rows.find(row => row.name === "允许文本发送给当前 AI Provider");
    expect(consent?.value).toBe(true);
    expect(consent?.checked).toBe("true");
    await rendered.rows.find(row => row.name === name)?.change?.(value);
    expect(saveSettings).toHaveBeenCalledOnce();
    expect(consent?.value).toBe(false);
    expect(consent?.checked).toBe("false");
  });

  it("retains authorization when the trimmed service address is unchanged", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.ai.provider = "openai-compatible";
    settings.ai.dataDisclosureAccepted = true;
    const saveSettings = vi.fn();
    new LifeOpsSettingTab({ app: {}, settings, saveSettings } as any).display();
    await rendered.rows.find(row => row.name === "AI Endpoint")?.change?.(" " + settings.ai.endpoint + " ");
    expect(settings.ai.dataDisclosureAccepted).toBe(true);
    expect(saveSettings).not.toHaveBeenCalled();
  });
});
