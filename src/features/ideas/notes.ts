import { randomUUID } from "node:crypto";
import { parseYaml, stringifyYaml } from "obsidian";
import { addDays, formatDate, normalizeJournalDate } from "../../date";
import { guardedOperationIdentity } from "../../dataFoundation/factOperation";
import { readScopedMarkdown } from "../../dataFoundation/markdownSources";
import { fileRevision } from "../../operationIdentity";
import { isVaultPathExcluded } from "../../privacy";
import { isContextSourcePath } from "../../sourceReferences";
import { safeFilename, type StoreHost } from "../../store/settingsSlice";
import { externalPrefix, resolveExternalSource } from "../externalVault/catalog";

export const IDEA_STATES = {
  seed: "刚冒出", exploring: "研究中", validating: "验证中", building: "在做", parked: "暂停", dropped: "放弃"
} as const;
export type IdeaStatus = keyof typeof IDEA_STATES;

export interface IdeaFields {
  lifeops: "idea";
  ideaId: string;
  status: IdeaStatus;
  created: string;
  lastProgress: string;
  nextAction: string;
  nextReview: string;
  sources: string[];
  ideaReminderDays?: string[];
}

export interface IdeaNote extends IdeaFields {
  path: string;
  title: string;
  description: string;
  revision: string;
}

interface MarkdownParts { bom: string; yaml: string; body: string; newline: string }

export function splitIdeaNote(raw: string): MarkdownParts {
  const bom = raw.startsWith("\ufeff") ? "\ufeff" : "", text = raw.slice(bom.length);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const opening = /^---[ \t]*\r?\n/.exec(text);
  if (!opening) return { bom, yaml: "", body: text, newline };
  const afterOpening = text.slice(opening[0].length);
  const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(afterOpening);
  if (!closing) throw new Error("笔记属性没有结束标记，请先核对。");
  return { bom, yaml: afterOpening.slice(0, closing.index), body: afterOpening.slice(closing.index + closing[0].length), newline };
}

export function readIdeaProperties(raw: string): Record<string, unknown> {
  const { yaml } = splitIdeaNote(raw);
  const fields: unknown = yaml.trim() ? parseYaml(yaml) : {};
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("笔记属性格式不正确。");
  return fields as Record<string, unknown>;
}

function serializeProperties(parts: MarkdownParts, fields: Record<string, unknown>): string {
  const eol = parts.newline;
  const yaml = stringifyYaml(fields).trimEnd().replace(/\r?\n/g, eol);
  return parts.bom + "---" + eol + yaml + eol + "---" + eol + parts.body;
}

export function isIdeaStatus(value: unknown): value is IdeaStatus {
  return typeof value === "string" && Object.hasOwn(IDEA_STATES, value);
}

export function isIdeaNotePath(store: StoreHost, path: string): boolean {
  const { ideas, aiReports } = store.settings.folders;
  return !!ideas && isContextSourcePath(path) && !path.split("/").some(part => part.startsWith(".") || part.includes("[") || part.includes("]"))
    && path.endsWith(".md") && path.startsWith(ideas + "/") && !path.startsWith(ideas + "/每日记录/")
    && !path.startsWith(aiReports + "/") && !isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes);
}

export function ideaLink(path: string): string {
  return path.startsWith(externalPrefix + "/") ? path : "[[" + path.replace(/\.md$/i, "") + "]]";
}
export const ideaTitleKey = (title: string) => title.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
export const ideaDaysStalled = (lastProgress: string, today: string) => Math.max(0, Math.round((Date.parse(today) - Date.parse(lastProgress)) / 86_400_000));

const noteDate = (value: unknown): string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  ? normalizeJournalDate(value) : "";
const descriptionFrom = (raw: string) => splitIdeaNote(raw).body.trim().replace(/^# [^\n]*\r?\n\s*/, "").slice(0, 600).trim();

export function ideaNoteFromMarkdown(path: string, title: string, raw: string): IdeaNote | undefined {
  const fields = readIdeaProperties(raw);
  if (fields.lifeops !== "idea") return undefined;
  const created = noteDate(fields.created), lastProgress = noteDate(fields.lastProgress), nextReview = noteDate(fields.nextReview);
  if (!isIdeaStatus(fields.status) || !created || !lastProgress || !nextReview || typeof fields.nextAction !== "string"
    || !Array.isArray(fields.sources) || fields.sources.some(source => typeof source !== "string")
    || fields.ideaReminderDays !== undefined && (!Array.isArray(fields.ideaReminderDays) || fields.ideaReminderDays.some(day => !noteDate(day)))
    || fields.ideaId !== undefined && (typeof fields.ideaId !== "string" || !/^idea-[a-z0-9-]{12,80}$/.test(fields.ideaId))) {
    throw new Error("想法属性不完整，请先核对。");
  }
  const heading = /^\s*# +([^\r\n]+)/.exec(splitIdeaNote(raw).body)?.[1].trim();
  return { lifeops: "idea", ideaId: (fields.ideaId as string | undefined) ?? "idea-" + fileRevision(path).slice(0, 24),
    status: fields.status, created, lastProgress, nextReview, nextAction: fields.nextAction, sources: fields.sources,
    ideaReminderDays: fields.ideaReminderDays as string[] | undefined,
    path, title: heading || title, description: descriptionFrom(raw), revision: fileRevision(raw) };
}

export function ideaFields(created: string, nextAction = "", sources: string[] = []): IdeaFields {
  return { lifeops: "idea", ideaId: "idea-" + randomUUID(), status: "seed", created, lastProgress: created,
    nextAction: nextAction.trim(), nextReview: addDays(created, 14), sources: [...new Set(sources)] };
}

export async function listIdeas(store: StoreHost): Promise<IdeaNote[]> {
  const items: IdeaNote[] = [];
  for (const file of store.app.vault.getMarkdownFiles()) {
    if (!isIdeaNotePath(store, file.path)) continue;
    try {
      const raw = await readIdeaSource(store, file.path);
      const note = ideaNoteFromMarkdown(file.path, file.basename, raw);
      if (note) items.push(note);
    } catch { /* Keep malformed originals outside the registered list. */ }
  }
  return items.sort((a, b) => b.lastProgress.localeCompare(a.lastProgress) || a.path.localeCompare(b.path));
}

export async function readIdeaSource(store: StoreHost, path: string): Promise<string> {
  if (!path.startsWith(externalPrefix + "/")) return readScopedMarkdown(store, path);
  const source = resolveExternalSource(store, path);
  if (!source) throw Error("外部想法来源已排除或失效。");
  return source.reader.read(source.path);
}

function assertIdeaWrite(store: StoreHost): void {
  const identity = guardedOperationIdentity(store);
  if (!identity || identity.purpose === "derived") throw new Error("想法须通过可撤销的保存入口写入。");
}

export async function createIdeaNote(store: StoreHost, title: string, body: string, fields: IdeaFields): Promise<IdeaNote> {
  assertIdeaWrite(store);
  const name = safeFilename(title.trim()).slice(0, 120);
  if (!name || !body.trim()) throw new Error("请填写想法标题和内容。");
  const folder = store.settings.folders.ideas;
  let path = store.path(folder, name + ".md");
  if (store.getFile(path)) path = store.path(folder, name + " " + fields.ideaId.slice(5, 13) + ".md");
  if (!isIdeaNotePath(store, path) || store.getFile(path)) throw new Error("想法笔记位置不可写，请先核对设置。");
  const raw = serializeProperties({ bom: "", yaml: "", body: "\n# " + title.trim() + "\n\n" + body.trim() + "\n", newline: "\n" }, { ...fields });
  await store.writeFile(path, raw);
  return ideaNoteFromMarkdown(path, name, raw)!;
}

export async function updateIdeaNote(store: StoreHost, note: IdeaNote, patch: Partial<Pick<IdeaFields,
  "status" | "lastProgress" | "nextAction" | "nextReview" | "sources" | "ideaReminderDays">>): Promise<IdeaNote> {
  assertIdeaWrite(store);
  const file = isIdeaNotePath(store, note.path) ? store.getFile(note.path) : null;
  if (!file || file.path !== note.path) throw new Error("找不到想法笔记，请刷新。");
  if (fileRevision(await readIdeaSource(store, note.path)) !== note.revision) throw new Error("想法已变化，请刷新后再保存。");
  const raw = await store.app.vault.process(file, current => {
    if (fileRevision(current) !== note.revision) throw new Error("想法已变化，请刷新后再保存。");
    const next = serializeProperties(splitIdeaNote(current), { ...readIdeaProperties(current), ideaId: note.ideaId, ...patch });
    if (!ideaNoteFromMarkdown(note.path, note.title, next)) throw new Error("更新后的想法属性无效。");
    return next;
  });
  return ideaNoteFromMarkdown(note.path, note.title, raw)!;
}

export function datedIdeaFile(time: number, now: Date): string {
  return Number.isFinite(time) && time > 0 && time <= now.getTime() ? formatDate(new Date(time)) : formatDate(now);
}
