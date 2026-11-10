import { createHash } from "node:crypto";
import { isVaultPathExcluded } from "../../privacy";
import { safeProjectPath } from "../../projectContinuity";
import type { StoreHost } from "../../store/settingsSlice";
import { getTradingSourceFolders } from "./sourceFolders";
import { validTradingRules, type TradingRule } from "./rules";

export function isConfiguredTradingNote(store: StoreHost, path: string): boolean {
  return safeProjectPath(path) && !path.startsWith(`${store.settings.folders.aiReports}/`)
    && !path.startsWith(`${store.settings.folders.tradingReviews}/LifeOps交易/`)
    && !isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes)
    && getTradingSourceFolders(store.settings).some(folder => path.startsWith(`${folder}/`));
}

export function listTradingRuleSources(store: StoreHost): string[] {
  return store.app.vault.getMarkdownFiles().map(file => file.path).filter(path => isConfiguredTradingNote(store, path)).sort();
}

export async function readTradingRuleSource(store: StoreHost, path: string): Promise<string> {
  if (!isConfiguredTradingNote(store, path) || store.getFile(path)?.path !== path) throw new Error("请选择交易来源列表中的可读取笔记。");
  const text = await store.readPath(path);
  if (!isConfiguredTradingNote(store, path) || store.getFile(path)?.path !== path) throw new Error("交易来源权限或路径已变化，请重新选择。");
  return text;
}

export async function assertTradingRuleSources(store: StoreHost, rules: readonly TradingRule[]): Promise<void> {
  const sources = new Map<string, string>();
  for (const rule of rules) {
    let text = sources.get(rule.sourcePath);
    if (text === undefined) {
      text = await readTradingRuleSource(store, rule.sourcePath);
      sources.set(rule.sourcePath, text);
    }
    if (!text.includes(rule.quote)) throw new Error("规则引文与交易原文不一致，请重新提取。");
  }
}

export async function extractTradingRules(store: StoreHost, path: string, analyze: (text: string) => Promise<string>): Promise<TradingRule[]> {
  const source = await readTradingRuleSource(store, path);
  if (!source.trim() || source.length > 32_000) throw new Error("原文为空或超过单篇提取范围，请选一篇具体规则笔记。");
  const reply = await analyze(source);
  let result: unknown;
  try { result = JSON.parse(reply.trim().replace(/^```(?:json)?\s*|\s*```$/gi, "")); }
  catch { throw new Error("规则提取没有返回可读取的结果，请再试一次。"); }
  if (!result || typeof result !== "object" || !Array.isArray((result as { rules?: unknown }).rules)) {
    throw new Error("没有得到可核对的规则清单。");
  }
  const drafts = (result as { rules: Partial<TradingRule>[] }).rules;
  const rules = drafts.map(rule => {
    const { text, kind, checkable, quote } = rule ?? {};
    const key = createHash("sha256").update(JSON.stringify([path, kind, text])).digest("hex").slice(0, 16);
    return { id: `rule-${key}`, text, kind, checkable, quote, sourcePath: path };
  });
  if (!validTradingRules(rules) || rules.some(rule => !source.includes(rule.quote))) {
    throw new Error("规则或引文无法在原文中核对，请重新提取。");
  }
  if (await readTradingRuleSource(store, path) !== source) throw new Error("交易原文在提取期间变化，请重新提取。");
  return rules;
}
