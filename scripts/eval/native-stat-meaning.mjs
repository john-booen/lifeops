import assert from "node:assert/strict";

/** Only the guarded native runner's fictional vault; no provider request. */
export async function nativeStatMeaning(page, result) {
  const observed = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), before = (await p.store.readTaskDb()).tasks;
    if (before.some(task => task.date >= "2026-01-05" && task.date <= "2026-01-11")) throw Error("Fictional interval week already occupied");
    const task = await p.store.createTask({ title: "虚构间隔纸样", date: "2026-01-06", estimateMin: 30,
      startTime: "09:00", endTime: "09:30" });
    try {
      await p.store.updateTask(task.id, row => ({ ...row, createdAt: "2026-01-06T08:00:00+08:00",
        status: "completed", completedAt: "2026-01-07T17:00:00+08:00" }));
      // Native Vault events can outlive the seed write. Query the settled
      // fixture; an in-flight source refresh must still reject unsafe reads.
      await new Promise(resolve => setTimeout(resolve, 0));
      const deadline = Date.now() + 15000;
      while (true) {
        const state = globalThis[Symbol.for("lifeops.fact-operation-state.v1")];
        if (!p.sourceChangeTimers?.size && !p.dataFoundationBootstrap
          && !state?.locks?.has(app.vault) && !state?.activeWrites?.has(app.vault)) break;
        if (Date.now() >= deadline) throw Error("Native statistic fixture source refresh did not settle");
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const bytes = await p.store.readPath(p.store.taskDbPath()), runtime = p.createAgentRuntime();
      const stats = await runtime.executeAiToolCall({ id: "fictional-native-interval-stats", name: "get_stats",
        arguments: { domain: "tasks", range: { from: "2026-01-05", to: "2026-01-11" }, groupBy: "day" } }, "kimi");
      const summary = await runtime.executeAiToolCall({ id: "fictional-native-summary-meaning", name: "get_summaries",
        arguments: { level: "week", range: { from: "2026-01-05", to: "2026-01-11" } } }, "kimi");
      const invalidQueries = [];
      for (const [i, arguments_] of [{ domain: "journal", operation: "list", offset: 12 },
        { domain: "note", operation: "get", range: "week" }].entries()) {
        invalidQueries.push(await runtime.executeAiToolCall({ id: "fictional-native-query-parameter-" + i,
          name: "query_vault", arguments: arguments_ }, "kimi"));
      }
      return { stats, summary, invalidQueries, unchanged: bytes === await p.store.readPath(p.store.taskDbPath()) };
    } finally { await p.store.deleteTask(task.id); }
  });
  assert(observed.unchanged); assert(observed.stats.success, observed.stats.output); assert(observed.summary.success, observed.summary.output);
  for (const response of [observed.stats, observed.summary]) assert(!response.receipt && !response.actions?.length);
  const stats = JSON.parse(observed.stats.output), summary = JSON.parse(observed.summary.output);
  assert.equal(stats.averageCompletionMin, 1980); assert.equal(stats.completionIntervalSampleCount, 1);
  assert.equal(stats.plannedCount, 1); assert.equal(stats.completedPlannedCount, 1); assert.equal(stats.completionPercent, 100);
  assert.equal(stats.metricDefinitions.averageCompletionMin.isWorkingTime, false);
  assert(stats.averageCompletionMinMeaning.includes("不是实测工作工时"));
  assert.equal(stats.recordScope.unrecordedActivity, "unknown");
  assert.equal(summary.recordScope.unrecordedActivity, "unknown");
  for (const key of ["complete", "inputCount", "dates", "suggestions"]) assert(summary.interpretationBoundary[key]);
  result.checks.taskIntervalsDoNotClaimMeasuredWorkingTime = true;
  result.checks.summaryFlagsDoNotClaimCompleteOriginalRecords = true;
  assert(observed.invalidQueries.every(row => !row.success && !row.actions.length && !row.output.includes("权限刚刚变化")));
  assert(observed.invalidQueries[0].output.includes("原文分页")); assert(observed.invalidQueries[1].output.includes("range 仅适用于"));
  result.checks.queryParametersGiveRepairInstructionsWithoutClaimingPermissionChanges = true;
}
