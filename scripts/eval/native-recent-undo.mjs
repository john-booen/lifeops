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
          arguments: { title: "虚构送样品盒" + source, date: "2026-11-22", time: "15:15" } }, "kimi");
        if (!created.success) throw Error(created.output);
        const prior = (await p.store.readTaskDb()).tasks.find(task => !before.some(old => old.id === task.id));
        const changed = await p.submitAgentMessageStream("刚刚那条改成2026-11-22下午四点。", [{ role: "assistant", content: created.output, receipts: [created.receipt] }], () => {}, { source, selfTest: true });
        if (changed.receipts.length !== 1 || (await p.store.readTaskDb()).tasks.find(t => t.id === prior.id)?.time !== "16:00") throw Error("Explicit native recent correction not committed");
        const reply = await p.submitAgentMessageStream("撤销刚才的修改。", [], () => {}, { source, selfTest: true });
        const repeated = await p.submitAgentMessageStream("撤销刚才的修改。", [], () => {}, { source, selfTest: true });
        answers.push({ source, reply: reply.reply, repeated: repeated.reply, prior, after: (await p.store.readTaskDb()).tasks.find(task => task.id === prior.id) });
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
    result.checks[answer.source === "voice" ? "nativeVoiceRecentClockAndRepeatedUndoProtectCreation" : "nativeTextRecentClockAndRepeatedUndoProtectCreation"] = true;
    result.checks[answer.source === "voice" ? "nativeVoiceRecentModificationUndoKeepsTaskAndNeedsNoModel"
      : "nativeTextRecentModificationUndoKeepsTaskAndNeedsNoModel"] = true;
  }
}
