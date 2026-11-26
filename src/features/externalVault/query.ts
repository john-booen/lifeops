import {resolveVaultQueryDateRange} from '../../vaultQueryDateRange';
import type {DayRange} from '../stats/rangeInput';
import { journalDateFromPath, journalPeriodFromPath } from "../../journalResolver";
import { fileRevision } from "../../operationIdentity";
import { createPersonalMemoryContextFilter, personalMemoryContextRevision } from "../../personalMemoryContext";
import { readPersonalMemoryWithSources } from "../../personalMemorySources";
import { isContextSourcePath } from "../../sourceReferences";
import type { StoreHost } from "../../store/settingsSlice";
import type { VaultQuery, VaultQueryCoverage } from "../../vaultQuery";
import { externalCategory, externalJournalRoot, externalSourcePath, externalVaultReader, externalVaultScope, externalVaultSettings, readExternalTitles } from "./catalog";
import type { ReadOnlyExternalVault } from "./readOnly";

export interface ExternalQueryResult {
  text: string;
  matches: number;
  revision: string;
  assertCurrent(): void;
  assertSourcesCurrent(): Promise<void>;
}

function matchesDomain(store: StoreHost, input: VaultQuery, path: string): boolean {
  const category = externalCategory(store.settings, path);
  if (input.domain === "journal") return category === "journal";
  if (input.domain === "trade") return category === "trade_review" || category === "trade_model";
  return input.domain === "note";
}

export async function readExternalQuery(store: StoreHost, input: VaultQuery, coverage: VaultQueryCoverage,dateRange?:DayRange): Promise<ExternalQueryResult | undefined> {
  dateRange??=resolveVaultQueryDateRange(input,new Date());
  const selector = input.vault || "all";
  if (selector === "local") return;
  const configured = externalVaultSettings(store.settings);
  const configs = selector === "all" ? configured : configured.filter(item => item.name === selector);
  if (selector !== "all" && !configs.length) throw Error("没有这个已配置的外部资料库。");
  if (!configs.length) return;
  if (!["journal", "note", "trade"].includes(input.domain)) {
    if (selector !== "all") throw Error("外部库只查询日记、交易和已允许的笔记。");
    return;
  }
  const scope = externalVaultScope(store);
  const needle = input.query?.trim().toLocaleLowerCase() || "";
  const max = Math.min(18_000, Math.max(500, input.maxChars ?? 5000));
  const limit = Math.min(12, Math.max(1, input.limit ?? 5));
  const path = input.path?.trim();
  if ((input.date || input.period) && input.domain !== "journal") throw Error("外部日记日期或时段无效。");
  if (path && (!isContextSourcePath(path) || !path.endsWith(".md"))) throw Error("外部资料请使用准确的相对 Markdown 路径。");
  if (input.operation === "search" && !needle) throw Error("搜索关键词为空。");
  if (input.offset !== undefined && (!path || input.operation !== "get" || needle || !Number.isSafeInteger(input.offset) || input.offset < 0)) {
    throw Error("外部原文分页需要准确路径和非负整数 offset。");
  }
  const catalog = async () => Promise.all(configs.map(async config => {
    const reader = externalVaultReader(store, config);
    const files = await reader.listMarkdown().catch(() => undefined);
    return { config, reader, files };
  }));
  const entries = await catalog();
  const titles = new Map(await Promise.all(entries.map(async ({ config, files }) => [
    config.name, await readExternalTitles(store, config, files ?? []).catch(() => new Map<string, string>())
  ] as const)));
  const catalogVersion = (items: Awaited<ReturnType<typeof catalog>>) => fileRevision(JSON.stringify(items.map(item => [item.config.name, item.files])));
  const version = catalogVersion(entries);
  const assertCurrent = () => {
    if (externalVaultScope(store) !== scope) throw Error("外部库读取权限已经变化，请重新查询。");
  };
  const memory = await readPersonalMemoryWithSources(store);
  const memoryRevision = personalMemoryContextRevision(memory.records);
  const protect = createPersonalMemoryContextFilter(memory.records);
  const references: Array<{ reader: ReadOnlyExternalVault; path: string; hash: string }> = [];
  const notes = entries.flatMap(({ config, reader, files }) => (files ?? []).filter(file =>
    (!path || file.path === path || externalSourcePath(config.name, file.path) === path) && matchesDomain(store, input, file.path))
    .map(file => ({ config, reader, file, date: journalDateFromPath(file.path, externalJournalRoot(store.settings, file.path)) || "",
      period: journalPeriodFromPath(file.path) })));
  const filtered = notes.filter(note => (!dateRange || !!note.date&&note.date>=dateRange.from&&note.date<=dateRange.to) && (!input.period || note.period === input.period || !note.period)
    && (input.operation !== "list" || !needle || protect(note.file.path).toLocaleLowerCase().includes(needle)));
  const sign = input.sort === "oldest" ? 1 : -1;
  filtered.sort((a, b) => sign * (a.date && b.date ? a.date.localeCompare(b.date) : a.file.mtime - b.file.mtime)
    || (a.period === b.period ? 0 : a.period === "早" ? -1 : b.period === "早" ? 1 : 0)
    || a.file.path.localeCompare(b.file.path, "zh-CN"));
  const blocks: string[] = [];
  let unreadable = entries.filter(item => !item.files).length;
  const searchable = input.operation === "search" || input.operation === "get" && !!needle && !path;
  const count = path ? Math.min(12, filtered.length) : input.operation === "get" ? (dateRange && input.domain === "journal" ? 12 : 1) : limit;
  for (const item of filtered.slice(0, searchable ? 1000 : count)) {
    assertCurrent();
    const reference = externalSourcePath(item.config.name, item.file.path);
    const title = titles.get(item.config.name)?.get(item.file.path);
    const header = "### 来自原私人库（" + item.config.name + "）\n- path: " + reference + "\n- vault: " + item.config.name
      + (dateRange?`\n- requestedDates: ${dateRange.from} 至 ${dateRange.to}（按笔记日期筛选；事件日须读原话）`:"")
      + (title ? "\n- title: " + title : "")
      + (item.date ? "\n- date: " + item.date + "\n- period: " + (item.period ?? "unknown") : "");
    if (input.operation === "list") {
      coverage.listedPaths.push(reference);
      blocks.push(protect(header));
      continue;
    }
    const raw = await item.reader.read(item.file.path).catch(() => undefined);
    if (raw === undefined) { unreadable++; continue; }
    const text = protect(raw), lower = text.toLocaleLowerCase();
    const hit = searchable ? lower.indexOf(needle) : -1;
    if (searchable && hit === -1 && !protect(item.file.path).toLocaleLowerCase().includes(needle)) continue;
    const start = Math.min(text.length, input.offset ?? Math.max(0, hit >= max ? hit - Math.floor(max / 4) : 0));
    const end = Math.min(text.length, start + max);
    const hash = fileRevision(raw);
    references.push({ reader: item.reader, path: item.file.path, hash });
    coverage.pages.push({ path: reference, start, end, total: text.length });
    if (!raw.trim()) (coverage.emptyPaths ??= []).push(reference);
    const next = end < text.length ? "\n- protectedTextPage: " + start + "-" + end + "/" + text.length + "; nextOffset: " + end : "";
    blocks.push(protect(header) + next + "\n\n" + (text.slice(start, end) || "文件存在，暂无可用正文。"));
    if (blocks.length >= count) break;
  }
  coverage.unreadable += unreadable;
  if (input.operation === "list" && filtered.length > count) coverage.limitedCatalog = true;
  assertCurrent();
  return {
    text: [...(unreadable ? ["有 " + unreadable + " 项外部来源暂时无法读取。"] : []), ...blocks].join("\n\n"),
    matches: blocks.length, revision: fileRevision(JSON.stringify([scope, version, references.map(item => [item.path, item.hash])])),
    assertCurrent,
    async assertSourcesCurrent() {
      assertCurrent();
      if (catalogVersion(await catalog()) !== version) throw Error("外部目录已变化，请重新查询。");
      for (const reference of references) {
        if (fileRevision(await reference.reader.read(reference.path)) !== reference.hash) throw Error("外部原文已变化，请重新查询。");
      }
      if (personalMemoryContextRevision((await readPersonalMemoryWithSources(store)).records) !== memoryRevision) {
        throw Error("查询使用的记忆已变化，请重新读取。");
      }
      assertCurrent();
    }
  };
}
