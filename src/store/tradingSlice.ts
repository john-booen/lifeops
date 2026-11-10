import type { StoreHost } from "./settingsSlice";
import { contextSourceHash, recordContextSource, type ContextSourceRecorder } from "../sourceReferences";
import { assertSafeOperationId } from "../operationIdentity";
import { fileRevision, guardedOperationIdentity } from "../dataFoundation/factOperation";
import { readTradingDocument, persistTradingDocument, tradingConflict, tradingDocumentPath, tradingDocumentRevision, tradingReadSnapshot } from "../dataFoundation/tradingPersistence";
import { isVaultPathExcluded } from "../privacy";
import { safeProjectPath } from "../projectContinuity";
import { assertTradingRuleSources, isConfiguredTradingNote } from "../features/trading/ruleSources";
import { tradingHash, tradingVersion, tradingCaseSourceKey, tradingFields, TRADING_CASE_FIELDS, TRADING_MODEL_FIELDS,
  validTradingCaseInput, validTradingModelInput, type TradingCommand, type TradingSnapshot, type TradingCase, type TradingVersion } from "../tradingResearch";

export interface TradingSliceApi {
  getTradingSnapshot(): Promise<TradingSnapshot>;
  applyTradingCommand(command: TradingCommand, expectedRevision: string, operationId: string): Promise<string>;
}

const snapshotOrigins = new WeakMap<TradingSnapshot, { store: StoreHost; path: string; hash: string }>();
const validTradingIdentity = (value: unknown, optional = false): boolean => optional && value === undefined
  || typeof value === "string" && !!value && value === value.trim();

function canReadSource(store: StoreHost, path: string): boolean {
  return safeProjectPath(path) && (store.isManagedSourcePath(path) || isConfiguredTradingNote(store, path))
    && !!store.getFile(path) && !isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes);
}

export function recordTradingSnapshotSource(store: StoreHost, snapshot: TradingSnapshot, record: ContextSourceRecorder | undefined, fragment: string): void {
  const origin = snapshotOrigins.get(snapshot);
  if (origin?.store === store) recordContextSource(record, origin.path, fragment, origin.hash);
}

const tradingSlice: TradingSliceApi = {
  async getTradingSnapshot(this: StoreHost) {
    const document = await readTradingDocument(this), sources: TradingSnapshot["sources"] = {};
    const items = [
      ...document.models.flatMap(model => model.versions.map(version => ({ key: version.id, item: version }))),
      ...document.cases.flatMap(entry => [...entry.revisions, entry].map((item, index) => ({ key: tradingCaseSourceKey(entry.id, index), item })))
    ];
    for (const { key, item } of items) {
      try {
        sources[key] = !item.sourcePath ? "not_provided" : !canReadSource(this, item.sourcePath) ? "unavailable"
          : fileRevision(await this.readPath(item.sourcePath)) === item.sourceHash ? "unchanged" : "changed";
      } catch {
        sources[key] = "unavailable";
      }
    }
    const { [tradingReadSnapshot]: read, ...publicDocument } = document;
    const snapshot = { revision: tradingDocumentRevision(document), document: publicDocument, sources };
    if (read?.raw != null) snapshotOrigins.set(snapshot, { store: this, path: tradingDocumentPath(this),
      hash: contextSourceHash(read.raw) });
    return snapshot;
  },

  async applyTradingCommand(this: StoreHost, command, expectedRevision, operationId) {
    assertSafeOperationId(operationId);
    const identity = guardedOperationIdentity(this);
    if (!identity || identity.operationId !== operationId || identity.purpose === "derived") {
      throw new Error("交易研究确认与当前保存操作不一致。");
    }
    const document = await readTradingDocument(this);
    if (tradingDocumentRevision(document) !== expectedRevision) tradingConflict();
    if (command.kind !== "save_model" && command.kind !== "save_case") throw new Error("交易研究不支持这个动作，未保存。");
    const modelCommand = command.kind === "save_model";
    const input = command.input;
    if (modelCommand && !validTradingIdentity(command.modelId, true)
      || command.kind === "save_case" && (!validTradingIdentity(command.caseId, true) || !validTradingIdentity(command.input?.versionId))) {
      throw new Error("请使用准确的交易记录编号；空白或变形编号不能代替省略，未保存。");
    }
    const fields: readonly string[] = modelCommand ? [...TRADING_MODEL_FIELDS, "rules"] : TRADING_CASE_FIELDS;
    if (Object.keys(command).some(key => !["kind", modelCommand ? "modelId" : "caseId", "input"].includes(key))
      || !(modelCommand ? validTradingModelInput(input) : validTradingCaseInput(input))
      || Object.keys(input).some(key => !fields.includes(key))) {
      throw new Error("请核对交易研究的字段、日期与明确内容。");
    }
    if (input.sourcePath && !canReadSource(this, input.sourcePath)) throw new Error("交易原文来源不可读取或已排除，未保存。");
    const sourceHash = input.sourcePath ? fileRevision(await this.readPath(input.sourcePath)) : "";
    const id = (kind: string) => `trade-${kind}-${tradingHash(operationId).slice(0, 24)}`;
    const updatedAt = new Date().toISOString();
    let targetId: string;
    if (command.kind === "save_model") {
      const model = document.models.find(item => item.id === command.modelId);
      if (command.modelId !== undefined && !model) throw new Error("原模型不存在，未另建替代模型。");
      const previous = model?.versions.at(-1);
      const rules = command.input.rules ?? previous?.rules ?? [];
      if (JSON.stringify(rules) !== JSON.stringify(previous?.rules ?? [])) await assertTradingRuleSources(this, rules);
      targetId = model?.id ?? id("model");
      const version = { ...tradingFields(command.input, TRADING_MODEL_FIELDS), id: id("version"), modelId: targetId,
        previousVersionId: previous?.id ?? "", rules, revision: (model?.versions.length ?? 0) + 1, updatedAt, sourceHash } as TradingVersion;
      if (model) model.versions.push(version);
      else document.models.push({ id: targetId, versions: [version] });
    } else {
      const version = tradingVersion(document, command.input.versionId);
      if (!version) throw new Error("规则版本不存在，请选择已保存的具体版本。");
      const previous = document.cases.find(item => item.id === command.caseId);
      if (command.caseId !== undefined && !previous) throw new Error("原案例不存在，未另建替代案例。");
      targetId = previous?.id ?? id("case");
      const revisions = previous ? [...previous.revisions, caseRevision(previous)] : [];
      const entry = { ...previous, ...tradingFields(command.input, TRADING_CASE_FIELDS), id: targetId,
        modelId: version.modelId, sourceHash, revision: revisions.length + 1, updatedAt, revisions } as TradingCase;
      delete entry.receipt;
      delete entry.versionHash;
      if (previous) document.cases[document.cases.indexOf(previous)] = entry;
      else document.cases.push(entry);
    }
    await persistTradingDocument(this, document);
    return targetId;
  }
};

function caseRevision(entry: TradingCase): TradingCase["revisions"][number] {
  const { id: _id, revisions: _revisions, ...revision } = entry;
  return revision;
}

export function applyTradingSlice(target: { prototype: object }): void {
  Object.assign(target.prototype, tradingSlice);
}
