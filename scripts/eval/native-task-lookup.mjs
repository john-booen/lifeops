/** The guarded native runner owns every record used here. No model or audio starts. */
import assert from "node:assert/strict";

export async function nativeTaskLookup(page, result) {
  const state = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), before = (await p.store.readTaskDb()).tasks;
    const date = new Date().toLocaleDateString("sv-SE"), added = [], targets = [];
    let first, second, filtered;
    try {
      for (let i = 0; i < 35; i++) {
        const task = await p.store.createTask({ title: i < 24 ? "虚构查找纸袋" + i : "虚构区间纸样" + i, date });
        added.push(task.id); if (i >= 24) targets.push(task.id);
      }
      const runtime = p.createAgentRuntime();
      const query = async args => {
        const response = await runtime.executeAiToolCall({ name: "list_tasks", arguments: { date, ...args } }, "kimi");
        if (!response.success) throw Error(response.output); return JSON.parse(response.output);
      };
      first = await query({}); second = await query({ offset: first.nextOffset }); filtered = await query({ query: "虚构区间纸样" });
    } finally { for (const id of added) await p.store.deleteTask(id); }
    return { before, after: (await p.store.readTaskDb()).tasks, targets, first, second, filtered };
  });
  assert.equal(state.first.nextOffset, 20);
  assert.equal(new Set([...state.first.tasks, ...state.second.tasks].map(row => row.id)).size, state.first.count);
  assert.equal(state.second.truncated, false); assert.equal(state.filtered.count, 11);
  assert.deepEqual(state.filtered.tasks.map(row => row.id), state.targets); assert.deepEqual(state.after, state.before);
  result.checks.nativeTaskLookupFindsElevenTargetsAfterTwentyOtherTasks = true;
  result.checks.nativeTaskLookupPagesKeepAllIdsAndOriginalTasks = true;
}
