import assert from "node:assert/strict";
import { join } from "node:path";

/** The guarded fictional runner exercises a mischosen list call in real chat. */
export async function nativeJournalRangeRouting(page, root, result) {
  await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant");
    await p.store.appendDaily("2008-05-07", "日记", "虚构日记原文：昨晚21:15到家、23:40开始整理，今早00:20结束、08:00起床。", "早");
    await p.store.appendDaily("2008-05-08", "日记", "虚构日记原文：昨晚22:10完成黄纸袋标记，今早07:30起床；青色纸盒编号只是今天计划，尚未完成。", "早");
  });
  await page.waitForFunction(() => {
    const p = app.plugins.getPlugin("lifeops-assistant"), s = globalThis[Symbol.for("lifeops.fact-operation-state.v1")];
    return !p.sourceChangeTimers?.size && !p.dataFoundationBootstrap && !s?.locks?.has(app.vault) && !s?.activeWrites?.has(app.vault);
  });
  const observed = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), view = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;
    const prototype = Object.getPrototypeOf(p.ai), saved = { instance: p.ai.agentTurnStream, prototype: prototype.agentTurnStream, fetch: globalThis.fetch };
    const before = await p.store.readPath(p.store.taskDbPath()); let calls = 0, fetches = 0, data, finalToolsFree = false, toolNames = [];
    try {
      globalThis.fetch = async () => { fetches++; throw Error("Fictional journal range forbids provider transport"); };
      const mock = async (messages, onText, options) => {
        calls++;
        if (calls === 1) return { content: "", toolCalls: [{ id: "fictional-mischosen-journal-list", name: "query_vault",
          arguments: { domain: "journal", operation: "list", range: "week", limit: 40 } }] };
        const textOnly = options?.toolChoice === "none" && !messages.some(message => message.role === "tool" || message.tool_calls?.length);
        const outputs = textOnly ? messages.filter(message => message.role === "user" && message.content.startsWith("已核对的工具读回资料"))
          .map(message => JSON.parse(message.content.slice(message.content.indexOf("\n") + 1)).result) : messages.filter(message => message.role === "tool").map(message => message.content);
        data = outputs.map(raw => { try { return JSON.parse(raw); } catch { return null; } }).find(row => row?.originalEvidence);
        if (!data) throw Error("Literal journal originals were not read before analysis");
        if (!textOnly) {
          toolNames = messages.flatMap(message => message.tool_calls ?? []).map(call => call.function.name);
          const content = "虚构不采纳草稿：按当前周解释历史。"; onText?.(content); return { content, toolCalls: [] };
        }
        if (calls !== 3) throw Error("Journal originals must not consume repeated listing rounds");
        finalToolsFree = !options?.tools?.length && !messages.some(message => message.content.includes("虚构不采纳草稿"));
        return { content: "来源2008-05-07早与2008-05-08早。2008-05-06 21:15到家、23:40开始；2008-05-07 00:20结束、08:00起床、22:10标记；2008-05-08 07:30起床，青色纸盒编号仅计划，尚未完成。", toolCalls: [] };
      };
      p.ai.agentTurnStream = mock; prototype.agentTurnStream = mock;
      view.agentMessages = []; view.pendingAgentActions = []; view.agentMode = "text"; await view.navigateSteward("chat");
      view.setAgentInput("请只查2008年5月5日至5月11日的原始日记，按实际事件日期列出到家、整理起止、标记和起床，给出来源，不新建或修改任务。");
      await view.sendAgentMessage();
      return { text: view.agentReply, data, toolNames, calls, fetches, finalToolsFree, before, after: await p.store.readPath(p.store.taskDbPath()), receipts: view.agentMessages.at(-1).receipts ?? [], pending: view.pendingAgentActions.length };
    } finally { p.ai.agentTurnStream = saved.instance; prototype.agentTurnStream = saved.prototype; globalThis.fetch = saved.fetch; }
  });
  assert.equal(observed.calls, 3); assert.equal(observed.fetches, 0); assert(observed.finalToolsFree);
  assert.deepEqual(observed.toolNames, ["get_summaries"]); assert.deepEqual(observed.data.range, { from: "2008-05-05", to: "2008-05-11" });
  assert.deepEqual(observed.data.originalEvidence.notes.map(note => note.date), ["2008-05-07", "2008-05-08"]);
  assert.equal(observed.data.originalEvidence.notes[0].calendar.yesterday.date, "2008-05-06");
  assert.equal(observed.data.originalEvidence.notes[1].calendar.today.date, "2008-05-08");
  for (const value of ["2008-05-06", "00:20", "2008-05-08", "尚未完成"]) assert(observed.text.includes(value));
  assert(!observed.text.includes("虚构不采纳草稿")); assert.equal(observed.before, observed.after); assert.deepEqual(observed.receipts, []); assert.equal(observed.pending, 0);
  await page.screenshot({ path: join(root, "journal-range-originals.png") });
  result.checks.nativeJournalRangeReadsOriginalsInsteadOfCurrentWeekListings = true;
  result.checks.nativeJournalRangeKeepsTaskFactsAndRequiresNoConfirmation = true;
}
