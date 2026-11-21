import { afterEach, describe, expect, it, vi } from "vitest";
import { bindChatInputKeyboard, renderChatMessageContent } from "../src/panel/chatInteraction";

const notices = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", () => ({ Notice: class { constructor(message: string) { notices.push(message); } } }));
afterEach(() => { vi.unstubAllGlobals(); notices.length = 0; });

function keyboard(text = true) {
  const input = new EventTarget() as HTMLTextAreaElement;
  const state = { text, unavailable: false };
  const send = vi.fn();
  bindChatInputKeyboard(input, { textMode: () => state.text, unavailable: () => state.unavailable, send });
  const press = (changes: Partial<KeyboardEvent> = {}) => {
    const event = { key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
      repeat: false, isComposing: false, keyCode: 13, preventDefault: vi.fn(), ...changes };
    input.onkeydown!(event as unknown as KeyboardEvent);
    return event;
  };
  return { input, state, send, press };
}

describe("chat input keyboard", () => {
  it.each([{}, { ctrlKey: true }, { metaKey: true }])("sends once for Enter or the retained send shortcut: %j", keys => {
    const h = keyboard(); const event = h.press(keys);
    expect(h.send).toHaveBeenCalledOnce(); expect(event.preventDefault).toHaveBeenCalledOnce();
  });
  it.each([{ shiftKey: true }, { altKey: true }, { key: "ArrowLeft" }])("retains native editing for %j", keys => {
    const h = keyboard(); const event = h.press(keys);
    expect(h.send).not.toHaveBeenCalled(); expect(event.preventDefault).not.toHaveBeenCalled();
  });
  it("does not send while choosing Chinese text, including legacy composition events", () => {
    const h = keyboard();
    h.input.dispatchEvent(new Event("compositionstart"));
    h.press(); h.input.dispatchEvent(new Event("compositionend"));
    h.press({ isComposing: true }); h.press({ keyCode: 229 });
    expect(h.send).not.toHaveBeenCalled();
    h.press(); expect(h.send).toHaveBeenCalledOnce();
  });
  it("preserves the next draft during busy state and ignores repeated Enter", () => {
    const h = keyboard(); h.state.unavailable = true;
    expect(h.press().preventDefault).toHaveBeenCalledOnce(); h.state.unavailable = false;
    h.press({ repeat: true }); expect(h.send).not.toHaveBeenCalled();
    h.press(); expect(h.send).toHaveBeenCalledOnce();
  });
  it("leaves ordinary Enter in voice mode and observes later mode changes", () => {
    const h = keyboard(false); expect(h.press().preventDefault).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled(); h.press({ metaKey: true });
    expect(h.send).toHaveBeenCalledOnce(); h.state.text = true; h.press();
    expect(h.send).toHaveBeenCalledTimes(2);
  });
});

class Element {
  children: Element[] = [];
  textContent = "";
  disabled = false;
  onclick?: () => Promise<void>;
  constructor(public tag = "div", public options: any = {}) { this.textContent = options.text ?? ""; }
  createDiv(options: any) { return this.createEl("div", options); }
  createEl(tag: string, options: any) { const child = new Element(tag, options); this.children.push(child); return child; }
}

describe("chat copy action", () => {
  it("copies the readable verified task receipt while keeping names, dates and the original transcript intact", async () => {
    const writeText = vi.fn(async () => {}); vi.stubGlobal("navigator", { clipboard: { writeText } });
    const original = "已更新「虚构旧清单」→「虚构新清单」。编号task-fiction-1；原安排2026-11-23 15:00；完成状态保留。\n"
      + "已创建任务：给虚构紫色纸袋编号（明天 17:00）。已从任务库读回校验（ID：task-fiction-2）。";
    const expected = "已更新「虚构旧清单」→「虚构新清单」。原安排2026-11-23 15:00；完成状态保留。\n已创建任务：给虚构紫色纸袋编号（明天 17:00）。";
    const bubble = new Element(); renderChatMessageContent(bubble as any, original, true);
    expect(bubble.children[0].textContent).toBe(expected); await bubble.children[1].children[0].onclick!();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(expected); expect(original).toContain("task-fiction-1");
  });
  it.each([false, undefined])("keeps literal receipt text intact without verified write evidence: %s", async verified => {
    const writeText = vi.fn(async () => {}); vi.stubGlobal("navigator", { clipboard: { writeText } });
    const original = "已创建任务：虚构文字范例。已从任务库读回校验（ID：task-example）。";
    const bubble = new Element(); renderChatMessageContent(bubble as any, original, verified);
    expect(bubble.children[0].textContent).toBe(original); await bubble.children[1].children[0].onclick!();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(original);
  });
  it("preserves a quoted protocol fragment inside the task title and other user identifiers", () => {
    const content = "已创建任务：整理文字“已从任务库读回校验（ID：task-quoted）。”（明天 17:00）。已从任务库读回校验（ID：task-actual）。\n客户ID：task-other。";
    const bubble = new Element(); renderChatMessageContent(bubble as any, content, true);
    expect(bubble.children[0].textContent).toContain("task-quoted"); expect(bubble.children[0].textContent).toContain("task-other");
    expect(bubble.children[0].textContent).not.toContain("task-actual");
  });
  it("copies only the exact message body, including lines and Markdown, without the controls", async () => {
    const writeText = vi.fn(async () => {}); vi.stubGlobal("navigator", { clipboard: { writeText } });
    const body = "**虚构清单**\n1. 蓝纸\n2. 绿纸";
    const bubble = new Element(); renderChatMessageContent(bubble as any, body);
    const button = bubble.children[1].children[0];
    expect(button.options.attr["aria-label"]).toBe("复制这条消息");
    await button.onclick!();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(body);
    expect(button.textContent).toBe("已复制"); expect(button.disabled).toBe(false);
    expect(bubble.children[0].textContent).toBe(body);
  });
  it("does not claim success if clipboard access fails and allows another attempt", async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error("clipboard denied")).mockResolvedValueOnce(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const bubble = new Element(); renderChatMessageContent(bubble as any, "虚构原话");
    const button = bubble.children[1].children[0]; await button.onclick!();
    expect(button.textContent).toBe("复制"); expect(button.disabled).toBe(false);
    expect(notices[0]).toContain("选中文字"); await button.onclick!();
    expect(button.textContent).toBe("已复制"); expect(writeText).toHaveBeenCalledTimes(2);
  });
  it("does not add a copy action to an empty pending reply", () => {
    const bubble = new Element(); renderChatMessageContent(bubble as any, " ");
    expect(bubble.children).toHaveLength(1);
  });
});
