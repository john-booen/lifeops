import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

/** Actual selection modal and derived saves, using a separate fictional external directory. */
export async function nativeSelectedJournals(page, root, result) {
  const original = join(root, "Selected-originals"), folder = "LifeOps/Journal/2024/02";
  await mkdir(join(original, folder), { recursive: true });
  const quotes = ["试做一个虚构蓝纸分类索引。", "精力四分，准备做一个虚构绿纸索引。"];
  const files = ["2024-02-27晚.md", "2024-02-28晚.md"].map(name => folder + "/" + name);
  const raws = ["# 虚构原文\n" + "未选择的虚构前文。".repeat(900) + "\n\n" + quotes[0], "# 虚构次日原文\n\n" + quotes[1]];
  for (let i = 0; i < files.length; i++) await writeFile(join(original, files[i]), raws[i]);
  const prepared = await page.evaluate(async ({ original }) => {
    const p = app.plugins.getPlugin("lifeops-assistant"), proto = Object.getPrototypeOf(p.ai);
    globalThis.__nativeSelectedJournals = { ai: p.settings.ai, privacy: p.settings.privacy, external: p.settings.externalVaults,
      extract: proto.extractJournalSignals, calls: [], tasks: await p.store.readPath(p.store.taskDbPath()) };
    p.settings.ai = { ...p.settings.ai, provider: "custom", endpoint: "https://fiction.invalid/chat", model: "synthetic",
      apiKey: "fictional-selection-key", fallbackProvider: "off", dataDisclosureAccepted: true };
    p.settings.externalVaults = [{ name: "虚构选段", path: original, folders: ["LifeOps/Journal"] }];
    proto.extractJournalSignals = async function(messages, options) {
      await options.beforeTextRequest?.(); options.assertTextRequestCurrent?.();
      const text = messages.find(message => message.role === "user").content;
      const saved = globalThis.__nativeSelectedJournals; saved.calls.push(text);
      if (saved.calls.length > 2 || text.includes("未选择的虚构前文")) throw Error("Unexpected original or repeated native extraction request");
      const date = text.includes("2024-02-27") ? "2024-02-27" : "2024-02-28";
      return JSON.stringify({ date, period: "晚", energy: date.endsWith("28") ? 4 : null,
        quotes: date.endsWith("28") ? [{ field: "energy", text: "精力四分" }] : [],
        ideas: [{ text: "虚构分类索引", quote: text.split("\n\n").at(-1) }] });
    };
    app.commands.executeCommandById("lifeops-assistant:select-external-journal-excerpts");
    return { reports: p.settings.folders.aiReports };
  }, { original });
  try {
    await page.locator(".modal-title").filter({ hasText: "从外部日记选段整理" }).waitFor();
    const picker = page.getByRole("combobox", { name: "选择日记日期和文件", exact: true });
    for (let i = 0; i < files.length; i++) {
      await picker.selectOption("external-vault/虚构选段/" + files[i]);
      await page.getByRole("button", { name: "本机预览原文", exact: true }).click();
      await page.waitForFunction(text => document.querySelector('textarea[aria-label="日记原文，仅本机预览"]')?.value.includes(text), quotes[i]);
      await page.getByRole("textbox", { name: "准备发送的连续原文片段", exact: true }).fill(quotes[i]);
      await page.getByRole("button", { name: "加入待发送片段", exact: true }).click();
    }
    assert.equal(await page.evaluate(() => globalThis.__nativeSelectedJournals.calls.length), 0);
    await page.screenshot({ path: join(root, "selected-journal-before-send.png") });
    const submit = page.getByRole("button", { name: "整理所选片段", exact: true }); await submit.click();
    await page.getByText(/已保存2段，0段已有结果/).waitFor();
    await submit.click(); await page.getByText(/已保存0段，2段已有结果/).waitFor();
    const saved = await page.evaluate(async () => {
      const p = app.plugins.getPlugin("lifeops-assistant"), state = globalThis.__nativeSelectedJournals;
      const documents = await Promise.all(["2024-02-27", "2024-02-28"].map(date => p.store.readJson(p.store.path(p.settings.folders.aiReports, "Signals", "External", "虚构选段", date + ".json"), {})));
      return { calls: state.calls, documents, tasksUnchanged: state.tasks === await p.store.readPath(p.store.taskDbPath()), active: p.activeProviderRequests.size };
    });
    assert.equal(saved.calls.length, 2); assert(saved.tasksUnchanged && saved.active === 0);
    for (let i = 0; i < files.length; i++) {
      assert.equal(saved.documents[i].晚.length, 1); assert.equal(saved.documents[i].晚[0].sources[0].selectedExcerpt.text, quotes[i]);
      assert(saved.calls[i].endsWith(quotes[i])); assert.equal(await readFile(join(original, files[i]), "utf8"), raws[i]);
    }
    await writeFile(join(original, files[0]), raws[0] + "\n虚构后续修订。");
    await submit.click(); await page.getByText(/整理中断或原文有更新/).waitFor();
    assert.equal(await page.evaluate(() => globalThis.__nativeSelectedJournals.calls.length), 2);
    await page.evaluate(() => {
      const p = app.plugins.getPlugin("lifeops-assistant"); p.settings.privacy = { ...p.settings.privacy,
        excludedVaultPrefixes: [...(p.settings.privacy?.excludedVaultPrefixes ?? []), "external-vault/虚构选段"] };
    });
    await page.getByText("资料范围已变化，旧预览与选段已清除，请重新打开。", { exact: true }).waitFor();
    assert.equal(await page.locator(".lifeops-external-journal-picker textarea, .lifeops-external-journal-picker pre").count(), 0);
    await page.keyboard.press("Escape");
    result.checks.nativeSelectedJournalPreviewHasNoProviderTraffic = true;
    result.checks.nativeSelectedJournalSendsOnlyTwoExactExcerptsAndKeepsOriginals = true;
    result.checks.nativeSelectedJournalRetrySkipsSavedAndRejectsChangedSources = true;
    result.checks.nativeSelectedJournalScopeChangeClearsOriginalsAndPreservesTasks = true;
  } finally {
    await page.keyboard.press("Escape");
    await page.evaluate(async () => {
      const p = app.plugins.getPlugin("lifeops-assistant"), saved = globalThis.__nativeSelectedJournals;
      if (!saved) return;
      for (const date of ["2024-02-27", "2024-02-28"]) { const file = p.store.getFile(p.store.path(p.settings.folders.aiReports, "Signals", "External", "虚构选段", date + ".json")); if (file) await app.vault.delete(file); }
      p.settings.ai = saved.ai; p.settings.privacy = saved.privacy; p.settings.externalVaults = saved.external;
      Object.getPrototypeOf(p.ai).extractJournalSignals = saved.extract; delete globalThis.__nativeSelectedJournals;
    });
    await rm(original, { recursive: true, force: true });
  }
}
