import { Notice } from "obsidian";

export function bindChatInputKeyboard(input: HTMLTextAreaElement, state: {
  textMode(): boolean;
  unavailable(): boolean;
  send(): void;
}): void {
  let composing = false;
  input.addEventListener("compositionstart", () => { composing = true; });
  input.addEventListener("compositionend", () => { composing = false; });
  input.onkeydown = event => {
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (event.key !== "Enter" || event.shiftKey || event.altKey) return;
    if (!state.textMode() && !event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    if (!event.repeat && !state.unavailable()) state.send();
  };
}

export function renderChatMessageContent(bubble: HTMLElement, content: string): void {
  bubble.createDiv({ text: content, cls: "lifeops-agent-message-text" });
  if (!content.trim()) return;
  const actions = bubble.createDiv({ cls: "lifeops-agent-message-actions" });
  const copy = actions.createEl("button", { text: "复制", cls: "lifeops-agent-copy",
    attr: { type: "button", "aria-label": "复制这条消息" } });
  copy.onclick = async () => {
    copy.disabled = true;
    try {
      await navigator.clipboard.writeText(content);
      copy.textContent = "已复制";
    } catch {
      new Notice("复制未完成，请选中文字后按 Cmd+C 或 Ctrl+C。");
    } finally {
      copy.disabled = false;
    }
  };
}
