import { isContextSourcePath } from "../../sourceReferences";
import { isLearningTrackId, type LearningTrackId } from "../learning/model";

export interface ReadingEntry {
  path: string;
  title: string;
  summary: string;
  ideaIds: string[];
  trackIds: LearningTrackId[];
  keywords: string[];
  sourceRevision: string;
  updatedAt: string;
}
export interface ReadingDocument { version: 1; entries: ReadingEntry[] }

export function readingText(value: unknown, max: number): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= max && !/[\r\n]/.test(value);
}

export function validReadingDocument(value: unknown): value is ReadingDocument {
  const doc = value as ReadingDocument | undefined;
  if (!doc || doc.version !== 1 || !Array.isArray(doc.entries) || doc.entries.some(entry =>
    !entry || !isContextSourcePath(entry.path) || !entry.path.endsWith(".md") || !readingText(entry.title, 200) || !readingText(entry.summary, 400)
    || !Array.isArray(entry.ideaIds) || entry.ideaIds.some(id => typeof id !== "string" || !/^idea-[a-z0-9-]{12,80}$/.test(id))
    || !Array.isArray(entry.trackIds) || entry.trackIds.some(id => !isLearningTrackId(id))
    || !Array.isArray(entry.keywords) || entry.keywords.length !== 3 || entry.keywords.some(keyword => !readingText(keyword, 50))
    || new Set(entry.keywords.map(keyword => keyword.toLowerCase())).size !== 3
    || typeof entry.sourceRevision !== "string" || !/^[a-f0-9]{64}$/.test(entry.sourceRevision)
    || typeof entry.updatedAt !== "string" || !Number.isFinite(Date.parse(entry.updatedAt)))) return false;
  return new Set(doc.entries.map(entry => entry.path)).size === doc.entries.length;
}

export function parseReadingFolders(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map(line => line.trim().replace(/\/+$/, ""))
    .filter(path => isContextSourcePath(path) && !path.split("/").some(part => part.startsWith("."))))];
}
