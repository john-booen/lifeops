import assert from "node:assert/strict";
import { join } from "node:path";

export async function nativeDeferredTitleConfirmation(page, root, result) {
  const first = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), view = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;
    const held = globalThis.__nativeRequestedTitlePreview = { before: (await p.store.readTaskDb()).tasks, added: [], receipts: [], calls: 0,
      instance: p.ai.agentTurnStream, prototype: Object.getPrototypeOf(p.ai).agentTurnStream, factory: p.createAgentRuntime, undone: false };
    for (const [i, title] of ["虚构待确认旧甲", "虚构待确认旧乙"].entries()) held.added.push(await p.store.createTask({
      title, date: "2026-11-22", startTime: `${15 + i}:00`, endTime: `${15 + i}:30`, note: "虚构确认续接备注" }));
    const mock = async () => {
      if (++held.calls !== 1) throw Error("Requested preview or its approval called the model again");
      return { content: "", toolCalls: [{ id: "fictional-model-tried-early-update", name: "update_tasks", arguments: {
        updates: held.added.map((row, i) => ({ taskIdOrTitle: row.id, title: i ? "虚构待确认新乙" : "虚构待确认新甲" })) } }] };
    };
    p.ai.agentTurnStream = mock; Object.getPrototypeOf(p.ai).agentTurnStream = mock;
    p.createAgentRuntime = function (...args) {
      const runtime = held.factory.apply(this, args), execute = runtime.executeToolCall.bind(runtime);
      runtime.executeToolCall = async (...values) => { const output = await execute(...values); if (output.receipt) held.receipts.push(output.receipt); return output; };
      return runtime;
    };
    view.agentMode = "text"; view.agentMessages = []; view.pendingAgentActions = []; await view.navigateSteward("chat");
    const raw = await p.store.readPath(p.store.taskDbPath());
    view.setAgentInput("把「虚构待确认旧甲」改为「虚构待确认新甲」，把「虚构待确认旧乙」改为「虚构待确认新乙」。先给我确认卡，等我确认。");
    await view.sendAgentMessage();
    const card = view.pendingAgentActions[0], updates = card?.toolBatch?.flatMap(call => call.arguments.updates ?? []) ?? [];
    return { reply: view.agentReply, noWrite: raw === await p.store.readPath(p.store.taskDbPath()), receipts: held.receipts,
      pending: view.pendingAgentActions.length, calls: held.calls, updates, cardType: card?.type };
  });
  try {
    assert(first.noWrite); assert.deepEqual(first.receipts, []); assert.equal(first.pending, 1); assert.equal(first.calls, 1);
    assert.equal(first.cardType, "tool_batch"); assert.equal(first.updates.length, 2);
    assert(first.updates.every(row => typeof row.expectedRevision === "string")); assert(first.reply.includes("尚未修改"));
    await page.getByRole("button", { name: "查看待确认动作", exact: true }).click();
    const preview = page.getByRole("textbox", { name: "确认后执行的修改", exact: true });
    await preview.waitFor(); const content = await preview.inputValue();
    for (const word of ["虚构待确认旧甲", "虚构待确认旧乙", "虚构待确认新甲", "虚构待确认新乙"]) assert(content.includes(word));
    await preview.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(root, "deferred-title-preview.png") });
    const observed = await page.evaluate(async () => {
      const p = app.plugins.getPlugin("lifeops-assistant"), view = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;
      const held = globalThis.__nativeRequestedTitlePreview;
      view.setAgentInput("确定"); await view.sendAgentMessage();
      const answer = { calls: held.calls, reply: view.agentReply, pending: view.pendingAgentActions.length, added: held.added,
        rows: (await p.store.readTaskDb()).tasks.filter(row => held.added.some(old => old.id === row.id)), receipts: held.receipts };
      p.createAgentRuntime = held.factory;
      for (const receipt of [...held.receipts].reverse()) await p.createAgentRuntime().undoOperation(receipt.operationId);
      held.undone = true; return answer;
    });
    assert.equal(observed.calls, 1); assert.equal(observed.pending, 0);
    assert.equal(observed.receipts.flatMap(receipt => receipt.taskEdits ?? []).length, 2);
    assert(observed.reply.includes("虚构待确认新甲") && observed.reply.includes("虚构待确认新乙"));
    for (const [i, row] of observed.added.entries()) {
      const { title, updatedAt, ...rest } = observed.rows.find(task => task.id === row.id);
      const { title: oldTitle, updatedAt: oldUpdated, ...old } = row;
      assert.equal(title, i ? "虚构待确认新乙" : "虚构待确认新甲"); assert.deepEqual(rest, old);
    }
    await page.locator(".lifeops-agent-message.assistant").last().scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(root, "deferred-title-confirmed.png") });
    result.checks.deferredTitleRequestDoesNotWriteBeforeConfirmation = true;
    result.checks.shortConfirmationResumesBothDeferredTitlesAndPreservesFields = true;
    result.checks.requestedTwoTitleEditsRenderOneFrozenCard = true;
    result.checks.bareApprovalOfRequestedSmallBatchSavesWithoutSecondModelTurn = true;
    result.deferredTitleConfirmation = { modelCalls: 1, actualEdits: 2, firstPendingCards: 1, originalFieldsPreserved: true,
      approvalAdditionalModelCalls: 0, undoneAndFixtureRestored: true };
  } finally {
    const restored = await page.evaluate(async () => {
      const held = globalThis.__nativeRequestedTitlePreview; if (!held) throw Error("Fictional preview cleanup missing");
      const p = app.plugins.getPlugin("lifeops-assistant"); p.createAgentRuntime = held.factory;
      p.ai.agentTurnStream = held.instance; Object.getPrototypeOf(p.ai).agentTurnStream = held.prototype;
      if (!held.undone) for (const receipt of [...held.receipts].reverse()) await p.createAgentRuntime().undoOperation(receipt.operationId);
      for (const row of held.added) await p.store.deleteTask(row.id);
      delete globalThis.__nativeRequestedTitlePreview; return { before: held.before, after: (await p.store.readTaskDb()).tasks };
    });
    assert.deepEqual(restored.after, restored.before);
  }
}
