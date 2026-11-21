/** Exercises actual native controls only inside the guarded remote fictional vault. */
import assert from "node:assert/strict";
import { join } from "node:path";

const message = "虚构整理清单\n1. 蓝纸归档\n2. 绿纸核对";

async function copyUi(page, result) {
  const text = page.locator(".lifeops-agent-message-text").last();
  const style = await text.evaluate(el => ({ selection: getComputedStyle(el).userSelect,
    webkitSelection: getComputedStyle(el).webkitUserSelect }));
  assert.equal(style.selection, "text"); assert.equal(style.webkitSelection, "text");
  await text.click({ clickCount: 3 });
  const selected = await page.evaluate(() => getSelection().toString());
  assert(selected.trim().length > 0, "Native mouse selection was empty");
  await page.keyboard.press("Meta+c");
  assert.equal(await page.evaluate(() => require("electron").clipboard.readText()), selected);
  result.checks.chatNativeSelectionAndCopy = true;
  await page.getByRole("button", { name: "复制这条消息", exact: true }).last().click();
  await page.getByRole("button", { name: "复制这条消息", exact: true }).last().filter({ hasText: "已复制" }).waitFor();
  assert.equal(await page.evaluate(() => require("electron").clipboard.readText()), message);
  result.checks.chatCopyButtonExactBody = true;
}

async function inputUi(page, root, result) {
  const input = page.locator("textarea.lifeops-agent-input").last();
  await input.fill("虚构蓝纸"); await input.press("ArrowLeft"); await input.press("ArrowLeft");
  assert.equal(await input.evaluate(el => el.selectionStart), 2);
  await page.keyboard.insertText("绿"); assert.equal(await input.inputValue(), "虚构绿蓝纸");
  const style = await input.evaluate(el => ({ focused: document.activeElement === el,
    caret: getComputedStyle(el).caretColor, color: getComputedStyle(el).color, selection: getComputedStyle(el).userSelect }));
  assert(style.focused && style.caret === style.color && style.caret !== "transparent" && !style.caret.endsWith(", 0)"));
  assert.equal(style.selection, "text"); result.checks.chatCaretAndNativeEditing = true;
  await page.screenshot({ path: join(root, "chat-caret-dark.png"), caret: "initial" });
  await input.press("Shift+Enter"); assert.equal(await input.inputValue(), "虚构绿\n蓝纸");
  assert.equal(await page.evaluate(() => globalThis.__nativeChatCalls), 0);
  await input.evaluate(el => {
    el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
    el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  });
  assert.equal(await page.evaluate(() => globalThis.__nativeChatCalls), 0);
  result.checks.chatShiftEnterAndCompositionDoNotSend = true;
  await input.press("Enter");
  await page.waitForFunction(() => globalThis.__nativeChatCalls === 1
    && !app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view.agentBusy);
  const state = await page.evaluate(() => {
    const view = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;
    return { input: view.agentInput, user: view.agentMessages.filter(m => m.role === "user").at(-1).content };
  });
  assert.deepEqual(state, { input: "", user: "虚构绿\n蓝纸" }); result.checks.chatEnterSendsExactlyOnce = true;
  await page.evaluate(() => {
    const p = app.plugins.getPlugin("lifeops-assistant");
    const pending = () => { globalThis.__nativeChatCalls++; return new Promise(resolve => { globalThis.__nativeChatResolve = resolve; }); };
    p.ai.agentTurnStream = pending; Object.getPrototypeOf(p.ai).agentTurnStream = pending;
  });
  await input.fill("虚构处理中问题"); await input.press("Enter");
  await page.waitForFunction(() => globalThis.__nativeChatCalls === 2);
  await input.fill("虚构保留草稿"); await input.press("Enter");
  assert.equal(await input.inputValue(), "虚构保留草稿");
  assert.equal(await page.evaluate(() => globalThis.__nativeChatCalls), 2);
  await page.evaluate(() => globalThis.__nativeChatResolve({ content: "虚构完成回复", toolCalls: [] }));
  await page.waitForFunction(() => !app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view.agentBusy);
  assert.equal(await input.inputValue(), "虚构保留草稿"); result.checks.chatBusyEnterPreservesNextDraft = true;
  const theme = await page.evaluate(() => ({ dark: document.body.classList.contains("theme-dark"), light: document.body.classList.contains("theme-light") }));
  await page.evaluate(() => { document.body.classList.remove("theme-dark"); document.body.classList.add("theme-light"); });
  await input.focus();
  const light = await input.evaluate(el => ({ caret: getComputedStyle(el).caretColor, text: getComputedStyle(el).color }));
  assert.equal(light.caret, light.text);
  await page.screenshot({ path: join(root, "chat-caret-light.png"), caret: "initial" });
  await page.evaluate(theme => { document.body.classList.toggle("theme-dark", theme.dark); document.body.classList.toggle("theme-light", theme.light); }, theme);
  result.checks.chatCaretFollowsLightAndDarkText = true;
}

export async function chatInteractionUi(page, root, result) {
  assert.equal(process.env.GITHUB_ACTIONS, "true"); assert.equal(process.env.RUNNER_OS, "macOS");
  const before = await page.evaluate(async content => {
    const p = app.plugins.getPlugin("lifeops-assistant");
    const tasks = await p.store.readPath(p.store.taskDbPath());
    globalThis.__nativeChatOriginal = { ai: p.settings.ai, privacy: p.settings.privacy,
      instance: p.ai.agentTurnStream, prototype: Object.getPrototypeOf(p.ai).agentTurnStream };
    p.settings.ai = { ...p.settings.ai, provider: "custom", endpoint: "https://fiction.invalid/chat", apiKey: "fictional-chat-key",
      model: "synthetic", fallbackProvider: "off", dataDisclosureAccepted: true };
    p.settings.privacy = { ...p.settings.privacy, plaintextCredentialStorageAccepted: true };
    globalThis.__nativeChatCalls = 0;
    const mock = async () => { globalThis.__nativeChatCalls++; return { content: "虚构复制与输入回复", toolCalls: [] }; };
    p.ai.agentTurnStream = mock; Object.getPrototypeOf(p.ai).agentTurnStream = mock;
    await p.activateView(true); const view = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;
    view.agentMode = "text"; view.agentMessages = [{ role: "assistant", content }]; view.setAgentInput("");
    await view.navigateSteward("chat"); return tasks;
  }, message);
  try { await copyUi(page, result); await inputUi(page, root, result); }
  finally {
    const after = await page.evaluate(async () => {
      const p = app.plugins.getPlugin("lifeops-assistant"), saved = globalThis.__nativeChatOriginal;
      p.settings.ai = saved.ai; p.settings.privacy = saved.privacy;
      p.ai.agentTurnStream = saved.instance; Object.getPrototypeOf(p.ai).agentTurnStream = saved.prototype;
      const view = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view; view.setAgentInput("");
      return p.store.readPath(p.store.taskDbPath());
    });
    assert.equal(after, before, "Chat control checks changed task data");
    result.checks.chatControlsPreserveExistingTasks = true;
  }
}
