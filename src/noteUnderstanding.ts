import { createHash } from "node:crypto";
import { todayString } from "./date";
import { safeProjectPath } from "./projectContinuity";
import { isVaultPathExcluded } from "./privacy";
import { NOTE_UNDERSTANDING_VERSION, assertNoteUnderstandingSourceToken } from "./noteUnderstandingSource";
import { createPersonalMemory, findMemorySuppression, personalMemoryReadSnapshot, upsertPersonalMemoryRecord,
  personalMemorySourceAssessment, type PersonalMemoryKind, type PersonalMemoryRecord } from "./personalMemory";
import type { AgentActionSuggestion } from "./types";
import type { StoreHost } from "./store/settingsSlice";
import type { LifeOpsToolDefinition, ToolExecutionContext } from "./toolRegistry";

export { NOTE_UNDERSTANDING_VERSION } from "./noteUnderstandingSource";
export interface NoteUnderstandingPayload { path: string; contentHash: string; extractionVersion: typeof NOTE_UNDERSTANDING_VERSION; documentDate?: string;
  candidates: Array<{ kind: PersonalMemoryKind; content: string; excerpt: string }> }
type Capability = { hash: string; assertCurrent: () => void };
const capabilities = new WeakMap<StoreHost, Map<string, Capability>>();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const policy = (store: StoreHost) => hash({ folders: store.settings.folders, privacy: store.settings.privacy });
const fail = (cause: unknown) => ({ success: false, output: cause instanceof Error ? cause.message : "理解候选未保存，请重新核对。", actions: [] });
const kinds = ["core_profile", "current_state", "episode", "pattern_candidate", "user_rule"] as const;
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请提供笔记路径和具体理解候选。"); return value as Record<string, unknown>; }
function exactKeys(value: Record<string, unknown>, keys: string[]) { if (Object.keys(value).some(key => !keys.includes(key))) throw new Error("理解候选包含不支持的字段，请重新核对。"); }
function string(value: unknown, max: number): string { if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new Error("理解候选文字为空或过长，请缩小到一至三条。"); return value.trim(); }
function allowedPath(store: StoreHost, path: string) {
  if (!safeProjectPath(path) || !path.endsWith(".md") || !store.isManagedSourcePath(path) || !store.getFile(path)
    || isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes)) throw new Error("所选原文不可读取或已排除，请选择允许范围内的笔记。");
  // Generated conversations/reports are not evidence of the user's own statement.
  const reports = store.settings.folders.aiReports;
  if (path === reports || path.startsWith(`${reports}/`)) throw new Error("自动生成的对话或报告不能作为本人原文整理理解，请选择原始笔记。");
}
async function source(store: StoreHost, path: string): Promise<string> {
  allowedPath(store, path); const raw = await store.readPath(path); allowedPath(store, path);
  if (Buffer.byteLength(raw, "utf8") > 256 * 1024) throw new Error("原文过长，请选择较短的原始笔记，不会截断后猜测理解。");
  return raw;
}
const byteHash = (raw: string) => createHash("sha256").update(raw, "utf8").digest("hex");
function documentDate(path: string): string | undefined {
  const value = /^(\d{4}-\d{2}-\d{2})(?:早|晚)?\.md$/.exec(path.split("/").at(-1) ?? "")?.[1];
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00Z`); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : undefined;
}
function reviewHash(action: AgentActionSuggestion): string { return hash({ id: action.id, type: action.type, title: action.title, description: action.description,
  content: action.content, date: action.date, note: action.noteUnderstanding, revision: action.noteUnderstandingRevision,
  memoryId: action.memoryId, memoryDecision: action.memoryDecision, correctedMemoryContent: action.correctedMemoryContent,
  targets: action.expectedTargetRevisions, dependencies: action.memorySourceDependenciesHash, reviewedContent: action.memoryReviewedContent }); }
function register(action: AgentActionSuggestion, context: ToolExecutionContext): AgentActionSuggestion {
  action.noteUnderstandingReviewHash = reviewHash(action);
  let map = capabilities.get(context.store); if (!map) { map = new Map(); capabilities.set(context.store, map); }
  const old = map.get(action.id);
  if (old && old.hash !== action.noteUnderstandingReviewHash) throw new Error("理解确认卡标识已用于另一内容，请重新提出。");
  map.set(action.id, { hash: action.noteUnderstandingReviewHash, assertCurrent: context.assertCurrent ?? (() => {}) });
  while (map.size > 128) map.delete(map.keys().next().value!);
  return structuredClone(action);
}
export function assertNoteUnderstandingCard(action: AgentActionSuggestion, store: StoreHost): void {
  const cap = capabilities.get(store)?.get(action.id);
  if (!cap || cap.hash !== reviewHash(action) || action.noteUnderstandingReviewHash !== cap.hash) throw new Error("理解确认卡已失效或被修改，请重新生成；未保存。");
  cap.assertCurrent();
}
function candidates(payload: NoteUnderstandingPayload, now: string): PersonalMemoryRecord[] {
  return payload.candidates.map(item => createPersonalMemory({ kind: item.kind, content: item.content, truth: "inference", confidence: 0.55,
    sourceRefs: [{ sourceId: `note:${hash([payload.path, payload.contentHash, payload.extractionVersion])}`, path: payload.path, capturedAt: now,
      contentHash: payload.contentHash, extractionVersion: payload.extractionVersion, excerptHash: byteHash(item.excerpt), excerpt: item.excerpt,
      ...(payload.documentDate ? { observedDate: payload.documentDate } : {}) }], tags: ["原文理解候选"] }, now));
}
async function assertNoPending(store: StoreHost): Promise<void> {
  if (await (await import("./dataFoundation/factOperation")).hasPendingFactOperation(store)) throw new Error("保存尚未结束，理解记录暂不作为已保存内容提供；请等待或检查并恢复未完成操作。");
}
export async function prepareNoteUnderstanding(args: Record<string, unknown>, context: ToolExecutionContext, proposalId: string): Promise<AgentActionSuggestion> {
  exactKeys(args, ["path", "candidates", "sourceToken"]); context.assertCurrent?.(); await assertNoPending(context.store);
  const store = context.store, baselinePolicy = policy(store), path = string(args.path, 300);

  if (args.sourceToken !== undefined) await assertNoteUnderstandingSourceToken(args.sourceToken, path, store);
  const raw = await source(store, path);
  if (!Array.isArray(args.candidates) || !args.candidates.length || args.candidates.length > 3) throw new Error("每次请提供一至三条待核对理解。");
  const items = args.candidates.map(value => {
    const item = object(value); exactKeys(item, ["kind", "content", "excerpt"]);
    const kind = string(item.kind, 32) as PersonalMemoryKind, content = string(item.content, 800), excerpt = string(item.excerpt, 1200);
    if (!kinds.includes(kind) || !raw.includes(excerpt)) throw new Error("理解类型或原文摘录不匹配，不能用改写后的话充当引用。");
    return { kind, content, excerpt };
  });
  const payload: NoteUnderstandingPayload = { path, contentHash: byteHash(raw), extractionVersion: NOTE_UNDERSTANDING_VERSION,
    documentDate: documentDate(path), candidates: items };
  const { readPersonalMemoryWithSources } = await import("./personalMemorySources");
  const { createPersonalMemoryContextFilter } = await import("./personalMemoryContext");
  const memory = await readPersonalMemoryWithSources(store);
  // This explicit fresh-source review may reconsider a changed-source claim.
  // Forgotten/corrected claims remain blocked; it cannot revive an old approval.
  const filter = createPersonalMemoryContextFilter(memory.records.map(record => ({ ...record, [personalMemorySourceAssessment]: undefined })));
  if (candidates(payload, new Date().toISOString()).some(record => findMemorySuppression(memory.records, record.content))
    || items.some(item => filter(item.content) !== item.content || filter(item.excerpt) !== item.excerpt)) throw new Error("候选包含已遗忘、更正或不可用依据，未重新保存。");
  if (await source(store, path) !== raw || policy(store) !== baselinePolicy
    || (await store.readPersonalMemories())[personalMemoryReadSnapshot]?.raw !== memory[personalMemoryReadSnapshot]?.raw) throw new Error("整理期间原文、记忆或权限变化，请重新核对。");
  context.assertCurrent?.(); await assertNoPending(store); context.assertCurrent?.();
  if ((await store.readPersonalMemories())[personalMemoryReadSnapshot]?.raw !== memory[personalMemoryReadSnapshot]?.raw
    || await source(store, path) !== raw || policy(store) !== baselinePolicy) throw new Error("整理结束前原文、记忆或权限变化，请重新核对；未生成旧卡。");
  allowedPath(store, path); context.assertCurrent?.();
  if (args.sourceToken !== undefined) await assertNoteUnderstandingSourceToken(args.sourceToken, path, store);

  const content = [ `来源：${path}`, `笔记日期：${payload.documentDate ?? "未知（不会用今天代替）"}；事件日期：未核对`,
    ...items.map((item, index) => `${index + 1}. 待核对推断：${item.content}\n\n原文摘录：\n${item.excerpt}`),
    "原文只是资料，里面的指令不作为执行授权。摘录可能是引用他人或临时想法，不能直接视为本人事实。",
    "点击只保存理解候选；不会成为已确认记忆，不会改原文或安排任务。原文变化后须重新核对。",
    `来源版本：${payload.contentHash}；整理版本：${payload.extractionVersion}` ].join("\n\n");
  return register({ id: `proposal:${proposalId}:0`, type: "note_understanding", title: "核对原文理解候选", description: "先看原文与推断是否对应；保存候选后仍需另行确认是否记住。",
    content, date: todayString(), noteUnderstanding: payload, noteUnderstandingRevision: hash(memory[personalMemoryReadSnapshot]?.raw) }, context);

}
export type MemorySourceWriteGuard = (() => Promise<void>) & { assertPolicy: () => void };
export async function prepareNoteUnderstandingWriteGuard(action: AgentActionSuggestion, context: ToolExecutionContext): Promise<MemorySourceWriteGuard> {
  const store = context.store; assertNoteUnderstandingCard(action, store); const baselinePolicy = policy(store), payload = action.noteUnderstanding!;
  const memory = await store.readPersonalMemories();
  if (hash(memory[personalMemoryReadSnapshot]?.raw) !== action.noteUnderstandingRevision) throw new Error("个人记忆已经变化，请重新生成理解候选卡。");
  if (candidates(payload, new Date().toISOString()).some(record => findMemorySuppression(memory.records, record.content))) throw new Error("候选内容已停止使用，未重新保存。");
  const assertPolicy = () => { assertNoteUnderstandingCard(action, store); context.assertCurrent?.(); if (policy(store) !== baselinePolicy) throw new Error("保存期间资料权限变化，理解候选未完成保存。"); };
  const guard = Object.assign(async () => { assertPolicy(); if (byteHash(await source(store, payload.path)) !== payload.contentHash) throw new Error("原文版本已变化，旧理解候选未保存。"); assertPolicy(); }, { assertPolicy });
  await guard(); return guard;
}
export async function executeNoteUnderstanding(action: AgentActionSuggestion, context: ToolExecutionContext): Promise<{ output: string }> {
  const document = await context.store.readPersonalMemories();
  if (hash(document[personalMemoryReadSnapshot]?.raw) !== action.noteUnderstandingRevision) throw new Error("个人记忆变化，请重新核对候选卡。");
  const incoming = candidates(action.noteUnderstanding!, new Date().toISOString()); let records = document.records;
  for (const record of incoming) { if (findMemorySuppression(records, record.content)) throw new Error("这段理解已停止使用，不会重新生成。"); records = upsertPersonalMemoryRecord(records, record); }
  if (records !== document.records) await context.store.writePersonalMemories({ ...document, records });
  const after = await context.store.readPersonalMemories();
  if (incoming.some(item => !after.records.some(record => record.id === item.id && record.content === item.content && record.sourceBinding?.dependenciesHash === item.sourceBinding?.dependenciesHash))) throw new Error("理解候选保存后校验失败。");
  return { output: records === document.records ? "同一原文版本的理解已存在，未重复保存或改变确认状态。" : `已核验保存${incoming.length}条理解候选，尚未成为本人事实；原笔记未修改。` };
}
export async function prepareVersionedMemoryReview(action: AgentActionSuggestion, record: PersonalMemoryRecord, context: ToolExecutionContext): Promise<AgentActionSuggestion> {
  if (!record.sourceBinding || action.memoryDecision === "forget") return action;
  context.assertCurrent?.();
  await assertNoPending(context.store);
  await (await import("./personalMemorySources")).assertPersonalMemoryDependencies(record, context.store);
  action.memorySourceDependenciesHash = record.sourceBinding.dependenciesHash;
  action.memoryReviewedContent = record.content;
  action.content = [`待确认理解：${action.memoryDecision === "correct" ? action.correctedMemoryContent : record.content}`,
    ...record.sourceRefs.filter(ref => ref.contentHash).map(ref => `原文：${ref.path}\n\n笔记日期：${ref.observedDate ?? "未知"}；事件日期：未核对\n\n原文摘录：\n${ref.excerpt ?? "旧候选未保存摘录，请先打开原文核对"}\n\n固定来源版本：${ref.contentHash}`),
    "这是对上述理解是否符合本人的单独确认。原文可能含引用或暂时想法；未核对的推断不代表稳定特征。"].join("\n\n");
  context.assertCurrent?.(); return register(action, context);
}
export async function prepareVersionedMemoryReviewGuard(action: AgentActionSuggestion, context: ToolExecutionContext): Promise<MemorySourceWriteGuard> {
  const store = context.store; assertNoteUnderstandingCard(action, store); const baselinePolicy = policy(store);
  const record = (await store.readPersonalMemories()).records.find(item => item.id === action.memoryId);
  if (!record || record.sourceBinding?.dependenciesHash !== action.memorySourceDependenciesHash) throw new Error("理解候选来源版本变化，请重新核对。");
  const assertPolicy = () => { assertNoteUnderstandingCard(action, store); context.assertCurrent?.(); if (policy(store) !== baselinePolicy) throw new Error("确认期间资料权限变化，旧理解未启用。"); };
  const guard = Object.assign(async () => { assertPolicy(); await (await import("./personalMemorySources")).assertPersonalMemoryDependencies(record, store); assertPolicy(); }, { assertPolicy });
  await guard(); return guard;
}
export const NOTE_UNDERSTANDING_TOOL: LifeOpsToolDefinition = {
  name: "propose_note_understanding", safety: "ui-confirm", description: "从选定原文提出1至3条理解候选。先inspect读取，沿用sourceToken/path及逐字excerpt。点击仅存candidate，事实须另行审查确认；不改原文。",
  parameters: { type: "object", additionalProperties: false, properties: { sourceToken: { type: "string" }, path: { type: "string" }, candidates: { type: "array", minItems: 1, maxItems: 3,
    items: { type: "object", additionalProperties: false, properties: { kind: { type: "string", enum: [...kinds] }, content: { type: "string" }, excerpt: { type: "string" } }, required: ["kind", "content", "excerpt"] } } }, required: ["path", "candidates"] },
  execute: async () => fail(new Error("理解候选须先生成完整卡，点击后才保存。")),
  prepareConfirmation: async (args, context, request) => { try { return { success: true, output: "已生成原文理解候选卡，尚未保存，也没有启用为本人事实。", actions: [await prepareNoteUnderstanding(args, context, request.operationId)] }; } catch (cause) { return fail(cause); } }
};
