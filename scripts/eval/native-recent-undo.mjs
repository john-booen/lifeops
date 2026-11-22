import assert from "node:assert/strict";

/** Exercise the normal text/voice adapters with fictional saved changes; no audio device. */
export async function nativeRecentUndo(page, result) {
  const observed = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), runtime = p.createAgentRuntime();
    const before = (await p.store.readTaskDb()).tasks, answers = [];
    const instance = p.ai.agentTurnStream, prototype = Object.getPrototypeOf(p.ai).agentTurnStream;
    let calls = 0;
    const unavailable = async () => { calls++; throw Error("Recent modification undo must not request a model"); };
    try {
      p.ai.agentTurnStream = unavailable; Object.getPrototypeOf(p.ai).agentTurnStream = unavailable;
      for (const source of ["text", "voice"]) {
        const created = await runtime.executeAiToolCall({ id: "fictional-undo-create-" + source, name: "create_task",
          arguments: { title: "虚构送样品盒" + source, date: "2099-02-04", time: "15:15" } }, "kimi");
        if (!created.success) throw Error(created.output);
        const original = (await p.store.readTaskDb()).tasks.find(task => !before.some(old => old.id === task.id));
        const edited = await runtime.executeAiToolCall({ id: "fictional-undo-title-" + source, name: "update_tasks", arguments: { updates: [{ taskIdOrTitle: original.id, title: "虚构送蓝色样品盒" + source, note: "虚构备注保持" }] } }, "kimi");
        if (!edited.success) throw Error(edited.output);
        const prior = (await p.store.readTaskDb()).tasks.find(task => task.id === original.id);
        const changed = await p.submitAgentMessageStream("请把刚才那条的时间改成2026-11-22下午四点。", [{ role: "assistant", content: edited.output, receipts: [edited.receipt] }], () => {}, { source, selfTest: true });
        if (changed.receipts.length !== 1 || (await p.store.readTaskDb()).tasks.find(t => t.id === prior.id)?.time !== "16:00") throw Error("Explicit native recent correction not committed");
        const reply = await p.submitAgentMessageStream("撤销刚才的修改。", [], () => {}, { source, selfTest: true });
        const after = (await p.store.readTaskDb()).tasks.find(task => task.id === prior.id);
        await runtime.undoOperation(edited.receipt.operationId);
        const repeated = await p.submitAgentMessageStream("撤销刚才的修改。", [], () => {}, { source, selfTest: true });
        const afterGuard = (await p.store.readTaskDb()).tasks.find(task => task.id === prior.id);
        let tonight = true;
        if (source === "text") {
          const moved = await p.submitAgentMessageStream("把刚才那条改到今晚八点。", [{ role: "assistant", content: created.output, receipts: [created.receipt] }], () => {}, { source, selfTest: true });
          const task = (await p.store.readTaskDb()).tasks.find(task => task.id === original.id);
          tonight = moved.receipts.length === 1 && task.date === new Date().toLocaleDateString("sv-SE") && task.time === "20:00";
          if (!tonight) throw Error("Tonight retained a future date"); await runtime.undoOperation(moved.receipts[0].operationId);
        }
        answers.push({ source, reply: reply.reply, repeated: repeated.reply, prior, after, original, afterGuard, tonight });
        await runtime.undoOperation(created.receipt.operationId);
      }
    } finally {
      p.ai.agentTurnStream = instance; Object.getPrototypeOf(p.ai).agentTurnStream = prototype;
    }
    return { answers, calls, before, after: (await p.store.readTaskDb()).tasks };
  });
  assert.equal(observed.calls, 0); assert.deepEqual(observed.after, observed.before);
  for (const answer of observed.answers) {
    assert(answer.reply.includes("已撤销") && answer.reply.includes(answer.prior.title), JSON.stringify(answer));
    assert.deepEqual(answer.after, answer.prior); assert(answer.repeated.includes("新建任务已保留"));
    assert.deepEqual(answer.afterGuard, answer.original);
    result.checks[answer.source === "voice" ? "nativeVoiceEditedTaskReceiptContinuesWithClockAndUndo" : "nativeTextEditedTaskReceiptContinuesWithClockAndUndo"] = true;
    if (answer.source === "text") { assert(answer.tonight); result.checks.nativeTonightCorrectionChangesTheDateInsteadOfRetainingFutureDay = true; }
    result.checks[answer.source === "voice" ? "nativeVoiceRecentClockAndRepeatedUndoProtectCreation" : "nativeTextRecentClockAndRepeatedUndoProtectCreation"] = true;
    result.checks[answer.source === "voice" ? "nativeVoiceRecentModificationUndoKeepsTaskAndNeedsNoModel"
      : "nativeTextRecentModificationUndoKeepsTaskAndNeedsNoModel"] = true;
  }
}
