import { normalizePath } from "obsidian";
import type { LifeOpsSettings } from "../types";
import { projectFileName, validateProjectDocument } from "../projectContinuity";
import { validateProjectJobDocument } from "../projectJobRepository";
import { tradingFileName, validateTradingDocument } from "../tradingResearch";
import { signalDateFromDocumentPath, validSignalDocument } from "../features/journal/signals";
import { TRADE_DATABASE_NAME, validTradeDatabase } from "../features/trading/types";
import { validLearningDocument } from "../features/learning/model";
import { validQuizDocument } from "../features/learning/quizModel";
import { DEVICE_INBOX_STATE, PHONE_INBOX_STATE, validPhoneInboxDocument } from "../features/phoneInbox/model";
import { validReadingDocument } from "../features/reading/model";

export interface JsonWriteOptions { compact?: boolean }
export function serializeJsonData(value: unknown, options: JsonWriteOptions = {}): string {
  return `${JSON.stringify(value, null, options.compact ? undefined : 2)}\n`;
}

interface JsonDataContract {
  root: "object" | "array";
  taskMirrorRevision?: boolean;
  version?: 1;
  versions?: readonly number[];
  arrays?: readonly string[];
  numbers?: readonly string[];
  validate?: (value: unknown) => boolean;
  optionalHashes?: readonly string[];
}

export class DataProtectionError extends Error {
  readonly code = "LIFEOPS_DATA_PROTECTED";

  constructor(readonly filePath: string, reason: "json" | "shape" | "version") {
    const detail = reason === "version" ? "数据格式版本不受支持" : "数据内容无法安全读取";
    super(`LifeOps 已停止这次数据操作：${detail}，未覆盖该目标文件。请先检查或恢复：${filePath}`);
    this.name = "DataProtectionError";
  }
}

// Keep the existing wire formats. A schema migration is a separate operation.
export function jsonDataContract(
  filePath: string,
  folders: Pick<LifeOpsSettings["folders"], "tasks" | "habits" | "aiReports"> & Partial<Pick<LifeOpsSettings["folders"], "goals" | "tradingModels" | "tradingReviews">>
): JsonDataContract | undefined {
  const path = (...parts: string[]): string => normalizePath(parts.filter(Boolean).join("/"));
  const object = (arrays: readonly string[], version?: 1): JsonDataContract => ({ root: "object", arrays, version });
  const contracts: Record<string, JsonDataContract> = {
    [path(folders.tasks, "LifeOps任务库.json")]: { ...object(["tasks"]), taskMirrorRevision: true },
    [path(folders.habits, "LifeOps打卡库.json")]: object(["habits", "checkins"]),
    [path(folders.aiReports, "Index", "source-manifest.json")]: object(["entries"], 1),
    [path(folders.aiReports, "Index", "lifeops-index.json")]: object(["entries"]),
    [path(folders.aiReports, "Index", "lifeops-vectors.json")]: object(["entries"]),
    [path(folders.aiReports, "Knowledge", "lifeops-chunks.json")]: object(["chunks"]),
    [path(folders.aiReports, "Knowledge", "lifeops-knowledge-graph.json")]: object(["nodes", "edges"]),
    [path(folders.aiReports, "Knowledge", "knowledge-links.json")]: object(["links"]),
    [path(folders.aiReports, "Knowledge", "associations.json")]: { root: "array" },
    [path(folders.aiReports, "Memory", "memory-index.json")]: { root: "array" },
    [path(folders.aiReports, "Memory", "personal-memory.json")]: object(["records"], 1),
    [path(folders.aiReports, "Ideas", "LifeOps想法候选.json")]: object(["ignored", "registered"], 1),
    [path(folders.aiReports, "Ideas", "LifeOps想法推进.json")]: object(["entries"], 1),
    [path(folders.aiReports, "Learning", "LifeOps学习轨道.json")]: { ...object(["tracks"], 1), validate: validLearningDocument },
    [path(folders.aiReports, "Learning", "LifeOps复习卡.json")]: { ...object(["cards"], 1), validate: validQuizDocument },
    [path(folders.aiReports, "Reading", "index.json")]: { ...object(["entries"], 1), validate: validReadingDocument },
    [path(folders.aiReports, "Memory", "personality-vector.json")]: {
      root: "object", numbers: ["strictness", "warmth", "directness", "playfulness", "initiative", "formality"]
    },
    [path(folders.aiReports, "Situation", "observations.json")]: object(["observations"], 1),
    [path(folders.aiReports, "Proactive", "policy-state.json")]: object(["deliveries", "feedback", "mutedKinds"], 1),
    [path(folders.aiReports, "摘要", "调度.json")]: object([], 1),
    [path(folders.aiReports, "System", PHONE_INBOX_STATE)]: { ...object(["records"], 1), validate: validPhoneInboxDocument },
    [path(folders.aiReports, "System", DEVICE_INBOX_STATE)]: { ...object(["records"], 1), validate: validPhoneInboxDocument },
    [path(folders.aiReports, "Operations", "operation-ledger.json")]: { ...object(["records"], 1), optionalHashes: ["revertedOperationHashes"] },
    [path(folders.aiReports, "Operations", "write-recovery.json")]: { ...object(["entries"]), versions: [1, 2, 3, 4] },
    [path(folders.aiReports, "Jobs", "project-job.json")]: { ...object([]), versions: [1, 2], validate: validateProjectJobDocument },
    [path(folders.aiReports, "Vision", "visual-state.json")]: object([]),
    [path(folders.aiReports, "Desktop", "desktop-state.json")]: object([])
  };
  const normalized = normalizePath(filePath);
  const signalDate = signalDateFromDocumentPath(normalized, path(folders.aiReports));
  if (signalDate) return { ...object(["晨", "晚"], 1), validate: value => validSignalDocument(value, signalDate) };
  const indexRoot = path(folders.aiReports, "Index") + "/";
  if (normalized.startsWith(indexRoot) && /^external-[\p{L}\p{N}_-]{1,48}\.json$/u.test(normalized.slice(indexRoot.length))) return object(["entries"], 1);
  if (new RegExp(`^[a-f0-9-]{36}\\.json$`).test(normalized.split("/").at(-1) ?? "")
    && normalized.startsWith(`${path(folders.aiReports, "Jobs", "Archive")}/`)) return { ...object([]), versions: [1, 2], validate: validateProjectJobDocument };
  if (folders.goals && normalized === path(folders.goals, projectFileName())) return { ...object(["goals", "projects"], 1), validate: validateProjectDocument };
  if (folders.tradingModels && normalized === path(folders.tradingModels, tradingFileName())) return { ...object(["models", "cases"], 1), validate: validateTradingDocument };
  if (folders.tradingReviews && normalized === path(folders.tradingReviews, TRADE_DATABASE_NAME)) return { ...object(["trades"], 1), validate: validTradeDatabase };
  return Object.hasOwn(contracts, normalized) ? contracts[normalized] : undefined;
}

export function validateJsonData(value: unknown, filePath: string, contract?: JsonDataContract): void {
  if (!contract) return;
  const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
  if (isObject) {
    const document = value as Record<string, unknown>;
    // No producer currently emits schemaVersion. Do not guess that a new envelope is compatible.
    if (Object.hasOwn(document, "schemaVersion")
      || (contract.versions ? !contract.versions.includes(document.version as number)
        : contract.version !== undefined ? document.version !== contract.version : Object.hasOwn(document, "version"))) {
      throw new DataProtectionError(filePath, "version");
    }
  }
  if (contract.root === "array") {
    if (!Array.isArray(value)) throw new DataProtectionError(filePath, "shape");
    return;
  }
  if (!isObject) throw new DataProtectionError(filePath, "shape");
  const document = value as Record<string, unknown>;
  if (contract.taskMirrorRevision && Object.hasOwn(document, "taskMirror")) {
    const mirror = document.taskMirror as Record<string, unknown> | null;
    if (!mirror || typeof mirror !== "object" || Array.isArray(mirror)) throw new DataProtectionError(filePath, "shape");
    if (mirror.version !== 1 || Object.hasOwn(mirror, "schemaVersion")) throw new DataProtectionError(filePath, "version");
    if (typeof mirror.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(mirror.sha256)) throw new DataProtectionError(filePath, "shape");
  }
  if (contract.arrays?.some((key) => !Array.isArray(document[key]))
    || contract.numbers?.some((key) => typeof document[key] !== "number" || !Number.isFinite(document[key]))
    || contract.optionalHashes?.some(key => Object.hasOwn(document, key) && (!Array.isArray(document[key])
      || document[key].some((item: unknown) => typeof item !== "string" || !/^[a-f0-9]{64}$/.test(item))))
    || contract.validate && !contract.validate(value)) {
    throw new DataProtectionError(filePath, "shape");
  }
}

export function parseJsonData(text: string, filePath: string, contract?: JsonDataContract): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Do not include parser messages: they can contain fragments of private source text.
    throw new DataProtectionError(filePath, "json");
  }
  validateJsonData(value, filePath, contract);
  return value;
}
