import assert from "node:assert/strict";

/** Actual daily-summary command and preview, AI off, fictional native vault. */
export async function nativeSummaryJournalCoverage(page, result) {
  await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), date = new Date().toLocaleDateString("sv-SE");
    const diary = p.store.path(p.settings.folders.dailyRoot, date.slice(0, 4), date.slice(5, 7), date + "早.md");
    const report = p.store.path(p.settings.folders.aiReports, "摘要", "日", date + ".md");
    const conversation = p.store.path(p.settings.folders.aiReports, "Conversations", date + ".md");
    const saved = { ai: p.settings.ai, diary, report, conversation, before: [], tasks: await p.store.readPath(p.store.taskDbPath()) };
    for (const path of [diary, report, conversation]) saved.before.push({ path, raw: p.store.getFile(path) ? await p.store.readPath(path) : null });
    globalThis.__nativeSummaryJournalCoverage = saved;
    p.settings.ai = { ...p.settings.ai, provider: "off", fallbackProvider: "off" };
    await p.store.writeFile(diary, "# 虚构原话\n\n我计划明天给虚构紫色纸盒贴标签，还没有做。\n");
    await p.store.appendAgentConversation("虚构对话原话：也许每天整理一张青色纸片，尚未决定；明天15:00核对虚构黄盒已决定但未做。<script>虚构标签</script>", "虚构助手的推断不应被引用。", date);
    saved.conversationBefore = await p.store.readPath(conversation);
    const old = p.store.getFile(report); if (old) await app.vault.delete(old);
  });
  try {
    await page.waitForFunction(() => { const p = app.plugins.getPlugin("lifeops-assistant"), s = globalThis[Symbol.for("lifeops.fact-operation-state.v1")];
      return !p.sourceChangeTimers?.size && !p.dataFoundationBootstrap && !s?.locks?.has(app.vault) && !s?.activeWrites?.has(app.vault); });
    const observed = await page.evaluate(async () => {
      const p = app.plugins.getPlugin("lifeops-assistant"), saved = globalThis.__nativeSummaryJournalCoverage;
      await p.generateDailyReview();
      const report = await p.store.readPath(saved.report);
      return { report, original: await p.store.readPath(saved.diary), tasksUnchanged: saved.tasks === await p.store.readPath(p.store.taskDbPath()),
        conversationUnchanged: saved.conversationBefore === await p.store.readPath(saved.conversation),
        providers: p.activeProviderRequests.size };
    });
    assert(observed.report.includes("## 日记资料范围"));
    assert(observed.report.includes("篇日记尚未纳入整理") && observed.report.includes("不代表原文没有计划"));
    assert(/\bgeneratedBy:\s*(?:local|"local")/u.test(observed.report));
    assert(!observed.report.includes("我计划明天给虚构紫色纸盒贴标签"));
    assert(observed.original.includes("我计划明天给虚构紫色纸盒贴标签") && observed.tasksUnchanged && observed.providers === 0);
    await page.getByRole("heading", { name: "日记资料范围", exact: true }).first().waitFor();
    result.checks.nativeDailySummaryShowsUnreviewedJournalCoverage = true;
    result.checks.nativeDailySummaryKeepsOriginalsPrivateWithoutProviderRequests = true;
    assert(observed.report.includes("## 当天对话原话（未整理）") && observed.report.includes("也许每天整理一张青色纸片，尚未决定"));
    assert(observed.report.includes("明天15:00核对虚构黄盒已决定但未做") && observed.conversationUnchanged);
    assert(!observed.report.includes("虚构助手的推断不应被引用") && !observed.report.includes("<script>"));
    await page.getByRole("heading", { name: "当天对话原话（未整理）", exact: true }).first().waitFor();
    const literalVisible = await page.evaluate(() => {
      const saved = globalThis.__nativeSummaryJournalCoverage;
      const view = app.workspace.getLeavesOfType("markdown").find(leaf => leaf.view.file?.path === saved.report)?.view;
      return view?.contentEl?.textContent?.includes("<script>虚构标签</script>") && !view.contentEl.querySelector("script");
    });
    assert(literalVisible && observed.providers === 0 && observed.tasksUnchanged);
    result.checks.nativeDailyFallbackRetainsUninterpretedUserWords = true;
    result.checks.nativeDailyFallbackEscapesQuotedMarkupWithoutRequests = true;
  } finally {
    await page.evaluate(async () => {
      const p = app.plugins.getPlugin("lifeops-assistant"), saved = globalThis.__nativeSummaryJournalCoverage;
      if (!saved) return;
      try {
        for (const leaf of app.workspace.getLeavesOfType("markdown")) if (leaf.view.file?.path === saved.report) leaf.detach();
        for (const { path, raw } of saved.before) {
          if (raw !== null) await p.store.writeFile(path, raw);
          else { const file = p.store.getFile(path); if (file) await app.vault.delete(file); }
        }
      } finally { p.settings.ai = saved.ai; delete globalThis.__nativeSummaryJournalCoverage; }
      await p.activateView(true);
    });
    await page.waitForFunction(() => { const p = app.plugins.getPlugin("lifeops-assistant"), s = globalThis[Symbol.for("lifeops.fact-operation-state.v1")];
      return !p.sourceChangeTimers?.size && !p.dataFoundationBootstrap && !s?.locks?.has(app.vault) && !s?.activeWrites?.has(app.vault); });
  }
}
