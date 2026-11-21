import assert from "node:assert/strict";

/** Actual daily-summary command and preview, AI off, fictional native vault. */
export async function nativeSummaryJournalCoverage(page, result) {
  await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), date = new Date().toLocaleDateString("sv-SE");
    const diary = p.store.path(p.settings.folders.dailyRoot, date.slice(0, 4), date.slice(5, 7), date + "早.md");
    const report = p.store.path(p.settings.folders.aiReports, "摘要", "日", date + ".md");
    const saved = { ai: p.settings.ai, diary, report, before: [], tasks: await p.store.readPath(p.store.taskDbPath()) };
    for (const path of [diary, report]) saved.before.push({ path, raw: p.store.getFile(path) ? await p.store.readPath(path) : null });
    globalThis.__nativeSummaryJournalCoverage = saved;
    p.settings.ai = { ...p.settings.ai, provider: "off", fallbackProvider: "off" };
    await p.store.writeFile(diary, "# 虚构原话\n\n我计划明天给虚构紫色纸盒贴标签，还没有做。\n");
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
