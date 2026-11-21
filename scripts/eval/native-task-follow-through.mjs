import assert from "node:assert/strict";
import { join } from "node:path";

export async function nativeTaskFollowThrough(page, root, result) {
  const observed = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), before = (await p.store.readTaskDb()).tasks;
    const added = [];
    for (const [i, title] of ["虚构续办旧甲", "虚构续办旧乙"].entries()) added.push(await p.store.createTask({ title, date: "2026-11-22", time: `${15 + i}:00` }));
    const instance = p.ai.agentTurnStream, prototype = Object.getPrototypeOf(p.ai).agentTurnStream;
    let calls = 0, palette;
    const mock = async (_messages, _onText, options) => {
      if (++calls === 1) return { content: "", toolCalls: [{ id: "fictional-follow-edits", name: "update_tasks", arguments: {
        updates: added.map((task, i) => ({ taskIdOrTitle: task.id, title: "虚构续办新" + (i ? "乙" : "甲") })) } }] };
      if (calls === 2) {
        palette = options.tools.map(tool => tool.name);
        return { content: "", toolCalls: [{ id: "fictional-follow-create", name: "create_task",
          arguments: { title: "给虚构续办紫色纸袋编号", date: "2026-11-22", time: "17:00" } }] };
      }
      return { content: "已完成。", toolCalls: [] };
    };
    let answer;
    try {
      p.ai.agentTurnStream = mock; Object.getPrototypeOf(p.ai).agentTurnStream = mock;
      const view = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;
      view.agentMode = "text"; view.agentMessages = []; view.pendingAgentActions = []; await view.navigateSteward("chat");
      view.setAgentInput("把「虚构续办旧甲」改为「虚构续办新甲」，把「虚构续办旧乙」改为「虚构续办新乙」。再新增2026-11-22 17:00给虚构续办紫色纸袋编号。");
      await view.sendAgentMessage();
      answer = { reply: view.agentReply, rows: (await p.store.readTaskDb()).tasks.filter(row => !before.some(old => old.id === row.id)),
        receipts: view.agentMessages.at(-1).receipts, calls, palette };
      for (const receipt of [...answer.receipts].reverse()) await p.createAgentRuntime().undoOperation(receipt.operationId);
    } finally {
      p.ai.agentTurnStream = instance; Object.getPrototypeOf(p.ai).agentTurnStream = prototype;
      for (const task of added) await p.store.deleteTask(task.id);
    }
    return { ...answer, before, after: (await p.store.readTaskDb()).tasks };
  });
  assert.equal(observed.calls, 3); assert.equal(observed.receipts.length, 2); assert.equal(observed.rows.length, 3);
  assert(!observed.palette.includes("list_tasks") && !observed.palette.includes("update_tasks"));
  for (const name of ["create_task", "schedule_task_batch", "query_vault"]) assert(observed.palette.includes(name));
  for (const title of ["虚构续办新甲", "虚构续办新乙", "给虚构续办紫色纸袋编号"]) assert(observed.rows.some(row => row.title === title));
  assert.equal(observed.rows.find(row => row.title.includes("紫色纸袋")).time, "17:00");
  assert.deepEqual(observed.after, observed.before);
  await page.screenshot({ path: join(root, "task-follow-through.png") });
  result.checks.completedTitleEditsLeaveCapacityForNewTask = true;
}
