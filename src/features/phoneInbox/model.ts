import { MarkdownBlocks } from "../../dataFoundation/markdownBlocks";
import { normalizeJournalDate } from "../../date";
import { fileRevision, isSafeOperationId } from "../../operationIdentity";
import type { AgentActionSuggestion } from "../../types";

export const PHONE_INBOX_PATH = "输入/手机随手记.md";
export const PHONE_INBOX_STATE = "phone-inbox.json";
export const PHONE_INBOX_TOOLS = [
  "create_task", "reschedule_task", "complete_task", "complete_habit",
  "upsert_idea", "append_journal_entry", "delete_task", "delete_habit"
] as const;
export type PhoneInboxTool = typeof PHONE_INBOX_TOOLS[number];

export interface PhoneInboxLine {
  id: string;
  line: number;
  text: string;
  date: string;
  terminated: boolean;
}

export interface PhoneInboxTurn {
  date: string;
  operationId?: string;
  assertCurrent: () => void;
  assertLineCurrent: () => Promise<void>;
}

export interface PhoneInboxRecord {
  id: string;
  line: number;
  status: "processing" | "saved" | "review" | "confirm" | "dismissed";
  message: string;
  tool?: PhoneInboxTool;
  action?: AgentActionSuggestion;
  operationId?: string;
  pendingOperationId?: string;
  undone?: boolean;
  sourceTerminated?: boolean;
}

export interface PhoneInboxDocument {
  version: 1;
  records: PhoneInboxRecord[];
}

export type PhoneInboxReceipt = PhoneInboxRecord & { sourceUnavailable?: true; sourceEditing?: true };
export type PhoneInboxDecision = "confirm" | "dismiss" | "undo";

export interface PhoneInboxSnapshot {
  receipts: PhoneInboxReceipt[];
  source: "available" | "missing" | "unreadable";
  pending: number;
  unfinished: number;
  resolve?: (id: string, decision: PhoneInboxDecision) => Promise<void>;
}

export const phoneInboxLabels: Record<PhoneInboxTool, string> = {
  create_task: "新建任务", reschedule_task: "改期任务", complete_task: "完成任务",
  complete_habit: "习惯打卡", upsert_idea: "登记想法", append_journal_entry: "追加日记",
  delete_task: "删除任务", delete_habit: "删除习惯"
};

export function parsePhoneInbox(text: string, today: string, includeUnterminated = false): PhoneInboxLine[] {
  const occurrences = new Map<string, number>();
  const lines = text.replace(/^\uFEFF/u, "").split(/\r\n|\n|\r/u);
  if (!includeUnterminated) lines.pop();
  const blocks = new MarkdownBlocks();
  return lines.flatMap((raw, index) => {
    if (blocks.skip(raw, index === 0) || !raw.trim() || /^\s*#{1,6}(?:[ \t]|$)/u.test(raw)) return [];
    const hash = fileRevision(raw);
    const occurrence = (occurrences.get(hash) ?? 0) + 1;
    occurrences.set(hash, occurrence);
    const stamp = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\][ \t]*/u.exec(raw);
    // A damaged stamp must reach review before the text can become a dated write.
    const looksTimestamped = /^\s*[\[［]\s*[0-9０-９]{4}[-－][0-9０-９]{1,2}[-－][0-9０-９]{1,2}(?:\s|[Tt\]］]|$)/u.test(raw);
    let date = looksTimestamped ? "" : today;
    if (stamp && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(stamp[2])) date = normalizeJournalDate(stamp[1], today);
    const content = stamp ? raw.slice(stamp[0].length) : raw;
    return [{ id: `${hash}:${occurrence}`, line: index + 1, text: content, date,
      terminated: !includeUnterminated || index < lines.length - 1 }];
  });
}

export function isPhoneInboxTool(value: unknown): value is PhoneInboxTool {
  return typeof value === "string" && (PHONE_INBOX_TOOLS as readonly string[]).includes(value);
}

export function isPhoneInboxAction(value: unknown): value is AgentActionSuggestion {
  if (!value || typeof value !== "object") return false;
  const action = value as AgentActionSuggestion;
  return isSafeOperationId(action.id) && action.id.startsWith("proposal:local:agent-turn:")
    && ["delete_task", "delete_habit"].includes(action.type)
    && typeof action.title === "string" && typeof action.description === "string" && typeof action.content === "string";
}

export function phoneInboxOperationId(value: unknown): value is string {
  return typeof value === "string" && /^local:agent-turn:[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}:phone$/u.test(value);
}

export function validPhoneInboxDocument(value: unknown): value is PhoneInboxDocument {
  if (!value || typeof value !== "object") return false;
  const { version, records } = value as PhoneInboxDocument;
  if (version !== 1 || !Array.isArray(records)) return false;
  const seen = new Set<string>();
  return records.every(row => {
    if (!row || !/^[a-f\d]{64}:[1-9]\d*$/u.test(row.id) || seen.has(row.id)
      || !Number.isSafeInteger(row.line) || row.line < 1 || typeof row.message !== "string" || row.message.length > 2000
      || !["processing", "saved", "review", "confirm", "dismissed"].includes(row.status)
      || row.tool !== undefined && !isPhoneInboxTool(row.tool)
      || row.operationId !== undefined && !isSafeOperationId(row.operationId)
      || row.pendingOperationId !== undefined && (!phoneInboxOperationId(row.pendingOperationId)
        || row.status !== "processing" && row.status !== "review")
      || row.status === "confirm" && !isPhoneInboxAction(row.action)
      || row.action !== undefined && (row.status !== "confirm" || !isPhoneInboxAction(row.action))
      || row.sourceTerminated !== undefined && typeof row.sourceTerminated !== "boolean"
      || row.undone !== undefined && (typeof row.undone !== "boolean" || !row.operationId)) return false;
    seen.add(row.id);
    return true;
  });
}
