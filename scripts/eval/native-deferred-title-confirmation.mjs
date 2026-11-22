import assert from "node:assert/strict";
import { join } from "node:path";

export async function nativeDeferredTitleConfirmation(page, root, result) {
  const observed = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), before = (await p.store.readTaskDb()).tasks;
    const added = [];
    for (const [i, title] of ["虚构待确认旧甲", "虚构待确认旧乙"].entries()) added.push(await p.store.createTask({
      title, date: "2026-11-22", startTime: `${15 + i}:00`, endTime: `${15 + i}:30`, note: "虚构确认续接备注" }));
    const instance = p.ai.agentTurnStream, prototype = Object.getPrototypeOf(p.ai).agentTurnStream;
    let calls = 0, answer;
    const mock = async () => {
      if (++calls === 1) return { content: "虚构待确认旧甲改为虚构待确认新甲；虚构待确认旧乙改为虚构待确认新乙。请确认后我再改。", toolCalls: [] };
      if (calls === 2) return { content: "", toolCalls: [{ id: "fictional-deferred-wrong-day", name: "list_tasks", arguments: {
        date: "2001-01-01", query: "待确认", directReply: true } }] };
      return { content: "模型再次询问的文字不作为保存证据。", toolCalls: [] };
    };
    try {
      p.ai.agentTurnStream = mock; Object.getPrototypeOf(p.ai).agentTurnStream = mock;
      const view = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;
      view.agentMode = "text"; view.agentMessages = []; view.pendingAgentActions = []; await view.navigateSteward("chat");
      const raw = await p.store.readPath(p.store.taskDbPath());
      view.setAgentInput("把「虚构待确认旧甲」改为「虚构待确认新甲」，把「虚构待确认旧乙」改为「虚构待确认新乙」。先给我确认卡，等我确认。");
      await view.sendAgentMessage();
      const first = { reply: view.agentReply, noWrite: raw === await p.store.readPath(p.store.taskDbPath()),
        receipts: view.agentMessages.at(-1).receipts ?? [], pending: view.pendingAgentActions.length };
      view.setAgentInput("确定"); await view.sendAgentMessage();
      answer = { first, calls, reply: view.agentReply, pending: view.pendingAgentActions.length,
        rows: (await p.store.readTaskDb()).tasks.filter(row => added.some(old => old.id === row.id)),
        receipts: view.agentMessages.at(-1).receipts ?? [] };
      for (const receipt of [...answer.receipts].reverse()) await p.createAgentRuntime().undoOperation(receipt.operationId);
    } finally {
      p.ai.agentTurnStream = instance; Object.getPrototypeOf(p.ai).agentTurnStream = prototype;
      for (const task of added) await p.store.deleteTask(task.id);
    }
    return { ...answer, added, before, after: (await p.store.readTaskDb()).tasks };
  });
  assert(observed.first.noWrite); assert.deepEqual(observed.first.receipts, []); assert.equal(observed.first.pending, 0);
  assert(observed.first.reply.includes("确认")); assert.equal(observed.calls, 3); assert.equal(observed.pending, 0);
  assert.equal(observed.receipts.flatMap(receipt => receipt.taskEdits ?? []).length, 2);
  assert(observed.reply.includes("虚构待确认新甲") && observed.reply.includes("虚构待确认新乙"));
  for (const [i, row] of observed.added.entries()) {
    const current = observed.rows.find(task => task.id === row.id), { title, updatedAt, ...rest } = current;
    const { title: oldTitle, updatedAt: oldUpdated, ...old } = row;
    assert.equal(title, i ? "虚构待确认新乙" : "虚构待确认新甲"); assert.deepEqual(rest, old);
  }
  assert.deepEqual(observed.after, observed.before);
  await page.screenshot({ path: join(root, "deferred-title-confirmed.png") });
  result.checks.deferredTitleRequestDoesNotWriteBeforeConfirmation = true;
  result.checks.shortConfirmationResumesBothDeferredTitlesAndPreservesFields = true;
  result.deferredTitleConfirmation = { modelCalls: observed.calls, actualEdits: 2, originalFieldsPreserved: true, undoneAndFixtureRestored: true };
}
