import assert from "node:assert/strict";
import { join } from "node:path";

/** Native UI and original query executors; only model selection is synthetic. */
export async function nativeTaskCounts(page, root, result) {
  const fixture = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), day = offset => new Date(Date.now() + offset * 86400000).toLocaleDateString("sv-SE");
    const rows = [];
    for (const data of [
      { title: "虚构原生数量过期纸袋", date: day(-2) },
      { title: "虚构原生数量今日纸袋", date: day(0), dueDate: day(0) },
      { title: "虚构原生数量期间纸袋", date: day(-1), endDate: day(2) }
    ]) rows.push(await p.store.createTask(data));
    return { ids: rows.map(row => row.id) };
  });
  await page.waitForFunction(() => {
    const p = app.plugins.getPlugin("lifeops-assistant"), s = globalThis[Symbol.for("lifeops.fact-operation-state.v1")];
    return !p.sourceChangeTimers?.size && !p.dataFoundationBootstrap && !s?.locks?.has(app.vault) && !s?.activeWrites?.has(app.vault);
  });
  try {
    const observed = await page.evaluate(async () => {
      const p = app.plugins.getPlugin("lifeops-assistant"), prototype = Object.getPrototypeOf(p.ai);
      const saved = { instance: p.ai.agentTurnStream, prototype: prototype.agentTurnStream, fetch: globalThis.fetch };
      const view = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;
      const before = await p.store.readPath(p.store.taskDbPath()); let calls = 0, fetches = 0;
      try {
        globalThis.fetch = async () => { fetches++; throw Error("Fictional native count forbids transport"); };
        const mock = async () => {
          if (++calls > 2) throw Error("Factual numbers must not require another interpretation");
          return { content: "", toolCalls: [
            ...(calls === 2 ? [{ id: "fictional-overview", name: "get_stats", arguments: { domain: "tasks", range: "last_week", directReply: "task_summary" } }] : []),
            { id: "fictional-overdue-count", name: "list_tasks", arguments: { answerMode: "counts", dueStatus: "overdue", query: "虚构原生数量" } }
          ] };
        };
        p.ai.agentTurnStream = mock; prototype.agentTurnStream = mock;
        view.agentMessages = []; view.pendingAgentActions = []; view.agentMode = "text"; await view.navigateSteward("chat");
        view.setAgentInput("数一下虚构原生数量相关目前有几项逾期，只报数量，不修改。");
        await view.sendAgentMessage();
        const first = view.agentReply, firstCalls = calls;
        view.setAgentInput("再查上周任务完成概况和虚构原生数量的当前逾期数，只报登记数字，不修改。");
        await view.sendAgentMessage();
        return { first, second: view.agentReply, firstCalls, calls, fetches,
          unchanged: await p.store.readPath(p.store.taskDbPath()) === before,
          receipts: view.agentMessages.flatMap(message => message.receipts ?? []), pending: view.pendingAgentActions.length };
      } finally {
        p.ai.agentTurnStream = saved.instance; prototype.agentTurnStream = saved.prototype; globalThis.fetch = saved.fetch;
        view.agentMessages = []; view.pendingAgentActions = [];
      }
    });
    assert.equal(observed.firstCalls, 1); assert.equal(observed.calls, 2); assert.equal(observed.fetches, 0);
    assert(observed.unchanged); assert.deepEqual(observed.receipts, []); assert.equal(observed.pending, 0);
    for (const reply of [observed.first, observed.second]) {
      assert(reply.includes("已逾期 1 项"), reply);
      for (const unwanted of ["虚构原生数量", "今天到期", "今天硬截止", "需要我"]) assert(!reply.includes(unwanted), reply);
    }
    assert(observed.second.includes("任务完成登记")); assert(observed.second.includes("不是该区间结束时"));
    result.checks.nativeOverdueCountOmitsUnrequestedTitles = true;
    result.checks.nativeWeekOverviewAndCurrentCountPreserveBothScopes = true;
    await page.screenshot({ path: join(root, "task-counts.png") });
  } finally { await page.evaluate(async ids => { const p = app.plugins.getPlugin("lifeops-assistant"); for (const id of ids) await p.store.deleteTask(id); }, fixture.ids); }
}
