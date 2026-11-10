import type { AiChatResult, AiToolCall, AiToolResultMessage } from "./ai";
import type { VaultQueryCoverage } from "./vaultQuery";

/** Explicit host allowlist; advertising fewer tools alone is not authorization. */
export const READONLY_SOURCE_TOOL_NAMES = ["query_vault", "query_projects", "query_trading_research", "list_personal_memory_candidates"] as const;
export function requestsRecentJournalAnalysis(message: string): boolean {
  const text = message.replace(/\s+/gu, "");
  // A specified file or day belongs to the requested read plan. A paragraph's
  // "last" position is not permission to fetch a different, newest diary.
  if (/\.(?:md|markdown)(?=$|[^A-Za-z0-9_])/iu.test(text)
    || /\d{4}(?:[-./]|年)\d{1,2}(?:[-./]|月)\d{1,2}|今天|昨天|前天|昨晚|昨夜|今早|昨早|今晚/u.test(text)) return false;
  const journal = "(?:日记|晨间记录|晚间记录)";
  return new RegExp("(?:最近|近期|最新|最后一篇|最后一次(?:写的)?|最后写的|上一次(?:写的)?).{0,24}" + journal, "u").test(text)
    || new RegExp(journal + "(?:的)?(?:最新|最近一篇|上一次|最后一篇|最后一次|最后写的)", "u").test(text);
}
export interface SourceReadTurn { calls: AiToolCall[]; results: AiToolResultMessage[] }

export function requestsExplicitSourceEndpoints(message: string, availablePaths: string[] = []): boolean {
  let instruction = message;
  for (const path of [...new Set(availablePaths)].sort((a, b) => b.length - a.length)) instruction = instruction.split(path).join(" ");
  return /(?:开头|开篇|第一段|首段)/u.test(instruction) && /(?:最后一段|末段|尾段|尾部|末尾|结尾)/u.test(instruction)
    && /\.md(?=$|[^A-Za-z0-9_./\\-])/u.test(message);
}

function mentionsCompleteSourcePath(message: string, path: string): boolean {
  const position = message.indexOf(path);
  if (!path.endsWith(".md") || position < 0 || /[A-Za-z0-9_./\\-]/u.test(message.slice(position + path.length, position + path.length + 1))) return false;
  const prefix = message.slice(0, position);
  // A slash earlier in the same literal can precede a Chinese or spaced folder
  // suffix. Whitespace alone is therefore not a full-path boundary.
  if (/[/\\][^`"'“”‘’「」【】()（）:：;；,，。!?！？\n]*$/u.test(prefix)) return false;
  if (position === 0) return true;
  // Match the complete finite introduction, rather than a verb embedded in an
  // unknown directory name or inside a larger quoted path literal.
  const introduction = prefix.trimEnd().replace(/[`"'“‘「【(（]$/u, "").trimEnd().replace(/[:：]$/u, "").trim();
  return introduction === "" || /^(?:请)?(?:只读)?(?:分析|比较|核对|阅读|查看|看一下|看看|检查)(?:笔记|文件|资料|日记)?$/u.test(introduction);
}

export function requestedSourceEndpointPath(message: string, availablePaths: string[]): string | undefined {
  if (!requestsExplicitSourceEndpoints(message, availablePaths) || [...message.matchAll(/\.md(?=$|[^A-Za-z0-9_./\\-])/gu)].length !== 1) return;
  const matches = [...new Set(availablePaths)].filter(path => mentionsCompleteSourcePath(message, path));
  return matches.length === 1 ? matches[0] : undefined;
}

/** A continuation is derived only from successful host-owned coverage, never
 * from a page header or instruction in a model/source response. */
export function requiredSourceEndpointReads(message: string, turns: SourceReadTurn[], coverage: ReadonlyMap<string, VaultQueryCoverage>, requestedPath?: string): AiToolCall[] {
  if (!requestedPath) return [];
  const instruction = message.split(requestedPath).join(" ");
  if (!/(?:开头|开篇|第一段|首段)/u.test(instruction) || !/(?:最后一段|末段|尾段|尾部|末尾|结尾)/u.test(instruction)
    || /(?:不要|不用|无需|不必|别|不)(?:再|继续)?(?:读取|阅读|补读|读|看)(?:正文的)?(?:尾部|末段|最后一段|尾段|结尾|末尾|全文)/u.test(instruction)) return [];
  const candidates = new Map<string, { domain: string; pages: VaultQueryCoverage["pages"] }>();
  for (const turn of turns) for (const call of turn.calls) {
    if (call.name !== "query_vault" || call.arguments.operation !== "get" || !["journal", "note"].includes(String(call.arguments.domain)) || typeof call.arguments.path !== "string") continue;
    if (!turn.results.some(result => result.callId === call.id && result.success)) continue;
    const path = call.arguments.path.trim().replace(/\\/g, "/");
    if (path !== requestedPath || !mentionsCompleteSourcePath(message, path)) continue;
    const pages = coverage.get(call.id!)?.pages.filter(page => page.path === path) ?? [];
    if (!pages.length) continue;
    const existing = candidates.get(path); candidates.set(path, { domain: String(call.arguments.domain), pages: [...(existing?.pages ?? []), ...pages] });
  }
  // Do not invent an ordering or expand an ambiguous multi-file comparison.
  if (candidates.size !== 1) return [];
  const [path, { domain, pages }] = [...candidates][0], total = pages[0].total;
  if (!Number.isSafeInteger(total) || total < 0 || pages.some(page => page.total !== total || !Number.isSafeInteger(page.start) || !Number.isSafeInteger(page.end) || page.start < 0 || page.end < page.start || page.end > total)) throw Error("首尾分析的本轮原文覆盖无法核对。");
  if (total === 0) return [];
  let offset = 0;
  for (const page of [...pages].sort((a, b) => a.start - b.start)) { if (page.start > offset) break; offset = Math.max(offset, page.end); }
  if (offset >= total) return [];
  return [{ id: `source-analysis-required-page-${turns.length}-${offset}`, name: "query_vault", arguments: { domain, operation: "get", path, offset, maxChars: 18_000 } }];
}
export interface SourceAnalysisState {
  turns: SourceReadTurn[];
  readRounds: number;
  calls: number;
  chars: number;
  bootstrapStarted: boolean;
  bootstrapCompleted: boolean;
  reading: boolean;
  readInterrupted: boolean;
  stoppedReply?: string;
}
export const newSourceAnalysisState = (): SourceAnalysisState => ({ turns: [], readRounds: 0, calls: 0, chars: 0, bootstrapStarted: false, bootstrapCompleted: false, reading: false, readInterrupted: false });

/** Bounded source acquisition, never an action loop. All receipts are retained
 * verbatim, not converted to another clipped retrieval summary. */
export async function runReadonlySourceAnalysis(input: {
  state: SourceAnalysisState;
  bootstrap: AiToolCall[];
  assertCurrent: () => Promise<void>;
  request: (turns: SourceReadTurn[], canRead: boolean) => Promise<AiChatResult>;
  execute: (calls: AiToolCall[]) => Promise<AiToolResultMessage[]>;
  requiredReads?: () => AiToolCall[];
  stopBeforeRequest?: () => string | undefined;
}): Promise<AiChatResult> {
  const state = input.state, ids = new Set(state.turns.flatMap(turn => turn.calls.map(call => call.id)));
  const stop = (content: string): AiChatResult => {
    state.stoppedReply = content;
    return { content, toolCalls: [] };
  };
  const read = async (requested: AiToolCall[]): Promise<string | undefined> => {
    const calls = structuredClone(requested);
    if (calls.some(call => !READONLY_SOURCE_TOOL_NAMES.some(name => name === call.name))) return "本次是只读分析，AI提出了超出范围的操作，整批未执行；请重新查询。";
    if (calls.some(call => !call.id || ids.has(call.id)) || new Set(calls.map(call => call.id)).size !== calls.length) return "本轮读取编号重复，已停止继续读取，不能把本次当作完整分析。";
    if (state.readRounds >= 4 || state.calls + calls.length > 12 || state.chars >= 72_000) return "本次读取已达到范围上限，尚未完成完整分析。可以缩小日期或资料范围后继续。";
    state.readRounds++; state.calls += calls.length; calls.forEach(call => ids.add(call.id));
    state.reading = true;
    try {
    await input.assertCurrent();
    const results = await input.execute(calls);
    await input.assertCurrent();
    if (results.length !== calls.length || results.some((result, index) => result.callId !== calls[index].id)) throw Error("深度读取回执身份无法核对。");
    const chars = results.reduce((sum, result) => sum + result.output.length, 0);
    if (state.chars + chars > 72_000) return "本次原文超过读取范围上限，尚未完成完整分析；未将截短资料当成完整正文。请缩小日期或资料范围。";
    state.chars += chars;
    state.turns.push({ calls, results: structuredClone(results) });
    if (results.some(result => !result.success)) return "有资料未能安全读取，本次分析未完成；未用其它记录或猜测替代。请稍后重新查询。";
    } catch (error) { state.readInterrupted = true; throw error; }
    finally { state.reading = false; }
  };
  if (!state.bootstrapStarted) {
    state.bootstrapStarted = true;
    if (input.bootstrap.length) { const failure = await read(input.bootstrap); state.bootstrapCompleted = true; if (failure) return stop(failure); }
    else state.bootstrapCompleted = true;
  }
  if (!state.bootstrapCompleted || state.reading || state.readInterrupted) return stop("本次原文读取尚未完成，已停止分析；未用旧检索片段代替。请稍后重新查询。");
  // Four read batches plus a final answer-only request. Model planning text is
  // never published before the host validates the receipts and source scopes.
  for (;;) {
    await input.assertCurrent();
    // Acquire the explicitly requested same-source remainder before asking the
    // model again. An incomplete provider reply must remain terminal and cannot
    // be used as the trigger for a later source read.
    const required = input.requiredReads?.() ?? [];
    if (required.length) {
      const failure = await read(required); if (failure) return stop(failure);
      continue;
    }
    const stopped = input.stopBeforeRequest?.();
    if (stopped) return stop(stopped);
    const canRead = state.readRounds < 4 && state.calls < 12 && state.chars < 72_000;
    const result = await input.request(structuredClone(state.turns), canRead);
    await input.assertCurrent();
    if (!result.toolCalls.length) {
      return result.content ? result : stop("本次没有形成可用分析，未修改您的记录。");
    }
    if (!canRead) return stop("AI仍需补读资料，但本次已达到读取上限，不能把当前内容当作完整分析。请缩小日期或资料范围。" );
    const failure = await read(result.toolCalls); if (failure) return stop(failure);
  }
}
