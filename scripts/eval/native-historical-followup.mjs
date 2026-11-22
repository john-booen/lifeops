import assert from "node:assert/strict";
import { join } from "node:path";

/** Continue the actual preceding UI query after a real confirmed memory edit. */
export async function nativeHistoricalFollowup(page, root, result) {
  const prepared = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), view = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;
    const old = "虚构纸样归档只能安排周三19:30，25分钟。", corrected = "虚构纸样归档只能安排周三20:15，25分钟。";
    const memory = (await p.store.readPersonalMemories()).records.find(row => row.content === old);
    if (!memory || !view.agentReply.includes("2026-10-28")) throw Error("Preceding fictional UI query unavailable");
    const oldReply = view.agentReply, cards = await p.prepareStewardMemoryReview(memory, { decision: "correct", content: corrected });
    if (cards.length !== 1) throw Error("Fictional follow-up correction card unavailable");
    await p.executeAgentAction(cards[0]);
    return { old, corrected, oldReply };
  });
  await page.waitForFunction(() => {
    const p = app.plugins.getPlugin("lifeops-assistant"), state = globalThis[Symbol.for("lifeops.fact-operation-state.v1")];
    return !p.sourceChangeTimers?.size && !p.dataFoundationBootstrap && !state?.locks?.has(app.vault) && !state?.activeWrites?.has(app.vault);
  });
  const observed = await page.evaluate(async prepared => {
    const p = app.plugins.getPlugin("lifeops-assistant"), view = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;
    const tasks = await p.store.readPath(p.store.taskDbPath()), memory = await p.store.readPath(p.store.personalMemoryPath());
    let calls = 0, evidence;
    const mock = async (messages, onText, options) => {
      calls++;
      if (!messages[0]?.content.includes("## Confirmed Personal Memory") || !messages[0].content.includes(prepared.corrected)) {
        throw Error("Complete current confirmed memory missing from provider context");
      }
      if (calls === 1) {
        const text = JSON.stringify(messages);
        if (!text.includes("2026-10-26") || !text.includes("2026-11-08") || !text.includes(prepared.corrected)
          || text.includes(prepared.old) || messages.some(message => message.content.includes(prepared.oldReply))) throw Error("Checked dates or current memory missing; old prose reused");
        return { content: "", toolCalls: [{ id: "fictional-native-followup-reread", name: "get_summaries", arguments: { level: "week", range: { from: "2026-10-26", to: "2026-11-08" }, includeOriginals: true, query: "纸样 归档" } }] };
      }
      const final = options?.toolChoice === "none";
      const outputs = final ? messages.filter(message => message.role === "user" && message.content.startsWith("已核对的工具读回资料"))
        .map(message => JSON.parse(message.content.slice(message.content.indexOf("\n") + 1)).result) : messages.filter(message => message.role === "tool").map(message => message.content);
      evidence = outputs.map(text => { try { return JSON.parse(text).originalEvidence; } catch { return; } }).find(Boolean);
      if (!evidence) throw Error("Follow-up did not re-read current originals");
      const content = final ? evidence.notes.map(note => note.date + " · " + note.path + "\n" + note.text).join("\n\n")
        + "\n下一步（建议）：按当前更正时段周三20:15留25分钟。历史发生时刻未知，未创建任务。" : "虚构未发布接续草稿";
      onText?.(content); return { content, toolCalls: [] };
    };
    p.ai.agentTurnStream = mock; Object.getPrototypeOf(p.ai).agentTurnStream = mock;
    view.setAgentInput("按刚更正的时间，接着这两周的纸样归档给一条下周建议，不创建任务。"); await view.sendAgentMessage();
    return { calls, evidence, reply: view.agentReply, tasksUnchanged: tasks === await p.store.readPath(p.store.taskDbPath()),
      memoryUnchanged: memory === await p.store.readPath(p.store.personalMemoryPath()), receipts: view.agentMessages.at(-1).receipts ?? [] };
  }, prepared);
  assert.equal(observed.calls, 3); assert.deepEqual(observed.evidence.notes.map(note => note.date), ["2026-10-28", "2026-11-04"]);
  assert(observed.reply.includes("20:15") && !observed.reply.includes(prepared.oldReply) && !observed.reply.includes("未发布接续草稿"));
  assert(observed.tasksUnchanged && observed.memoryUnchanged); assert.deepEqual(observed.receipts, []);
  await page.screenshot({ path: join(root, "historical-followup-corrected.png") });
  result.checks.historicalFollowupAfterMemoryCorrectionRetainsCheckedRange = true;
  result.checks.historicalFollowupReReadsOriginalsWithoutOldAnswerOrWrites = true;
  result.checks.historicalFinalReceivesCompleteConfirmedMemoryBlock = true;
  result.historicalFollowup = { calls: 3, originalDates: observed.evidence.notes.map(note => note.date), tasksUnchanged: true, memoryUnchanged: true };
}
