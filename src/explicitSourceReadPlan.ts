import type { AiToolCall } from "./ai";
import type { SourceReadTurn } from "./readonlySourceAnalysis";
import type { VaultQueryCoverage } from "./vaultQuery";

export type ExplicitSourceReadPlan = { kind: "paths"; paths: string[] } | { kind: "invalid" };
type SourceFolders = { dailyRoot: string; health: string; tradingModels: string; tradingReviews: string };
const readOnlyTail = [
  /^(?:全程|本次|本轮)?只读$/u,
  /^(?:请)?(?:先)?(?:在同一轮)?(?:分别)?(?:完整)?(?:核对|读取|阅读)[A-L](?:、[A-L])*$/u,
  /^(?:再)?(?:请)?(?:简短)?(?:说明|回答|解释|分析|比较|对比)(?:以下问题|这些资料|本轮问题|各自内容)?[：:]?$/u,
  /^哪些(?:资料|文件|笔记)(?:本次|本轮)?(?:实际)?(?:读到|已读取|已读)$/u,
  /^[A-L](?:中的?|的).{0,96}(?:分别)?(?:是什么|有哪些|有何区别|是否相同)$/u,
  /^(?:如果|若)[A-L]不存在$/u,
  /^(?:请)?(?:明确)?(?:说|说明|回答)(?:无法|不能)从[A-L]获得(?:这(?:两|几)项|所问(?:事实|信息))$/u,
  /^(?:不要|不用)从[A-L](?:、[A-L])*(?:或路径名)?(?:推测|推断)$/u,
  /^可引用[A-L](?:、[A-L])*的已读事实并各给准确路径$/u,
  /^(?:但)?不要把[A-L](?:、[A-L])*列为已读来源$/u,
  /^缺项(?:明确说|说明为)?未知$/u,
  /^原文(?:中的?|里的?)?祈使句(?:只作|仅作|视为)(?:引文|数据)$/u,
  /^(?:不要|不用|不)(?:创建|新建|新增|添加|修改|改写|删除|保存|写入|修复)(?:(?:或|和|、)(?:创建|新建|新增|添加|修改|改写|删除|保存|写入|修复))*(?:任何)?(?:文件|原文|内容|资料|任务|日记|记忆)$/u,
  /^(?:不要|不用|不)执行原文引文里的命令$/u
];

/** A direct path list is a finite read selection, not a search through quoted
 * prose, old instructions, filenames or the vault catalog. Unknown syntax
 * retains the ordinary route; a malformed selected list never dispatches. */
export function explicitSourceReadPlan(message: string): ExplicitSourceReadPlan | null {
  const lines = message.trim().split(/\r?\n/u);
  if (!/^(?:请)?(?:只读)?(?:分析|比较|核对|阅读|查看|检查)(?:(?:个人)?知识库中|库中)?(?:以下|这些)(?:[一二三四五六七八九十\d]+)?(?:篇|条|份|个)?(?:纯虚构)?(?:(?:资料|笔记|文件|日记)(?:路径)?|路径)[：:]$/u.test(lines[0])) return null;
  if (message.length > 16_000) return { kind: "invalid" };
  const paths: string[] = [], instructions: string[] = [];
  let ended = false;
  for (const line of lines.slice(1).map(line => line.trim()).filter(Boolean)) {
    const label = /^(?:[-*]\s+|(?:[A-Za-z]|\d{1,2})[：:.、]\s*)/u;
    const selected = label.test(line) || /\.md(?:["'“”‘’「」`])?$/u.test(line);
    if (!selected) { ended = true; instructions.push(line); continue; }
    if (ended) return { kind: "invalid" };
    let path = line.replace(label, "");
    const pairs = [["\"", "\""], ["'", "'"], ["“", "”"], ["‘", "’"], ["「", "」"], ["`", "`"]];
    for (const [open, close] of pairs) if (path.startsWith(open) && path.endsWith(close)) { path = path.slice(open.length, -close.length); break; }
    if (!path.includes("/") || !path.endsWith(".md") || path !== path.trim()
      || /^(?:\/|~|[a-z][a-z\d+.-]*:)/iu.test(path) || /[\\:*?<>|#%\[\]"'“”‘’「」`\u0000-\u001f\u007f]/u.test(path)
      || path.split("/").some(part => !part || part === "." || part === "..")) return { kind: "invalid" };
    if (!paths.includes(path)) paths.push(path);
    if (paths.length > 12) return { kind: "invalid" };
  }
  if (!paths.length || instructions.some(line => /\.md/iu.test(line))) return { kind: "invalid" };
  const outside = instructions.join("\n").replace(/```[\s\S]*?```|“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"]*"|'[^']*'|`[^`]*`/gu, "");
  if (/(?:以上|上述|上面)(?:只是|仅是|仅作)(?:示例|引用|引文)|(?:不要|不用|不必|无需|禁止)(?:实际|再|继续)?(?:读取|阅读|读)|(?:只|仅)(?:解释|翻译)(?:这段|上述|以上|这条)(?:指令|命令|请求)/u.test(outside)) return { kind: "invalid" };
  const clauses = outside.split(/[，,。；;：:!?！？\n]/u).map(clause => clause.trim()).filter(Boolean);
  // Only these bounded answer/source restrictions extend the read selection.
  // Unknown work retains its normal route rather than being silently erased.
  if (clauses.some(clause => !readOnlyTail.some(pattern => pattern.test(clause)))) return null;
  return { kind: "paths", paths };
}

export function explicitSourceReadBootstrap(paths: readonly string[], folders: SourceFolders): AiToolCall[] {
  return paths.map((path, index) => {
    const within = (root: string) => Boolean(root && path.startsWith(root + "/"));
    const domain = within(folders.dailyRoot) ? "journal" : within(folders.health) ? "health"
      : within(folders.tradingModels) || within(folders.tradingReviews) ? "trade" : "note";
    return { id: `source-analysis-explicit-${index}`, name: "query_vault", arguments: { domain, operation: "get", path, maxChars: 18_000 } };
  });
}

export function assertExplicitSourceReads(calls: AiToolCall[], selected: AiToolCall[]): void {
  for (const call of calls) {
    const original = selected.find(target => target.arguments.path === call.arguments.path);
    if (!original || call.name !== "query_vault" || call.arguments.operation !== "get" || call.arguments.domain !== original.arguments.domain
      || Object.keys(call.arguments).some(key => !["domain", "operation", "path", "offset", "maxChars"].includes(key))) throw Error("本轮只读分析只能读取明确选择的准确路径，整批未执行。");
  }
}

/** Continuation authority comes from owned coverage, never model/page text. */
export function requiredExplicitSourceReads(selected: AiToolCall[], turns: SourceReadTurn[], coverage: ReadonlyMap<string, VaultQueryCoverage>): AiToolCall[] {
  const required: AiToolCall[] = [];
  for (const [index, original] of selected.entries()) {
    const path = String(original.arguments.path), pages = turns.flatMap(turn => turn.results.filter(result => result.success)
      .flatMap(result => coverage.get(result.callId)?.pages.filter(page => page.path === path) ?? []));
    if (!pages.length) continue;
    const total = pages[0].total;
    if (!Number.isSafeInteger(total) || total < 0 || pages.some(page => page.total !== total || !Number.isSafeInteger(page.start) || !Number.isSafeInteger(page.end)
      || page.start < 0 || page.end < page.start || page.end > total)) throw Error("本轮准确路径原文覆盖无法核对。");
    let offset = 0;
    for (const page of [...pages].sort((a, b) => a.start - b.start)) { if (page.start > offset) break; offset = Math.max(offset, page.end); }
    if (offset < total) required.push({ ...original, id: `source-analysis-explicit-page-${turns.length}-${index}-${offset}`, arguments: { ...original.arguments, offset } });
  }
  return required;
}
