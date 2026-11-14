import type { LifeOpsSettings } from "./types";

export const DEFAULT_LINKED_NOTE_NAMES = { knowledge: "知识沉淀.md", trading: "交易模型迭代.md" } as const;
export type LinkedNoteKind = keyof typeof DEFAULT_LINKED_NOTE_NAMES;

export function normalizeLinkedNoteName(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim().replace(/\.md$/iu, "");
  return text && text.length <= 120 && !/^\./u.test(text) && !/[\\/:*?"<>|\[\]#^\r\n\u0000-\u001f]/u.test(text)
    ? text + ".md" : "";
}

export function linkedNoteName(settings: LifeOpsSettings, kind: LinkedNoteKind): string {
  return normalizeLinkedNoteName(settings.linkedNoteNames?.[kind]) || DEFAULT_LINKED_NOTE_NAMES[kind];
}

/** Reuse an unambiguous installed note with the expected suffix and no configured name. */
export function discoverLinkedNoteNames(settings: LifeOpsSettings, files: readonly { path: string; name: string }[]): Record<LinkedNoteKind, string> {
  function resolve(kind: LinkedNoteKind, root: string): string {
    const configured = normalizeLinkedNoteName(settings.linkedNoteNames?.[kind]);
    if (configured) return configured;
    const suffix = DEFAULT_LINKED_NOTE_NAMES[kind];
    const matches = files.filter(file => file.path === root + "/" + file.name && normalizeLinkedNoteName(file.name) === file.name
      && (file.name === suffix || file.name.endsWith(" " + suffix)));
    return matches.find(file => file.name === suffix)?.name ?? (matches.length === 1 ? matches[0].name : suffix);
  }
  return { knowledge: resolve("knowledge", settings.folders.ideas), trading: resolve("trading", settings.folders.tradingModels) };
}
