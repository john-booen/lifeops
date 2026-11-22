/** The guarded native runner owns every record used here. No model or audio starts. */
import assert from "node:assert/strict";

export async function nativeTaskLookup(page, result) {
  const state = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), before = (await p.store.readTaskDb()).tasks;
    const date = new Date().toLocaleDateString("sv-SE"), added = [], targets = [];
    let first, second, filtered, crossDate, readable, queryTasksUnchanged, modelCalls = 0;
    try {
      for (let i = 0; i < 35; i++) {
        const task = await p.store.createTask({ title: i < 24 ? "虚构查找纸袋" + i : "虚构区间纸样" + i, date });
        added.push(task.id); if (i >= 24) targets.push(task.id);
      }
      for (const [title, day] of [["虚构跨日期查找蓝盒旧记录", "2001-02-03"], ["虚构跨日期查找蓝盒未来", "2099-02-04"]]) {
        added.push((await p.store.createTask({ title, date: day, time: "15:15" })).id);
      }
      const runtime = p.createAgentRuntime();
      const query = async args => {
        const response = await runtime.executeAiToolCall({ name: "list_tasks", arguments: { date, ...args } }, "kimi");
        if (!response.success) throw Error(response.output); return JSON.parse(response.output);
      };
      first = await query({}); second = await query({ offset: first.nextOffset }); filtered = await query({ query: "虚构区间纸样" });
      const response = await runtime.executeAiToolCall({ name: "list_tasks", arguments: { query: "虚构跨日期查找蓝盒" } }, "kimi");
      if (!response.success) throw Error(response.output); crossDate = JSON.parse(response.output);
      const instance = p.ai.agentTurnStream, prototype = Object.getPrototypeOf(p.ai).agentTurnStream;
      const mock = async () => { modelCalls++; if (modelCalls > 1) return { content: "", toolCalls: [] }; return { content: "", toolCalls: [{ id: "fictional-all-date-lookup", name: "list_tasks", arguments: { query: "虚构跨日期查找蓝盒", directReply: true } }] }; };
      try {
        p.ai.agentTurnStream = mock; Object.getPrototypeOf(p.ai).agentTurnStream = mock;
        const bytes = await p.store.readPath(p.store.taskDbPath());
        const view = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;
        view.agentMode = "text"; view.agentMessages = []; view.pendingAgentActions = []; await view.navigateSteward("chat");
        view.setAgentInput("请查找虚构跨日期查找蓝盒相关的所有日期任务。"); await view.sendAgentMessage();
        readable = view.agentReply; queryTasksUnchanged = bytes === await p.store.readPath(p.store.taskDbPath());
      } finally { p.ai.agentTurnStream = instance; Object.getPrototypeOf(p.ai).agentTurnStream = prototype; }
    } finally { for (const id of added) await p.store.deleteTask(id); }
    return { before, after: (await p.store.readTaskDb()).tasks, targets, first, second, filtered, crossDate, readable, queryTasksUnchanged, modelCalls };
  });
  assert.equal(state.first.nextOffset, 20);
  assert.equal(new Set([...state.first.tasks, ...state.second.tasks].map(row => row.id)).size, state.first.count);
  assert.equal(state.second.truncated, false); assert.equal(state.filtered.count, 11);
  assert.deepEqual(state.filtered.tasks.map(row => row.id), state.targets); assert.deepEqual(state.after, state.before);
  result.checks.nativeTaskLookupFindsElevenTargetsAfterTwentyOtherTasks = true;
  result.checks.nativeTaskLookupPagesKeepAllIdsAndOriginalTasks = true;
  assert.equal(state.crossDate.date, null); assert.equal(state.crossDate.dateScope, "all"); assert.equal(state.crossDate.count, 2);
  assert.deepEqual(state.crossDate.tasks.map(task => task.date), ["2001-02-03", "2099-02-04"]);
  assert(state.readable.includes("所有日期") && state.readable.includes("2001-02-03") && state.readable.includes("2099-02-04"), JSON.stringify({ readable: state.readable, modelCalls: state.modelCalls }));
  assert(state.queryTasksUnchanged && state.modelCalls === 2);
  const visible = await page.locator(".lifeops-agent-message.assistant .lifeops-agent-message-text").last().textContent();
  assert(visible.includes("2001-02-03") && visible.includes("2099-02-04"));
  result.checks.nativeNamedTaskLookupFindsPastAndFutureDates = true;
  result.checks.nativeNamedTaskLookupShowsPerTaskDatesWithoutChangingRecords = true;
}
