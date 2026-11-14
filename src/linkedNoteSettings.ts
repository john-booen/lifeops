import type { LifeOpsSettings } from "./types";

export const DEFAULT_LINKED_NOTE_NAMES = { knowledge: "知识沉淀.md", trading: "交易模型迭代.md" } as const;
const legacyNames = { knowledge: "Cici 知识沉淀.md", trading: "Cici 交易模型迭代.md" } as const;
export type LinkedNoteKind = keyof typeof DEFAULT_LINKED_NOTE_NAMES;

export function normalizeLinkedNoteName(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim().replace(/\.md$/iu, "");
  return text && text.length <= 120 && !/^\./u.test(text) && !/[\\/:*?"<>|\[\]#^\r\n\u0000-\u001f]/u.test(text)
    ? text + ".md" : "";
}

export function migrateLinkedNoteNames(saved: Partial<LifeOpsSettings>): Record<LinkedNoteKind, string> {
  const fallback = saved.folders || saved.setupComplete ? legacyNames : DEFAULT_LINKED_NOTE_NAMES;
  return {
    knowledge: normalizeLinkedNoteName(saved.linkedNoteNames?.knowledge) || fallback.knowledge,
    trading: normalizeLinkedNoteName(saved.linkedNoteNames?.trading) || fallback.trading
  };
}

export function linkedNoteName(settings: LifeOpsSettings, kind: LinkedNoteKind): string {
  return normalizeLinkedNoteName(settings.linkedNoteNames?.[kind]) || DEFAULT_LINKED_NOTE_NAMES[kind];
}
