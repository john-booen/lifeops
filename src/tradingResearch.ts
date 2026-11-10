import { createHash } from "node:crypto";
import { safeProjectPath, type ContinuityReceipt } from "./projectContinuity";
import { validTradingRules, type TradingRule } from "./features/trading/rules";
import type { StoreHost } from "./store/settingsSlice";

export const TRADING_MODEL_FIELDS = ["title", "market", "entry", "exit", "invalid", "riskBudget", "environment", "costs", "rationale", "sourcePath"] as const;
export const TRADING_CASE_FIELDS = ["versionId", "date", "ruleAssessment", "execution", "result", "review", "sourcePath"] as const;
export const TRADING_LABELS: Record<string, string> = { title: "模型名称", market: "市场与品种", entry: "入场条件", exit: "退出条件", invalid: "失效条件", riskBudget: "风险预算", environment: "市场环境", costs: "费用与滑点", rationale: "规则依据与待验证问题", sourcePath: "原文来源", versionId: "规则版本", date: "案例日期", ruleAssessment: "规则评估（用户记录）", execution: "实际执行与偏离", result: "结果（不代替规则评估）", review: "复盘与待验证问题" };
export type TradingModelInput = Record<typeof TRADING_MODEL_FIELDS[number], string> & { rules?: TradingRule[] };
export type TradingCaseInput = Record<typeof TRADING_CASE_FIELDS[number], string>;
interface ResearchRevision { revision?: number; updatedAt?: string; receipt?: ContinuityReceipt }
export interface TradingVersion extends TradingModelInput, ResearchRevision { id: string; modelId: string; previousVersionId: string; sourceHash: string }
export interface TradingModel { id: string; versions: TradingVersion[]; [key: string]: unknown }
export interface TradingCaseRevision extends TradingCaseInput, ResearchRevision { modelId: string; versionHash?: string; sourceHash: string }
export interface TradingCase extends TradingCaseRevision { id: string; revisions: TradingCaseRevision[]; [key: string]: unknown }
export interface TradingDocument { version: 1; models: TradingModel[]; cases: TradingCase[]; [key: string]: unknown }
export interface TradingSnapshot { revision: string; document: TradingDocument; sources: Record<string, "unchanged" | "changed" | "unavailable" | "not_provided"> }
export type TradingCommand = { kind: "save_model"; modelId?: string; input: TradingModelInput } | { kind: "save_case"; caseId?: string; input: TradingCaseInput };
export function tradingFileName(): string { return "LifeOps交易研究.json"; }
export function tradingDocumentPath(store:StoreHost):string{return store.path(store.settings.folders.tradingModels,tradingFileName());}
export function tradingHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function emptyTradingDocument(): TradingDocument { return { version: 1, models: [], cases: [] }; }
export function tradingFields(value: object, fields: readonly string[]): Record<string, unknown> { return Object.fromEntries(fields.map(key => [key, (value as Record<string, unknown>)[key]])); }
export function validTradingDate(value: string): boolean { const date=new Date(`${value}T12:00:00Z`);return /^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value; }
const object=(value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value) && !Object.hasOwn(value,"schemaVersion");
const digest=(value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const textFields=(value: Record<string, any>,fields: readonly string[]) => fields.every(field=>typeof value[field]==="string"&&value[field].length<=4000&&value[field]===value[field].trim()) && (!value.sourcePath||safeProjectPath(value.sourcePath));
export function validTradingModelInput(value: unknown): boolean { return object(value)&&textFields(value,TRADING_MODEL_FIELDS)&&!!value.title&&value.title.length<=200&&(value.rules===undefined||validTradingRules(value.rules)); }
export function validTradingCaseInput(value: unknown): boolean { return object(value)&&textFields(value,TRADING_CASE_FIELDS)&&!!value.versionId&&validTradingDate(value.date)&&!![value.ruleAssessment,value.execution,value.result,value.review].join("").trim(); }
export function tradingCaseContent(entry: TradingCaseRevision): Record<string, unknown> { return { ...tradingFields(entry,TRADING_CASE_FIELDS),modelId:entry.modelId,versionHash:entry.versionHash,sourceHash:entry.sourceHash }; }
export function tradingCaseSources(entry: TradingCase): string[] { return [entry.sourcePath,...entry.revisions.map(item=>item.sourcePath)].filter(Boolean); }
export function tradingVersion(document: TradingDocument,id: string): TradingVersion | undefined { return document.models.flatMap(model=>model.versions).find(version=>version.id===id); }
export function tradingSavedAt(item: ResearchRevision): string {
  const timestamp = item.updatedAt ?? item.receipt?.recordedAt;
  return typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp)) ? timestamp : "";
}
export function tradingCaseSourceKey(id: string, index: number): string { return `${id}:${index + 1}`; }

export function normalizeTradingHistory(document: TradingDocument): TradingDocument {
  const revision = (item: ResearchRevision, index: number) => ({ revision: index + 1, updatedAt: tradingSavedAt(item) || undefined });
  return { ...document, models: document.models.map(model => ({ ...model, versions: model.versions.map((version, index) =>
    ({ ...version, ...revision(version, index), rules: version.rules ?? [] })) })), cases: document.cases.map(entry => ({
      ...entry, ...revision(entry, entry.revisions.length), revisions: entry.revisions.map((old, index) => ({ ...old, ...revision(old, index) }))
    })) };
}

export function validateTradingDocument(value: unknown): value is TradingDocument {
  if(!object(value)||value.version!==1||!Array.isArray(value.models)||!Array.isArray(value.cases))return false;
  const ids=new Set<string>(),versions=new Map<string,TradingVersion>();
  const id=(value:unknown):value is string=>typeof value==="string"&&/^trade-(?:model|version|case)-[a-f0-9]{24}$/.test(value)&&!ids.has(value)&&(ids.add(value),true);
  const source=(item:Record<string,any>)=>item.sourcePath?digest(item.sourceHash):item.sourceHash==="";
  const stamp=(item:ResearchRevision,index:number)=>(item.revision===undefined||item.revision===index+1)
    && (item.updatedAt===undefined||typeof item.updatedAt==="string"&&Number.isFinite(Date.parse(item.updatedAt)));
  for(const model of value.models){if(!object(model)||!id(model.id)||!Array.isArray(model.versions)||!model.versions.length)return false;let previous="";
    for(const [index,version] of model.versions.entries()){if(!object(version)||!id(version.id)||!validTradingModelInput(version)||version.modelId!==model.id||version.previousVersionId!==previous||!source(version)||!stamp(version,index))return false;versions.set(version.id,version as TradingVersion);previous=version.id;}}
  for(const entry of value.cases){if(!object(entry)||!id(entry.id)||!Array.isArray(entry.revisions))return false;
    for(const [index,item] of [...entry.revisions,entry].entries()){if(!object(item)||!validTradingCaseInput(item)||!source(item)||!stamp(item,index))return false;const version=versions.get(item.versionId);if(!version||item.modelId!==version.modelId)return false;}}
  return true;
}
