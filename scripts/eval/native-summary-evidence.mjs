import assert from "node:assert/strict";
import { join } from "node:path";

/** Real report header action, local source viewer and original opening; fictional vault only. */
export async function nativeSummaryEvidence(page, root, result) {
  const prepared = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), today = new Date().toLocaleDateString("sv-SE");
    const report = p.store.path(p.settings.folders.aiReports, "摘要", "周", "2024-W09.md");
    const child = p.store.path(p.settings.folders.aiReports, "摘要", "日", "2024-02-27.md");
    const daily = p.store.path(p.settings.folders.aiReports, "摘要", "日", today + ".md");
    const sources = ["2024-02-27早.md", "2024-02-27晚.md", "2024-02-28晚.md"].map(name => p.store.path(p.settings.folders.dailyRoot, "2024", "02", name));
    const saved = { ai: p.settings.ai, privacy: p.settings.privacy, report, child, daily, sources, before: [] };
    for (const path of [report, child, daily, ...sources]) saved.before.push({ path, raw: p.store.getFile(path) ? await p.store.readPath(path) : null });
    globalThis.__nativeSummaryEvidence = saved;
    p.settings.ai = { ...p.settings.ai, provider: "off", fallbackProvider: "off" };
    const existing = p.store.getFile(daily); if (existing) await app.vault.delete(existing);
    await p.generateDailyReview();
    const actual = await p.store.readPath(daily), scope = /^sourceScope:\s*["']?([a-f0-9]{64})/mu.exec(actual)?.[1];
    if (!scope) throw Error("Native local summary did not supply its real source scope");
    const metrics = { taskCompletionPercent: null, tasksCompleted: 0, energy: null, tradePnlCny: null, tradePnlUsd: null };
    const note = (level, from, to, count) => "---\n" + JSON.stringify({ lifeops: "lifeops-summary", level, from, to,
      through: to, sourceScope: scope, inputCount: count, complete: true, generatedBy: "model", metrics }) + "\n---\n\n虚构保留旧稿，原版本标记未核实。\n";
    await p.store.writeFile(report, note("week", "2024-02-26", "2024-03-03", 7));
    await p.store.writeFile(child, note("day", "2024-02-27", "2024-02-27", 0));
    for (const path of sources) await p.store.writeFile(path, "# 虚构原文\n虚构未展示的原话。<script>虚构标签</script>\n");
    return { report, child, sources };
  });
  try {
    await page.waitForFunction(() => { const p = app.plugins.getPlugin("lifeops-assistant"), s = globalThis[Symbol.for("lifeops.fact-operation-state.v1")];
      return !p.sourceChangeTimers?.size && !p.dataFoundationBootstrap && !s?.locks?.has(app.vault) && !s?.activeWrites?.has(app.vault); });
    await page.evaluate(async prepared => {
      const p = app.plugins.getPlugin("lifeops-assistant"), saved = globalThis.__nativeSummaryEvidence;
      saved.taskBytes = await p.store.readPath(p.store.taskDbPath()); saved.viewBytes = [];
      for (const path of [prepared.report, prepared.child, ...prepared.sources]) saved.viewBytes.push({ path, raw: await p.store.readPath(path) });
      await p.openStewardSummary(prepared.report);
    }, prepared);
    await page.waitForFunction(path => {
      const view = app.workspace.getLeavesOfType("markdown").find(leaf => leaf.view.file?.path === path)?.view;
      return view?.containerEl.querySelectorAll('[data-lifeops-summary-evidence="true"]').length === 1;
    }, prepared.report);
    await page.evaluate(prepared => {
      const view = app.workspace.getLeavesOfType("markdown").find(leaf => leaf.view.file?.path === prepared.report)?.view;
      const actions = view?.containerEl.querySelectorAll('[data-lifeops-summary-evidence="true"]');
      if (actions?.length !== 1) throw Error("Missing unique summary header action"); actions[0].click();
    }, prepared);
    await page.getByRole("heading", { name: "摘要依据与原文入口", exact: true }).waitFor();
    const sourceButton = page.getByRole("button", { name: "打开来源：" + prepared.sources[0], exact: true }); await sourceButton.waitFor();
    const initial = await page.evaluate(() => {
      const body = document.querySelector(".lifeops-summary-evidence-body");
      return { text: body?.textContent, days: body?.querySelectorAll("tbody tr").length, unsafe: !!body?.querySelector("img,script") };
    });
    assert.equal(initial.days, 7); assert(initial.text.includes("找到日记3篇，分布在2天"));
    assert(initial.text.includes("标记为7份") && initial.text.includes("当前可回看1份") && initial.text.includes("版本未核实"));
    assert(!initial.text.includes("虚构未展示的原话") && !initial.unsafe);
    await page.screenshot({ path: join(root, "summary-evidence.png") });
    await page.evaluate(() => {
      const p = app.plugins.getPlugin("lifeops-assistant"), saved = globalThis.__nativeSummaryEvidence;
      saved.oldButton = [...document.querySelectorAll("button[data-source-path]")].find(button => button.dataset.sourcePath === saved.sources[0]);
      p.settings.privacy = { ...p.settings.privacy, excludedVaultPrefixes: [...(p.settings.privacy?.excludedVaultPrefixes ?? []), saved.sources[0]] };
    });
    await page.waitForFunction(() => document.querySelector(".lifeops-summary-evidence")?.textContent?.includes("资料范围或文件已变化"));
    assert.equal(await page.locator(".lifeops-summary-evidence-body button[data-source-path]").count(), 0);
    const stayed = await page.evaluate(() => { const saved = globalThis.__nativeSummaryEvidence; saved.oldButton.click(); return app.workspace.getActiveFile()?.path === saved.report; });
    assert(stayed);
    await page.evaluate(() => { const p = app.plugins.getPlugin("lifeops-assistant"); p.settings.privacy = globalThis.__nativeSummaryEvidence.privacy; });
    await page.getByRole("button", { name: "刷新摘要依据", exact: true }).click(); await sourceButton.waitFor(); await sourceButton.click();
    await page.waitForFunction(path => app.workspace.getActiveFile()?.path === path, prepared.sources[0]);
    await page.locator(".lifeops-summary-evidence").waitFor({ state: "hidden" });
    assert.equal(await page.locator(".lifeops-summary-evidence").count(), 0);
    const final = await page.evaluate(async () => {
      const p = app.plugins.getPlugin("lifeops-assistant"), saved = globalThis.__nativeSummaryEvidence;
      return { unchanged: (await Promise.all(saved.viewBytes.map(async row => row.raw === await p.store.readPath(row.path)))).every(Boolean),
        tasksUnchanged: saved.taskBytes === await p.store.readPath(p.store.taskDbPath()), providers: p.activeProviderRequests.size };
    });
    assert(final.unchanged && final.tasksUnchanged && final.providers === 0);
    result.checks.nativeSummaryEvidenceListsDatesWithoutRewritingOrProviderTraffic = true;
    result.checks.nativeSummaryEvidenceScopeChangeClearsOldLinksAndOpensCurrentSource = true;
  } finally {
    await page.evaluate(async () => {
      const p = app.plugins.getPlugin("lifeops-assistant"), saved = globalThis.__nativeSummaryEvidence;
      if (!saved) return;
      try {
        for (const leaf of app.workspace.getLeavesOfType("markdown")) if (saved.before.some(row => row.path === leaf.view.file?.path)) leaf.detach();
        for (const { path, raw } of saved.before) {
          if (raw !== null) await p.store.writeFile(path, raw);
          else { const file = p.store.getFile(path); if (file) await app.vault.delete(file); }
        }
      } finally { p.settings.ai = saved.ai; p.settings.privacy = saved.privacy; delete globalThis.__nativeSummaryEvidence; }
      await p.activateView(true);
    });
    await page.waitForFunction(() => { const p = app.plugins.getPlugin("lifeops-assistant"), s = globalThis[Symbol.for("lifeops.fact-operation-state.v1")];
      return !p.sourceChangeTimers?.size && !p.dataFoundationBootstrap && !s?.locks?.has(app.vault) && !s?.activeWrites?.has(app.vault); });
  }
}
