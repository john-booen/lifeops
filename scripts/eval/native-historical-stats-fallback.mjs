import assert from "node:assert/strict";
import { join } from "node:path";

/** Real native chat and local rereads, with only a synthetic analysis failure. */
export async function nativeHistoricalStatsFallback(page, root, result) {
  const prepared = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant");
    const task = await p.store.createTask({ title: "虚构跨周中断纸样", date: "2007-03-06" });
    await p.store.updateTask(task.id, row => ({ ...row, createdAt: "2007-03-06T09:00:00+08:00", status: "completed", completedAt: "2007-03-06T10:00:00+08:00" }));
    await p.store.appendDaily("2007-03-06", "日记", "虚构跨周中断原文：整理一张紫色纸样，未写原因。", "晚");
    return { taskId: task.id };
  });
  await page.waitForFunction(() => {
    const p = app.plugins.getPlugin("lifeops-assistant"), s = globalThis[Symbol.for("lifeops.fact-operation-state.v1")];
    return !p.sourceChangeTimers?.size && !p.dataFoundationBootstrap && !s?.locks?.has(app.vault) && !s?.activeWrites?.has(app.vault);
  });
  try {
    const observed = await page.evaluate(async () => {
      const p = app.plugins.getPlugin("lifeops-assistant"), view = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;
      const prototype = Object.getPrototypeOf(p.ai), saved = { instance: p.ai.agentTurnStream, prototype: prototype.agentTurnStream, fetch: globalThis.fetch };
      const before = await p.store.readPath(p.store.taskDbPath());
      let calls = 0, fetches = 0, finalToolsFree = false;
      try {
        globalThis.fetch = async () => { fetches++; throw Error("Fictional historical fallback forbids provider transport"); };
        const mock = async (messages, onText, options) => {
          calls++;
          if (calls === 1) return { content: "", toolCalls: [
            { id: "native-history-originals", name: "get_summaries", arguments: { level: "week", range: { from: "2007-03-05", to: "2007-03-11" }, includeOriginals: true } },
            { id: "native-history-stats", name: "get_stats", arguments: { domain: "tasks", range: { from: "2007-03-05", to: "2007-03-11" } } }
          ] };
          if (calls === 2) { const content = "虚构不可采纳草稿：完成99项，原因是懒惰。"; onText?.(content); return { content, toolCalls: [] }; }
          if (calls !== 3) throw Error("Historical fallback must not retry a model request");
          finalToolsFree = options?.toolChoice === "none" && !options?.tools?.length
            && !messages.some(message => message.content.includes("虚构不可采纳草稿"));
          throw Error("Fictional final historical analysis network interruption");
        };
        p.ai.agentTurnStream = mock; prototype.agentTurnStream = mock;
        view.agentMessages = []; view.pendingAgentActions = []; view.agentMode = "text"; await view.navigateSteward("chat");
        view.setAgentInput("核对2007年3月5日至11日的任务完成情况与日记原文，不修改。");
        await view.sendAgentMessage();
        return { text: view.agentReply, calls, fetches, finalToolsFree, before, after: await p.store.readPath(p.store.taskDbPath()),
          receipts: view.agentMessages.at(-1).receipts ?? [], pending: view.pendingAgentActions.length };
      } finally { p.ai.agentTurnStream = saved.instance; prototype.agentTurnStream = saved.prototype; globalThis.fetch = saved.fetch; }
    });
    assert.equal(observed.calls, 3); assert.equal(observed.fetches, 0); assert(observed.finalToolsFree);
    assert.equal(observed.before, observed.after); assert.deepEqual(observed.receipts, []); assert.equal(observed.pending, 0);
    for (const value of ["历史分析未完成", "虚构跨周中断原文", "2007-03-05 至 2007-03-11", "计划 1 项，计划内完成 1 项", "区间内登记完成 1 个任务。", "不是实测工时"]) assert(observed.text.includes(value), value + " missing: " + observed.text);
    for (const value of ["不可采纳草稿", "完成99项", "原因是懒惰"]) assert(!observed.text.includes(value));
    await page.screenshot({ path: join(root, "historical-stats-fallback.png") });
    result.checks.historicalAnalysisFailureRetainsRecheckedNumbersAndOriginals = true;
    result.checks.historicalAnalysisFallbackDoesNotRetryModelsOrChangeTasks = true;
  } finally { await page.evaluate(async id => app.plugins.getPlugin("lifeops-assistant").store.deleteTask(id), prepared.taskId); }
}
