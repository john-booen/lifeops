import type LifeOpsPlugin from "../../src/main";
import { AgentRuntime } from "../../src/agentRuntime";
import { fileRevision } from "../../src/operationIdentity";
import { bindAgentHistoryResponse, historicalQueryHistoryContext } from "../../src/personalMemoryHistory";
import type { StoreHost } from "../../src/store/settingsSlice";
import { runConfirmedToolAction } from "../../src/toolRegistry";
import type { AgentConversationMessage } from "../../src/types";
import { buildResidentContext } from "../../src/agent/context";
import { formatConfirmedPersonalMemoryContext } from "../../src/personalMemoryContext";
import { readPersonalMemoryWithSources } from "../../src/personalMemorySources";

/** The real preceding conversation and correction, not a fabricated history receipt. */
export async function historicalFollowupFixture(plugin: LifeOpsPlugin, store: StoreHost, backgroundCount = 0): Promise<AgentConversationMessage[]> {
  await crowdedMemoryFixture(store, backgroundCount);
  const original = "虚构纸样归档只在周三上午09:30可安排25分钟。";
  const corrected = "虚构纸样归档只在周三晚上19:30可安排25分钟。";
  const path = store.path(store.settings.folders.ideas, "虚构连续回顾安排.md"); await store.writeFile(path, original);
  const record = await store.upsertPersonalMemory({ kind: "user_rule", content: original, sourceRefs: [{ sourceId: "fictional-followup-rule", path,
    capturedAt: new Date().toISOString(), contentHash: fileRevision(original), extractionVersion: "fictional-v1" }] });
  await store.reviewPersonalMemory(record.id, { decision: "confirm" });
  for (const [date, text] of [["2026-10-28", "虚构纸样归档连续25分钟完成蓝纸12张。"], ["2026-11-04", "虚构纸样归档连续25分钟完成黄纸11张。"]]) {
    await store.appendDaily(date, "日记", text, "晚", text);
  }
  const question = "核对2026年10月26日至11月8日的虚构纸样归档原始日记，给一条下周安排建议，不修改任务。";
  const reply = await plugin.submitAgentMessageStream(question, [], () => {}, { source: "text" });
  const history: AgentConversationMessage[] = [{ role: "user", content: question }, { role: "assistant", content: reply.reply }];
  bindAgentHistoryResponse(reply, history[0], history[1]);
  if (!historicalQueryHistoryContext(history, store)) throw Error("虚构前轮没有完成可核对的历史查询。");
  const runtime = new AgentRuntime({ store, refreshViews: async () => {} });
  const proposal = await runtime.executeAiToolCall({ id: "fictional-followup-confirmed-correction", name: "review_personal_memory",
    arguments: { memoryId: record.id, decision: "correct", correctedContent: corrected } }, "kimi");
  if (!proposal.success || proposal.actions.length !== 1 || !await runConfirmedToolAction(proposal.actions[0], { store, refreshViews: async () => {} })) {
    throw Error("虚构当前时段没有完成真实更正确认。");
  }
  return history;
}

export async function crowdedMemoryFixture(store: StoreHost, count: number, namedEpisode = false, residentQuery = ""): Promise<void> {
  for (let index = 0; index < count; index++) {
    const content = namedEpisode ? `虚构背景画像${index}：偏好按颜色收纳。`
      : `虚构纸样归档背景${index}：` + "这是一段已核对的虚构背景说明。".repeat(80);
    const path = store.path(store.settings.folders.ideas, `虚构容量背景${index}.md`);await store.writeFile(path, content);
    const record = await store.upsertPersonalMemory({ kind: "core_profile", content, sourceRefs: [{ sourceId: `fictional-memory-capacity-${index}`, path,
      capturedAt: new Date().toISOString(), contentHash: fileRevision(content), extractionVersion: "fictional-v1" }] });
    await store.reviewPersonalMemory(record.id, { decision: "confirm" });
  }
  if (namedEpisode) {
    const content = "虚构海盐索引在2026年10月28日完成六张索引卡。";
    const path = store.path(store.settings.folders.ideas, "虚构海盐索引.md");await store.writeFile(path, content);
    const record = await store.upsertPersonalMemory({ kind: "episode", content, sourceRefs: [{ sourceId: "fictional-named-episode", path,
      capturedAt: new Date().toISOString(), observedDate: "2026-10-28", contentHash: fileRevision(content), extractionVersion: "fictional-v1" }] });
    await store.reviewPersonalMemory(record.id, { decision: "confirm" });
    const context = await buildResidentContext(store, residentQuery, new Date());
    const canonical = formatConfirmedPersonalMemoryContext((await readPersonalMemoryWithSources(store)).records, residentQuery, 4000, 8);
    if (context.text.includes("海盐索引") || canonical.includes("海盐索引")) throw Error("Named-memory fixture must require retrieval beyond the initial context.");
  }
}
