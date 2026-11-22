import { createPersonalMemory, findMemorySuppression, reviewPersonalMemoryRecord, upsertPersonalMemoryRecord, type PersonalMemoryKind } from "./personalMemory";
import type { ToolExecutionContext, ToolExecutionResult } from "./toolRegistry";

export async function saveMemoryNote(content: string, fileName: string, operationId: string, context: ToolExecutionContext, conversation = false): Promise<ToolExecutionResult> {
  const before = await context.store.readPersonalMemories();
  const kinds: Record<string, PersonalMemoryKind> = {
    "个人画像.md": "core_profile", "当前状态.md": "current_state", "长期目标.md": "core_profile",
    "管家规则.md": "user_rule", "交易纪律.md": "user_rule"
  };
  if (!content.trim() || !kinds[fileName]) throw new Error("个人记忆内容或分类无效。");
  if (findMemorySuppression(before.records, content)) throw new Error("这段内容已被遗忘或纠正，不会重新写入。需要恢复时，请先核对原来的修改。");
  const sourceRef = { sourceId: operationId, path: context.store.path(context.store.settings.folders.aiReports, "Operations", "operation-ledger.json"), capturedAt: new Date().toISOString() };
  const incoming = createPersonalMemory({ kind: kinds[fileName], content,
    tags: [fileName.replace(/\.md$/, ""), ...(conversation ? ["对话"] : [])], sourceRefs: [sourceRef] });
  const same = before.records.find(record => record.kind === incoming.kind && record.content === incoming.content);
  let observations = before.records;
  if (same?.sourceBinding) {
    // A version-bound observation keeps its original evidence and identity in
    // the archive. This new user statement gets its own confirmation receipt.
    observations = before.records.map(record => record.id === same.id
      ? { ...record, status: "candidate" as const, archivedAt: new Date().toISOString(),
        confirmedAt: undefined, confirmationReceipt: undefined } : record);
    incoming.tags = Array.from(new Set([...same.tags, ...incoming.tags]));
    incoming.sensitive ||= same.sensitive;
    incoming.revisions = same.revisions;
  } else if (same) incoming.id = same.id;
  observations = upsertPersonalMemoryRecord(observations, incoming);
  const records = reviewPersonalMemoryRecord(observations, incoming.id, { decision: "confirm", sourceRef });
  await context.store.writePersonalMemories({ ...before, records });
  const verified = (await context.store.readPersonalMemories()).records.find(record => record.id === incoming.id);
  if (!verified || verified.content !== incoming.content || verified.status !== "active"
    || !verified.sourceRefs.some(ref => ref.sourceId === operationId)) throw new Error("个人记忆写入后读回校验失败");
  await context.refreshViews();
  return { success: true, output: `已记住：${verified.content}`, actions: [],
    undo: { kind: "restore_personal_memory_document", document: structuredClone(before) as unknown as Record<string, unknown> } };
}
