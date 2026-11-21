import { createHash, randomUUID } from "node:crypto";
import { normalizeJournalDate, todayString } from "./date";
import { safeProjectPath } from "./projectContinuity";
import { isVaultPathExcluded } from "./privacy";
import { personalMemoryReadSnapshot } from "./personalMemory";
import type { StoreHost } from "./store/settingsSlice";
import type { AgentActionSuggestion } from "./types";
import type { LifeOpsToolDefinition, ToolExecutionContext } from "./toolRegistry";

export const WEEKLY_REVIEW_VERSION = "weekly-review-v1";
export interface WeeklyReviewQuote { path: string; excerpt: string }
export interface WeeklyReviewHypothesis {
  claim: string; supports: WeeklyReviewQuote[]; counterexamples: WeeklyReviewQuote[]; uncertainties: string[]; question?: string;
}
export interface WeeklyReviewPayload {
  version: typeof WEEKLY_REVIEW_VERSION; startDate: string; endDate: string;
  sources: Array<{ path: string; contentHash: string; documentDate?: string }>;
  hypotheses: WeeklyReviewHypothesis[];
  previous?: { path: string; contentHash: string; feedback: string };
}
type Snapshot = { startDate: string; endDate: string; notes: Array<{ path: string; contentHash: string; documentDate?: string; text: string }>;
  memoryRevision: string; policy: string };
type SourceCapability = { snapshot: Snapshot; assertCurrent: () => void };
type ReviewCapability = SourceCapability & { hash: string; previousRaw?: string; targetRaw: string | null };
const sources = new WeakMap<StoreHost, Map<string, SourceCapability>>(), reviews = new WeakMap<StoreHost, Map<string, ReviewCapability>>();
const hostIds = new WeakMap<StoreHost, string>();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const bytesHash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const policy = (store: StoreHost) => hash({ folders: store.settings.folders, privacy: store.settings.privacy });
const readMemories = async (store: StoreHost) => (await import("./personalMemorySources")).readPersonalMemoryWithSources(store);
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请提供选定日期、原文和可核对的回顾内容。"); return value as Record<string, unknown>; }
function keys(value: Record<string, unknown>, allowed: string[]) { if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("周回顾包含不支持的字段，请重新核对。"); }
function text(value: unknown, max: number): string { if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new Error("回顾文字为空或过长，请缩小范围。"); return value.trim(); }
function date(value: unknown, baseDate: string): string {
  const day = typeof value === "string" ? normalizeJournalDate(value, baseDate) : "";
  if (!day) throw Error("请选择有效的开始和结束日期。");
  return day;
}
export function weeklyReviewDates(start: unknown, end: unknown): { startDate: string; endDate: string } {
  const today = todayString();
  const startDate = date(start, today), endDate = date(end, today), days = (Date.parse(endDate) - Date.parse(startDate)) / 86400000;
  if (days < 0 || days > 6) throw new Error("每次周回顾选择一至七天，不会拼接日期冒充长期观察。");
  return { startDate, endDate };
}
export interface SelectedWeeklyReviewRequest { startDate: string; endDate: string; paths: string[] }
/** The picker names its whole read scope. Do not silently broaden that scope
 * through retrieval, history or a model-chosen source list. Malformed picker
 * requests fail closed; ordinary/quoted discussion keeps the normal route. */
export function selectedWeeklyReviewRequest(message: string): SelectedWeeklyReviewRequest | undefined {
  const header = /^请对\s*(\d{4}-\d{2}-\d{2})\s*至\s*(\d{4}-\d{2}-\d{2})\s*做周回顾[。，,]\s*只读取这些原始笔记[：:]/u.exec(message.trim());
  if (!header) return undefined;
  const tail = message.trim().slice(header[0].length);
  if (!/^\s*\r?\n/u.test(tail)) throw new Error("请重新选择一至六篇明确的周回顾原文。");
  const lines = tail.trimStart().split(/\r?\n/u), selected: string[] = [];
  for (const line of lines) {
    const item = /^- (.+)$/u.exec(line);
    if (!item) break;
    selected.push(item[1]);
  }
  const period = weeklyReviewDates(header[1], header[2]), selectedPaths = paths(selected);
  if (selectedPaths.some(path => !safeProjectPath(path) || !path.endsWith(".md"))) throw new Error("周回顾原文路径无法核对，请重新选择。");
  return { ...period, paths: selectedPaths };
}
export function matchesSelectedWeeklyReviewRead(request: SelectedWeeklyReviewRequest, call: { name: string; arguments: Record<string, unknown> }): boolean {
  const args = call.arguments;
  return call.name === "inspect_weekly_review_sources" && Object.keys(args).length === 3
    && args.startDate === request.startDate && args.endDate === request.endDate && Array.isArray(args.paths)
    && args.paths.length === request.paths.length && args.paths.every(path => typeof path === "string")
    && JSON.stringify([...args.paths].sort()) === JSON.stringify(request.paths);
}
export function weeklyReviewDocumentDate(path: string): string | undefined {
  const value = /^(\d{4}-\d{2}-\d{2})(?:早|晚)?\.md$/.exec(path.split("/").at(-1) ?? "")?.[1];
  if (!value) return undefined; try { return date(value, todayString()); } catch { return undefined; }
}
export function allowedWeeklyReviewSource(store: StoreHost, path: string): boolean {
  const root = store.settings.folders.aiReports;
  return safeProjectPath(path) && path.endsWith(".md") && store.isManagedSourcePath(path) && !!store.getFile(path)
    && !isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes) && path !== root && !path.startsWith(`${root}/`);
}
function paths(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 6) throw new Error("请明确选择一至六篇原始笔记。");
  const result = value.map(path => text(path, 300)); if (new Set(result).size !== result.length) throw new Error("原文路径重复，不能把一份记录算作多个依据。"); return result.sort();
}
async function readNote(store: StoreHost, path: string): Promise<string> {
  if (!allowedWeeklyReviewSource(store, path)) throw new Error("回顾原文缺失、被排除或不是允许范围的原始笔记。");
  const raw = await store.readPath(path);
  if (!allowedWeeklyReviewSource(store, path) || Buffer.byteLength(raw, "utf8") > 32768) throw new Error("原文发生变化或过长，请选择更小的笔记范围。"); return raw;
}
async function noPending(store: StoreHost) { if (await (await import("./dataFoundation/factOperation")).hasPendingFactOperation(store)) throw new Error("保存尚未结束，请等待或检查并恢复未完成操作，再整理周回顾。"); }
async function collect(args: Record<string, unknown>, context: ToolExecutionContext): Promise<Snapshot> {
  keys(args, ["startDate", "endDate", "paths"]); const period = weeklyReviewDates(args.startDate, args.endDate), selected = paths(args.paths), store = context.store;
  context.assertCurrent?.(); await noPending(store); const baseline = policy(store);

  const memory = await readMemories(store), filter = (await import("./personalMemoryContext")).createPersonalMemoryContextFilter(memory.records), memoryRevision = hash(memory[personalMemoryReadSnapshot]?.raw);
  const notes: Snapshot["notes"] = [];
  for (const path of selected) {
    const raw = await readNote(store, path), documentDate = weeklyReviewDocumentDate(path);
    if (documentDate && (documentDate < period.startDate || documentDate > period.endDate)) throw new Error("笔记日期不在选择范围，不能混入别周记录。");
    if (filter(raw) !== raw) throw new Error("所选原文含已遗忘、更正或失效依据，未重新提供旧内容。");
    notes.push({ path, contentHash: bytesHash(raw), documentDate, text: raw });
  }
  if (notes.reduce((n, item) => n + Buffer.byteLength(item.text, "utf8"), 0) > 131072) throw new Error("本次原文总量过大，请缩小选择。");
  await noPending(store);
  if (policy(store) !== baseline) throw new Error("收集期间记忆或权限变化，未提供旧资料。");
  context.assertCurrent?.(); selected.forEach(path => { if (!allowedWeeklyReviewSource(store, path)) throw new Error("原文范围已经变化。"); });
  return { ...period, notes, memoryRevision, policy: baseline };
}
function boundedSet<T>(registry: WeakMap<StoreHost, Map<string, T>>, store: StoreHost, id: string, value: T) {
  let map = registry.get(store); if (!map) { map = new Map(); registry.set(store, map); } map.set(id, value);
  while (map.size > 64) map.delete(map.keys().next().value!);
}
export async function weeklyReviewQueryRevision(store: StoreHost, args: Record<string, unknown>): Promise<string> {
  let id = hostIds.get(store); if (!id) { id = randomUUID(); hostIds.set(store, id); }
  return hash({ host: id, snapshot: await collect(args, { store, refreshViews: async () => {} }) });
}
export async function assertWeeklyQueryResult(output: string, store: StoreHost) {
  const result = object(JSON.parse(output)), cap = typeof result.sourceToken === "string" ? sources.get(store)?.get(result.sourceToken) : undefined;
  if (!cap) throw new Error("这次原文读取已过期，请重新读取，不会使用旧缓存。");
  keys(result, ["sourceToken", "startDate", "endDate", "notes", "eventDates", "status"]);
  if (hash({ startDate: result.startDate, endDate: result.endDate, notes: result.notes }) !== hash({ startDate: cap.snapshot.startDate, endDate: cap.snapshot.endDate, notes: cap.snapshot.notes })
    || result.eventDates !== "未核对" || result.status !== "只读原文；未生成或保存回顾，不确认记忆") throw new Error("原文读取结果与固定来源不符，不会使用旧缓存。");
  cap.assertCurrent(); await noPending(store); await assertSnapshot(cap, store); cap.assertCurrent();
}
async function assertSnapshot(cap: SourceCapability, store: StoreHost): Promise<void> {
  cap.assertCurrent();

  for (const note of cap.snapshot.notes) if (bytesHash(await readNote(store, note.path)) !== note.contentHash) throw new Error("原文版本已经变化，旧周回顾不能继续保存。");
  if (hash((await store.readPersonalMemories())[personalMemoryReadSnapshot]?.raw) !== cap.snapshot.memoryRevision || policy(store) !== cap.snapshot.policy) throw new Error("个人记忆或资料权限变化，请重新整理周回顾。");
  cap.assertCurrent(); cap.snapshot.notes.forEach(note => { if (!allowedWeeklyReviewSource(store, note.path)) throw new Error("回顾来源不可使用。"); });
}
function cardHash(action: AgentActionSuggestion) { return hash({ id: action.id, type: action.type, title: action.title, description: action.description, content: action.content, date: action.date, payload: action.weeklyReview, path: action.weeklyReviewPath }); }
export function assertWeeklyReviewCard(action: AgentActionSuggestion, store: StoreHost): ReviewCapability {
  const cap = reviews.get(store)?.get(action.id); if (!cap || cap.hash !== cardHash(action) || action.weeklyReviewHash !== cap.hash) throw new Error("周回顾确认卡已失效或被修改，请重新生成；未保存。"); cap.assertCurrent(); return cap;
}
function escape(value: string) { return value.replace(/[\\`*_{}\[\]()<>#!|]/g, "\\$&"); }
function quote(item: WeeklyReviewQuote) { return `- 原文 ${escape(item.path)}：\n${item.excerpt.split("\n").map(line => `  > ${escape(line)}`).join("\n")}`; }
export function weeklyReviewMarkdown(payload: WeeklyReviewPayload): string {
  const dates = new Set(payload.sources.flatMap(source => source.documentDate ? [source.documentDate] : [])), missing: string[] = [];
  for (let d = Date.parse(payload.startDate); d <= Date.parse(payload.endDate); d += 86400000) { const value = new Date(d).toISOString().slice(0, 10); if (!dates.has(value)) missing.push(value); }
  const excerpts = payload.hypotheses.flatMap(item => [...item.supports, ...item.counterexamples].map(quote => quote.excerpt)), duplicates = new Set(excerpts).size < excerpts.length;
  return [`# 周回顾 ${payload.startDate} 至 ${payload.endDate}`, "> 待你核对的回顾草稿。保存不等于确认记忆、完成任务或证明趋势。",
    "## 记录范围", ...payload.sources.map(source => `- ${escape(source.path)}；笔记日期：${source.documentDate ?? "未知"}；事件日期：未核对\n  来源版本：${source.contentHash}`),
    `未找到有日期记录的日子：${missing.join("、") || "所选每个日期均有笔记"}。这只说明选定资料的覆盖，不能判断当日是否做过某事。`,
    "笔记日期不是事件日期；引用他人或暂时想法不能直接当作本人事实。不同笔记可能描述同一事件，不能据条数认定趋势。",
    ...(duplicates ? ["本稿含相同摘录，重复出现不算多个独立事件。"] : []),
    ...payload.hypotheses.flatMap((item, index) => [`## ${index + 1}. 待核对假设：${escape(item.claim)}`, "### 支持这一想法的记录", ...item.supports.map(quote), "### 反例或限制",
      ...(item.counterexamples.length ? item.counterexamples.map(quote) : ["本次选定资料未提供反例；这不等于没有反例，也不能据此确认趋势。"]),
      "### 仍不确定的地方", ...item.uncertainties.map(value => `- ${escape(value)}`), ...(item.question ? [`下次可以核对：${escape(item.question)}`] : [])]),
    ...(payload.previous ? ["## 本人更正反馈", escape(payload.previous.feedback), `前稿：${escape(payload.previous.path)}\n前稿版本：${payload.previous.contentHash}`, "前稿原样保留，本稿单独保存。更正回顾不会自动改记忆、任务或原文。"] : [])].join("\n\n");
}
function savedMarkdown(payload: WeeklyReviewPayload) { return `<!-- lifeops-weekly-review-v1:${Buffer.from(JSON.stringify(payload), "utf8").toString("base64")} -->\n\n${weeklyReviewMarkdown(payload)}\n`; }
function reviewRoot(store: StoreHost) { return store.path(store.settings.folders.aiReports, "周回顾"); }
function validatePreviousPath(store: StoreHost, path: string) { if (!safeProjectPath(path) || !path.startsWith(`${reviewRoot(store)}/`) || !path.endsWith(".md") || isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes)) throw new Error("请选择允许范围内已保存的周回顾草稿。"); }
function hypotheses(value: unknown, cap: SourceCapability): WeeklyReviewHypothesis[] {
  if (!Array.isArray(value) || !value.length || value.length > 3) throw new Error("每次提供一至三条待核对假设。");
  const refs = (value: unknown, required: boolean): WeeklyReviewQuote[] => {
    if (!Array.isArray(value) || value.length > 6 || required && !value.length) throw new Error("每个假设须有原文支持，反例最多六条。");
    const result = value.map(value => { const item = object(value); keys(item, ["path", "excerpt"]); const path = text(item.path, 300), excerpt = text(item.excerpt, 1200), note = cap.snapshot.notes.find(note => note.path === path);
      if (!note || !note.text.includes(excerpt)) throw new Error("回顾摘录必须逐字对应本次固定原文，不能用改写或旧来源充当依据。"); return { path, excerpt }; });
    if (new Set(result.map(value => hash(value))).size !== result.length) throw new Error("摘录重复，不能重复计作依据。"); return result;
  };
  return value.map(value => { const item = object(value); keys(item, ["claim", "supports", "counterexamples", "uncertainties", "question"]);
    if (!Array.isArray(item.uncertainties) || !item.uncertainties.length || item.uncertainties.length > 3) throw new Error("每条假设须写明仍不确定的地方。");
    const supports = refs(item.supports, true), counterexamples = refs(item.counterexamples, false);
    if (supports.some(item => counterexamples.some(other => hash(item) === hash(other)))) throw new Error("相同摘录不能同时充当支持与反例，请说明具体限制。");
    return { claim: text(item.claim, 500), supports, counterexamples, uncertainties: item.uncertainties.map(item => text(item, 500)), ...(item.question === undefined ? {} : { question: text(item.question, 300) }) };
  });
}
export async function prepareWeeklyReview(args: Record<string, unknown>, context: ToolExecutionContext, id: string, userMessage: string): Promise<AgentActionSuggestion> {
  keys(args, ["sourceToken", "hypotheses", "previousDraftPath", "feedback"]); const store = context.store, token = text(args.sourceToken, 100), cap = sources.get(store)?.get(token);
  if (!cap) throw new Error("请先读取本次选定原文，不能用旧对话猜测周回顾。"); context.assertCurrent?.(); cap.assertCurrent(); await noPending(store); await assertSnapshot(cap, store);
  const payload: WeeklyReviewPayload = { version: WEEKLY_REVIEW_VERSION, startDate: cap.snapshot.startDate, endDate: cap.snapshot.endDate, sources: cap.snapshot.notes.map(({ text: _text, ...source }) => source), hypotheses: hypotheses(args.hypotheses, cap) };
  let previousRaw: string | undefined;

  if (args.previousDraftPath !== undefined || args.feedback !== undefined) {
    const path = text(args.previousDraftPath, 300), feedback = text(args.feedback, 1200); validatePreviousPath(store, path);
    if (!userMessage.includes(feedback)) throw new Error("更正反馈必须是用户本轮明确给出的原话，不能由模型代替本人编造。");
    if (!store.getFile(path)) throw new Error("前稿不存在，未创建伪造历史。"); previousRaw = await store.readPath(path);
    const encoded = /^<!-- lifeops-weekly-review-v1:([A-Za-z0-9+/=]+) -->\n/.exec(previousRaw)?.[1]; if (!encoded || encoded.length > 262144) throw new Error("前稿格式不支持，不会覆盖手写内容。");
    const previous = object(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")));
    if (previous.version !== WEEKLY_REVIEW_VERSION || previous.startDate !== payload.startDate || previous.endDate !== payload.endDate) throw new Error("前稿日期范围或格式不同，请单独核对。");
    payload.previous = { path, contentHash: bytesHash(previousRaw), feedback };
  }
  const memory = await readMemories(store), filter = (await import("./personalMemoryContext")).createPersonalMemoryContextFilter(memory.records), rendered = weeklyReviewMarkdown(payload);
  const unescaped = payload.hypotheses.flatMap(item => [item.claim, ...item.supports.map(ref => ref.excerpt), ...item.counterexamples.map(ref => ref.excerpt), ...item.uncertainties, item.question ?? ""]).concat(payload.previous?.feedback ?? "").join("\n\n");
  if (filter(unescaped) !== unescaped || filter(rendered) !== rendered) throw new Error("回顾包含已遗忘、更正或失效内容，不会重新保存。");
  const path = store.path(reviewRoot(store), `${payload.startDate}-至-${payload.endDate}-${hash(payload).slice(0, 12)}.md`);
  if (isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes)) throw new Error("回顾输出位置已排除，未保存。");
  const targetRaw = store.getFile(path) ? await store.readPath(path) : null;
  await noPending(store); await assertSnapshot(cap, store);
  if (payload.previous && (await store.readPath(payload.previous.path) !== previousRaw || !store.getFile(payload.previous.path))) throw new Error("前稿已变化，请重新整理更正稿。");
  context.assertCurrent?.(); cap.assertCurrent();
  const action: AgentActionSuggestion = { id: `proposal:${id}:0`, type: "weekly_review", title: payload.previous ? "核对周回顾更正稿" : "核对周回顾草稿", description: "核对支持、反例和未知信息；点击只保存回顾，不确认记忆或改任务。", content: rendered, date: todayString(), weeklyReview: payload, weeklyReviewPath: path };
  action.weeklyReviewHash = cardHash(action);
  const old = reviews.get(store)?.get(action.id); if (old && old.hash !== action.weeklyReviewHash) throw new Error("周回顾卡标识已用于另一内容，请重新提出，不会替换旧授权。");
  boundedSet(reviews, store, action.id, { ...cap, hash: action.weeklyReviewHash, previousRaw, targetRaw,
    assertCurrent: () => { cap.assertCurrent(); context.assertCurrent?.(); } }); return structuredClone(action);
}
export async function assertWeeklyReviewCurrent(action: AgentActionSuggestion, context: ToolExecutionContext) {
  const cap = assertWeeklyReviewCard(action, context.store);

  await assertSnapshot(cap, context.store);
  if (action.weeklyReview?.previous) { validatePreviousPath(context.store, action.weeklyReview.previous.path); if (!context.store.getFile(action.weeklyReview.previous.path) || await context.store.readPath(action.weeklyReview.previous.path) !== cap.previousRaw) throw new Error("前稿已有变化，旧更正卡未保存。"); }
  context.assertCurrent?.(); cap.assertCurrent(); if (policy(context.store) !== cap.snapshot.policy) throw new Error("资料权限已变化，旧回顾未保存。");
}
export async function assertWeeklyReviewSaved(action: AgentActionSuggestion, context: ToolExecutionContext): Promise<void> {
  const cap = assertWeeklyReviewCard(action, context.store), path = action.weeklyReviewPath!;


  const raw = context.store.getFile(path) ? await context.store.readPath(path) : null;
  if (raw !== savedMarkdown(action.weeklyReview!)) throw new Error("已保存周回顾有后来修改，请打开核对，不能重复声称旧稿已保存。");
  await assertWeeklyReviewCurrent(action, context); context.assertCurrent?.(); cap.assertCurrent();
  if (await context.store.readPath(path) !== raw) throw new Error("已保存周回顾有后来修改，请打开核对。");
}
export async function prepareWeeklyReviewGuard(action: AgentActionSuggestion, context: ToolExecutionContext) {
  const cap = assertWeeklyReviewCard(action, context.store); await assertWeeklyReviewCurrent(action, context);
  const current = context.store.getFile(action.weeklyReviewPath!) ? await context.store.readPath(action.weeklyReviewPath!) : null;
  if (current !== cap.targetRaw) throw new Error("目标草稿已变化，不能覆盖后来手写内容。");
  const assertPolicy = () => { assertWeeklyReviewCard(action, context.store); context.assertCurrent?.(); if (policy(context.store) !== cap.snapshot.policy) throw new Error("周回顾保存期间权限变化，已停止保存。"); };
  return Object.assign(async () => { assertPolicy(); await assertWeeklyReviewCurrent(action, context); assertPolicy(); }, { assertPolicy });
}
export async function executeWeeklyReview(action: AgentActionSuggestion, context: ToolExecutionContext): Promise<{ output: string }> {
  const owner = (await import("./dataFoundation/factOperation")).guardedOperationOwner(context.store) ?? context.store, cap = assertWeeklyReviewCard(action, owner), path = action.weeklyReviewPath!, raw = savedMarkdown(action.weeklyReview!);
  if (hash(context.store.settings.privacy) !== hash(owner.settings.privacy)) throw new Error("权限快照已经变化，未保存周回顾。");
  const existing = context.store.getFile(path) ? await context.store.readPath(path) : null;
  if (existing !== cap.targetRaw && existing !== raw || existing !== null && existing !== raw) throw new Error("同名草稿已有后来内容，不会覆盖；请重新核对。");
  if (existing === null) await context.store.writeFile(path, raw);
  if (await context.store.readPath(path) !== raw) throw new Error("周回顾草稿读回失败。");
  return { output: `周回顾草稿已核验保存：${path}。原文、记忆、任务与前稿保持；假设仍待核对。` };
}
const quoteSchema = { type: "array", maxItems: 6, items: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, excerpt: { type: "string" } }, required: ["path", "excerpt"] } };
export const WEEKLY_REVIEW_TOOLS: LifeOpsToolDefinition[] = [
  { name: "inspect_weekly_review_sources", safety: "safe", description: "只读1至6篇选定原始笔记、1至7天日期范围。跨周比较用get_summaries。先查询准确paths，返回固定原文和sourceToken；笔记日期与事件日期分开。",
    parameters: { type: "object", additionalProperties: false, properties: { startDate: { type: "string" }, endDate: { type: "string" }, paths: { type: "array", minItems: 1, maxItems: 6, items: { type: "string" } } }, required: ["startDate", "endDate", "paths"] },
    execute: async (args, context) => { const snapshot = await collect(args, context), token = randomUUID(); boundedSet(sources, context.store, token, { snapshot, assertCurrent: () => { context.assertCurrent?.(); if (policy(context.store) !== snapshot.policy) throw new Error("读取权限已变化，请重新选择原文。"); } }); return { success: true, output: JSON.stringify({ sourceToken: token, ...snapshot, memoryRevision: undefined, policy: undefined, eventDates: "未核对", status: "只读原文；未生成或保存回顾，不确认记忆" }), actions: [] }; } },
  { name: "propose_weekly_review", safety: "ui-confirm", description: "用当前sourceToken提出1至3条周回顾假设。逐字摘录支持/反例，保留不确定性；重复记录不等于独立事件。点击只存草稿；更正另存版本保留前稿。",
    parameters: { type: "object", additionalProperties: false, properties: { sourceToken: { type: "string" }, hypotheses: { type: "array", minItems: 1, maxItems: 3, items: { type: "object", additionalProperties: false, properties: { claim: { type: "string" }, supports: { ...quoteSchema, minItems: 1 }, counterexamples: quoteSchema, uncertainties: { type: "array", minItems: 1, maxItems: 3, items: { type: "string" } }, question: { type: "string" } }, required: ["claim", "supports", "counterexamples", "uncertainties"] } }, previousDraftPath: { type: "string" }, feedback: { type: "string" } }, required: ["sourceToken", "hypotheses"] },
    prepareConfirmation: async (args, context, request) => ({ success: true, output: "周回顾草稿确认卡已生成，尚未保存；假设待核对，不改变记忆或任务。", actions: [await prepareWeeklyReview(args, context, request.operationId, request.userMessage ?? "")] }),
    execute: async () => ({ success: false, output: "请在完整周回顾卡上点击确认，未保存。", actions: [] }) }
];
