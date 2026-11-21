import type { TFile } from "obsidian";
import { normalizeJournalDate } from "./date";
import { findJournalFilesForDate, findLatestJournalFiles, isJournalPath, journalDateFromPath, journalPeriodFromPath, type JournalPeriod } from "./journalResolver";
import { isVaultPathExcluded } from "./privacy";
import type { StoreHost } from "./store/settingsSlice";
import {produceVaultQueryRead,type VaultQueryRead,type VaultQueryReader} from "./vaultQueryRead";
import { contextSourceHash } from "./sourceReferences";
import { dailyQueryPaths, readDailyQuery } from "./dailyQuery";

export type VaultQueryDomain = "journal" | "note" | "trade" | "health" | "memory" | "task" | "habit";
export type VaultQueryOperation = "get" | "list" | "search";
/** Curated repair instructions may be returned without exposing read failures. */
export class VaultQueryParameterError extends Error {}

export interface VaultQuery {
  domain: VaultQueryDomain;
  operation: VaultQueryOperation;
  query?: string;
  date?: string;
  period?: JournalPeriod;
  path?: string;
  sort?: "newest" | "oldest";
  limit?: number;
  maxChars?: number;
  /** Offset in privacy/forgotten-memory filtered text, only exact-path get. */
  offset?: number;
  range?: "today" | "week";
  vault?: string;
}

export interface VaultQueryCoverage {
  limitedCatalog: boolean;
  unreadable: number;
  listedPaths: string[];
  pages: Array<{ path: string; start: number; end: number; total: number }>;
  /** Actual empty/whitespace-only successfully read files; never inferred from protected text or a notice. */
  emptyPaths?: string[];
  /** Exact allowed path absent from the owned catalog; never a read source. */
  missingPaths?: string[];
}
const queryCoverage = new WeakMap<VaultQueryRead, VaultQueryCoverage>();
export function vaultQueryReadCoverage(read: VaultQueryRead): VaultQueryCoverage | undefined {
  const value = queryCoverage.get(read); return value ? structuredClone(value) : undefined;
}

// Bound full-text work without silently reducing a historical search to recent days.
const MAX_SEARCH_FILES = 1000;
const readOwners=new WeakMap<VaultQueryRead,StoreHost>();
export function isOwnedVaultQueryRead(store:StoreHost,read:VaultQueryRead):boolean{return readOwners.get(read)===store;}

/** Read only original Markdown or confirmed PersonalMemory; never rely on an index. */
export async function executeVaultQuery(store: StoreHost, input: VaultQuery): Promise<string> {
  const read=await readVaultQueryWithSources(store,input);
  try{return read.text;}finally{read.dispose();}
}

export async function readVaultQueryWithSources(store:StoreHost,input:VaultQuery):Promise<VaultQueryRead>{
  const fixed={...input};
  const selector = fixed.vault?.trim() || "all";
  const needsExternal = selector !== "local" && (selector !== "all" || !!store.settings.externalVaults?.length);
  const externalCoverage: VaultQueryCoverage = { limitedCatalog: false, unreadable: 0, listedPaths: [], pages: [] };
  const external = needsExternal ? await (await import("./features/externalVault/query")).readExternalQuery(store, { ...fixed, vault: selector }, externalCoverage) : undefined;
  const local = (selector === "all" || selector === "local") && !(external && fixed.path?.startsWith("external-vault/"));
  const catalog=()=>{
    if (!local) return [];
    if(fixed.domain==="memory")return [];
    if (fixed.domain === "task" || fixed.domain === "habit") return dailyQueryPaths(store, fixed.domain)
      .filter(path => !isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes))
      .map(path => ({ path, version: JSON.stringify(store.getFile(path)?.stat ?? "absent") }));
    const path=fixed.path?.trim().replace(/\\/g,"/");
    if(path&&(!validRelativePath(path)||!allowedSource(store,path)))return [];
    const files=path?[store.getFile(path)].filter((file):file is TFile=>!!file):store.app.vault.getMarkdownFiles().filter(file=>allowedSource(store,file.path)&&domainMatches(store,fixed.domain,file.path));
    return path&&!files.length?[{path,version:"absent"}]:files.map(file=>({path:file.path,version:JSON.stringify({path:file.path,basename:file.basename,stat:file.stat})})).sort((a,b)=>a.path.localeCompare(b.path));
  };
  const coverage: VaultQueryCoverage = { limitedCatalog: false, unreadable: 0, listedPaths: [], pages: [] };
  const base = await produceVaultQueryRead(store, catalog, async reader => {
    const localText = local ? await executeVaultQueryCore(store, fixed, reader, coverage) : "";
    if (!external) return localText;
    const combined = local && !(external.matches && coverage.missingPaths?.length) ? localText : "";
    return [combined, external.text || (!local ? "原私人库没有符合条件的内容。" : "")].filter(Boolean).join("\n\n");
  }, !external?.matches);
  const read = external ? Object.freeze({
    ...base, revision: contextSourceHash(base.revision + external.revision), hasExternalSources: external.matches > 0,
    assertCurrent() { base.assertCurrent(); external.assertCurrent(); },
    async assertSourcesCurrent() { await base.assertSourcesCurrent(); await external.assertSourcesCurrent(); }
  }) : base;
  if (external) {
    coverage.limitedCatalog ||= externalCoverage.limitedCatalog;
    coverage.unreadable += externalCoverage.unreadable;
    coverage.listedPaths.push(...externalCoverage.listedPaths);
    coverage.pages.push(...externalCoverage.pages);
    if (externalCoverage.emptyPaths?.length) (coverage.emptyPaths ??= []).push(...externalCoverage.emptyPaths);
  }
  readOwners.set(read, store);
  queryCoverage.set(read, coverage);
  return read;
}

async function executeVaultQueryCore(store:StoreHost,input:VaultQuery,reader:VaultQueryReader,coverage:VaultQueryCoverage):Promise<string>{
  if (input.domain === "task" || input.domain === "habit") return readDailyQuery(store, input, reader);
  const limit = clamp(input.limit, 1, 12, 5);
  const maxChars = clamp(input.maxChars, 500, 18_000, 5_000);
  const query = input.query?.trim() || "";
  const requestedPath = input.path?.trim() || "";
  const requestedDate = input.date?.trim() || "";
  const paged = input.offset !== undefined;
  if (input.range !== undefined) throw new VaultQueryParameterError("range 仅适用于任务和习惯，不能用于日记或笔记。跨日日记请按所问日期逐日用 get 和 date 读取，或用 get_summaries 的日期范围和 includeOriginals 查原话；不要用 list 的 offset 翻页。");
  if (paged && (input.operation !== "get" || !requestedPath || input.query?.trim() || input.domain === "memory"
    || !Number.isSafeInteger(input.offset) || input.offset! < 0)) throw new VaultQueryParameterError("原文分页仅支持准确 path 的 get 和非负整数 offset，不得混入清单、搜索或记忆查询。日记可按 date 逐日 get；跨周也可用 get_summaries 的日期范围和 includeOriginals 读取原话。");
  if (requestedPath && !validRelativePath(requestedPath)) throw new Error("Vault 路径无效：请提供库内准确的相对 Markdown 路径，不得使用绝对路径或上级目录。");
  if (input.domain !== "journal" && (requestedDate || input.period)) throw new Error("date 和 period 仅适用于日记；其他资料请使用 path 或关键词。");
  if (input.domain === "memory") {
    if (requestedPath) throw new Error("个人记忆不支持 path 文件读取；请用 query 查询已确认记忆。");
    // Existing authority and source-assessment rules remain in the memory store.
    const content = await store.buildPersonalMemoryContext(query);
    const prepared=content.trim() ? `## Confirmed Personal Memory\n\n${truncate(content, maxChars)}` : "当前没有已确认的个人记忆。";
    await reader.contributeMemory(query,prepared);
    return prepared;
  }
  if (input.operation === "search" && !query) throw new Error("搜索关键词为空；请提供关键词，或使用 list 列出资料。");
  const date = requestedDate ? normalizeJournalDate(requestedDate) : "";
  if (requestedDate && !date) throw new Error(`日记日期无效：${requestedDate}。请提供有效日期后再读取。`);
  const path = requestedPath.replace(/\\/g, "/");
  if (path && !path.endsWith(".md")) throw new Error("该路径不是受支持的 Markdown 文件；请提供以 .md 结尾的准确路径。");
  if (path && !allowedSource(store, path)) throw new Error("该路径已排除或属于生成内容，不能作为用户事实来源读取。");
  const exact = path ? store.getFile(path) : null;
  if (path && (!exact || exact.path !== path)) {
    (coverage.missingPaths ??= []).push(path);
    return `没有找到准确路径：${path}。未使用相似文件替代。`;
  }
  if (exact && !domainMatches(store, input.domain, exact.path)) throw new Error("指定路径不属于所选资料类型，未读取其他资料。");
  if (exact && date && journalDateFromPath(exact.path, store.settings.folders.dailyRoot) !== date) throw new Error("指定路径与日记日期不匹配，未读取其他日期。");
  if (exact && input.period && journalPeriodFromPath(exact.path) && journalPeriodFromPath(exact.path) !== input.period) throw new Error("指定路径与日记早晚时段不匹配，未读取其他时段。");

  const [{ createPersonalMemoryContextFilter,MEMORY_CONTEXT_OMISSION }, { readPersonalMemoryWithSources }, { extractTitle }] = await Promise.all([
    import("./personalMemoryContext"), import("./personalMemorySources"), import("./store/settingsSlice")
  ]);
  const protectContext = createPersonalMemoryContextFilter((await readPersonalMemoryWithSources(store)).records);
  let files = exact ? [exact] : store.app.vault.getMarkdownFiles()
    .filter(file => allowedSource(store, file.path) && domainMatches(store, input.domain, file.path));
  if (input.domain === "journal" && !exact) {
    const dated = files.filter(file => journalDateFromPath(file.path, store.settings.folders.dailyRoot))
      .map(file => ({ path: file.path, mtime: file.stat.mtime, file }));
    let selected = date ? findJournalFilesForDate(dated, store.settings.folders.dailyRoot, date)
      : findLatestJournalFiles(dated, store.settings.folders.dailyRoot);
    if (input.period) {
      const matchingPeriod = selected.filter(entry => journalPeriodFromPath(entry.path) === input.period);
      selected = matchingPeriod.length ? matchingPeriod : selected.filter(entry => journalPeriodFromPath(entry.path) === null);
    }
    // Date reads traditionally display a day's morning before evening. Explicit
    // ordering still has its literal meaning; undated reads default to newest.
    if ((date && input.sort === "newest") || (!date && input.sort === "oldest")) selected.reverse();
    files = selected.map(entry => entry.file);
  } else if (!exact) {
    files.sort((left, right) => (input.sort === "oldest" ? 1 : -1) * (left.stat.mtime - right.stat.mtime)
      || left.path.localeCompare(right.path, "zh-CN"));
  }

  const bodySearch = input.operation === "search" || (input.domain !== "journal" && input.operation === "get" && !exact && Boolean(query));
  const needle = query.toLocaleLowerCase();
  if (input.operation === "list" && query) files = files.filter(file => protectContext(file.path).toLocaleLowerCase().includes(needle));
  const selectionLimit = exact ? 1 : input.operation === "get" ? (input.domain === "journal" && date ? 12 : 1) : limit;
  const matchedCount = files.length;
  const blocks: string[] = [];
  let examined = 0, unreadable = 0, found = 0;
  const candidates = bodySearch ? files.slice(0, MAX_SEARCH_FILES) : files.slice(0, selectionLimit);
  for (const file of candidates) {
    examined += 1;
    // Re-check policy before each read in case settings changed during a search.
    if (!allowedSource(store, file.path)) continue;
    if (input.operation === "list") {
      coverage.listedPaths.push(file.path);
      blocks.push(protectContext(sourceBlock(store, input.domain, file, file.basename)));
      continue;
    }
    let raw: string;
    try { raw = await reader.read(file); }
    catch {
      unreadable += 1;
      if (!bodySearch) blocks.push(protectContext(sourceBlock(store, input.domain, file, file.basename) + "\n- bodyStatus: unreadable\n\n来源读取失败，未用其他文件替代。"));
      continue;
    }
    if (!allowedSource(store, file.path)) continue;
    // Filter before searching or clipping; old memory is not a retrieval signal.
    const protectedRaw = protectContext(raw);
    const content = input.operation === "get" && !bodySearch ? protectedRaw : protectedRaw.trim();
    if (bodySearch && !`${protectContext(file.path)}\n${content}`.toLocaleLowerCase().includes(needle)) continue;
    found += 1;
    const empty = input.domain === "journal" ? "日记文件存在，但没有可读取的正文。" : "文件存在，但没有可读取的正文。";
    const bodyStatus=content.trim()?"":raw.trim()?"\n- bodyStatus: protected-empty":"\n- bodyStatus: empty";
    if(!raw.trim())(coverage.emptyPaths??=[]).push(file.path);
    const offset = paged ? Math.min(input.offset!, content.length) : 0;
    const start = paged ? offset : excerptStart(content, bodySearch ? needle : "", maxChars), end = Math.min(content.length, start + maxChars);
    const body = content.trim() ? paged ? truncate(content.slice(offset), maxChars) : excerpt(content, bodySearch ? needle : "", maxChars) : empty;
    coverage.pages.push({ path: file.path, start, end, total: content.length });
    const pageInfo = paged || (input.operation === "get" && content.length > maxChars)
      ? `\n- protectedTextPage: ${start}-${end}/${content.length}; nextOffset: ${end < content.length ? end : "none"}; rawHash: ${contextSourceHash(raw)}` : "";
    const block=protectContext(sourceBlock(store, input.domain, file, extractTitle(content, file.basename)) + pageInfo + bodyStatus + `\n\n${body}`);
    blocks.push(block);
    for(const fragment of originalContributions(raw,content,body,start,maxChars,MEMORY_CONTEXT_OMISSION))reader.contributed(file.path,fragment);
    if (bodySearch && found >= selectionLimit) break;
  }
  const notices: string[] = [];
  coverage.unreadable = unreadable;
  coverage.limitedCatalog = input.operation === "list" && matchedCount > selectionLimit;
  if (coverage.limitedCatalog && !date) notices.push(`本次仅列出 ${selectionLimit} 篇，尚有 ${matchedCount - selectionLimit} 篇未列出；清单不是已阅读正文或完整历史分析。`);
  if (bodySearch && examined < files.length) notices.push(`已按${input.sort === "oldest" || (date && input.sort !== "newest") ? "最旧" : "最新"}顺序检查 ${examined} 篇，尚有 ${files.length - examined} 篇未检查；本次结果不是完整历史清单。可指定日期、路径或更具体关键词缩小范围。`);
  if (unreadable) notices.push(`${unreadable} 篇来源读取失败，不能把本次结果视为完整记录。`);
  if (!bodySearch && !exact && input.domain === "journal" && date && matchedCount > selectionLimit) {
    notices.push(`同日共匹配 ${matchedCount} 篇，以下仅展示前 ${selectionLimit} 篇；尚有未展示日记，请指定早晚时段缩小范围，不能将本次片段视为完整当日记录。`);
  }
  if (!blocks.length) notices.push(date ? `没有找到 ${date}${input.period ? ` ${input.period}间` : ""}的日记。`
    : `没有找到${query ? `与“${query}”相关的` : "可用的"} Vault 内容。`);
  return protectContext([...notices, ...blocks].join("\n\n"));
}

function validRelativePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return !/^(?:\/|~|[a-z][a-z\d+.-]*:)/i.test(normalized) && !/[\u0000-\u001f]/.test(normalized)
    && normalized.split("/").every(part => Boolean(part) && part !== "." && part !== "..");
}

function within(path: string, root: string | undefined): boolean {
  const normalized = root?.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return Boolean(normalized && (path === normalized || path.startsWith(`${normalized}/`)));
}

function allowedSource(store: StoreHost, path: string): boolean {
  return validRelativePath(path) && path.endsWith(".md")
    && !within(path, store.settings.folders.aiReports)
    && !isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes)
    && (typeof store.isManagedSourcePath !== "function" || store.isManagedSourcePath(path));
}

function domainMatches(store: StoreHost, domain: VaultQueryDomain, path: string): boolean {
  if (domain === "journal") return isJournalPath(path, store.settings.folders.dailyRoot);
  if (domain === "trade") return within(path, store.settings.folders.tradingModels) || within(path, store.settings.folders.tradingReviews);
  if (domain === "health") return within(path, store.settings.folders.health);
  return domain === "note";
}

function sourceBlock(store: StoreHost, domain: VaultQueryDomain, file: TFile, title: string): string {
  const source = `vault:${file.path}`;
  const modified = Number.isFinite(file.stat.mtime) ? new Date(file.stat.mtime).toISOString() : "unknown";
  return (domain === "journal" ? ["### Journal Source",
    `- date: ${journalDateFromPath(file.path, store.settings.folders.dailyRoot) || "unknown"}`,
    `- period: ${journalPeriodFromPath(file.path) || "unknown（原文件未标明早晚，不能确认所属时段）"}`,
    `- file: ${file.name}`, `- path: ${file.path}`, "- source: vault", `- evidence: ${source}`, `- modified: ${modified}`
  ] : [`### ${title}`, `- path: ${file.path}`, `- category: ${domain}`, `- source: ${source}`, `- modified: ${modified}`]).join("\n");
}

function excerpt(content: string, needle: string, maxChars: number): string {
  const match = needle ? content.toLocaleLowerCase().indexOf(needle) : -1;
  // Show a distant hit using already protected text, not a stale index excerpt.
  if (match >= maxChars) {
    const start = Math.max(0, match - Math.floor(maxChars / 4));
    return `…[前文已省略]\n${truncate(content.slice(start), maxChars)}`;
  }
  return truncate(content, maxChars);
}

function excerptStart(content: string, needle: string, maxChars: number): number {
  const match = needle ? content.toLocaleLowerCase().indexOf(needle) : -1;
  return match >= maxChars ? Math.max(0, match - Math.floor(maxChars / 4)) : 0;
}

/** Intersect actual protected raw intervals with the exact excerpt window.
 * Generated omission, empty-body and clipping labels never certify a source. */
function originalContributions(raw:string,content:string,body:string,start:number,maxChars:number,omission:string):string[]{
  if(!content.trim())return [];
  const end=Math.min(content.length,start+maxChars);
  const normalize=(text:string)=>text.replace(/\n{3,}/g,"\n\n").trim(),original=normalize(raw),prepared=normalize(body),fragments:string[]=[];
  let cursor=0;
  for(const run of content.split(omission)){
    const from=Math.max(start,cursor),to=Math.min(end,cursor+run.length),fragment=normalize(content.slice(from,Math.max(from,to)));
    if(fragment&&original.includes(fragment)&&prepared.includes(fragment))fragments.push(fragment);
    cursor+=run.length+omission.length;
  }
  return fragments;
}

function clamp(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars).trimEnd()}\n…[已截断]`;
}
