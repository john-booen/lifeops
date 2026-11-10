import type { TFile } from "obsidian";
import type { StoreHost } from "./store/settingsSlice";
import type { NeuralDomain, NeuralRecordDetail, NeuralRecordRelation, NeuralRecordsAdapter, NeuralRecordSummary } from "./panel/neuralRecordsModel";
import { isContextSourcePath } from "./sourceReferences";
import { isVaultPathExcluded } from "./privacy";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";

interface ReadOptions { signal: AbortSignal; assertCurrent?: () => void }
export interface ReadonlyRecordLibrary extends NeuralRecordsAdapter {
  openRelation(recordId: string, relationId: string, options: ReadOptions): Promise<void>;
}

const recordId = (path: string) => `record:${path}`;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const within = (path: string, folder: string) => path.startsWith(`${folder}/`);
const safe = (path: string) => isContextSourcePath(path) && path.split("/").every(part => !part.startsWith("."));
function recordDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value) return value;
}

/** A transient, read-only projection. The catalog contains metadata only; a
 * selected note is read through the existing short-lived source guard. IDs
 * are issued by this catalog, never accepted as arbitrary paths from the UI. */
export function createReadonlyRecordLibrary(
  store: StoreHost,
  openFile: (file: TFile, signal: AbortSignal) => Promise<void>,
  assertOwner: () => void = () => {}
): ReadonlyRecordLibrary {
  let catalog = new Map<string, string>();
  let visible = new Set<string>();
  const displayed = new Map<string, { revision: string; relations: NeuralRecordRelation[] }>();
  const check = (options: ReadOptions) => {
    assertOwner();
    options.signal.throwIfAborted();
    options.assertCurrent?.();
  };
  const rules = () => {
    const f = store.settings.folders;
    return ([
      [f.dailyRoot, "life"], [f.inbox, "life"], [f.health, "life"],
      [f.tasks, "tasks"], [f.habits, "tasks"], [f.ideas, "learning"],
      [f.tradingModels, "trading"], [f.tradingReviews, "trading"],
      [f.goals, "projects"], [f.outputs, "learning"]
    ] as Array<[string, NeuralDomain]>).filter(([folder]) => safe(folder))
      .sort((a, b) => b[0].length - a[0].length);
  };
  function domainFor(path: string): NeuralDomain | undefined {
    if (!safe(path) || !path.endsWith(".md") || !store.isManagedSourcePath(path)
      || isVaultPathExcluded(path, store.settings.privacy?.excludedVaultPrefixes)) return;
    return rules().find(([folder]) => within(path, folder))?.[1];
  }
  function nativeFileAllowed(path: string): boolean {
    const adapter = store.app.vault.adapter as { getBasePath?: () => string } | undefined;
    if (typeof adapter?.getBasePath !== "function") return true;
    try {
      const base = adapter.getBasePath();
      if (!isAbsolute(base) || !safe(path)) return false;
      let current = realpathSync(base);
      const parts = path.split("/");
      for (let index = 0; index < parts.length; index++) {
        current = resolvePath(current, parts[index]);
        const entry = lstatSync(current);
        if (entry.isSymbolicLink() || (index < parts.length - 1
          ? !entry.isDirectory() : !entry.isFile() || entry.nlink !== 1)) return false;
      }
      return true;
    } catch { return false; }
  }
  function resolve(id: string, allowRelated = false): TFile {
    const path = catalog.get(id);
    if (!path || (!allowRelated && !visible.has(id)) || !domainFor(path) || !nativeFileAllowed(path)) throw Error("记录来源已失效，请刷新后重试。");
    const file = store.getFile(path);
    if (!file || file.path !== path || file.extension !== "md") throw Error("记录来源已失效，请刷新后重试。");
    return file;
  }
  function summary(file: TFile): NeuralRecordSummary {
    const f = store.settings.folders;
    const knownDaily = within(file.path, f.dailyRoot) ? /^(\d{4}-\d{2}-\d{2})(早|晚)\.md$/.exec(file.name) : null;
    const knownReview = within(file.path, f.tradingReviews) ? /^(\d{4}-\d{2}-\d{2})\.md$/.exec(file.name) : null;
    const date = recordDate(knownDaily?.[1] ?? knownReview?.[1]);
    const updated = file.stat?.mtime;
    return {
      id: recordId(file.path), path: file.path, title: file.basename, domain: domainFor(file.path)!,
      ...(date ? { date } : {}),
      ...(typeof updated === "number" && Number.isFinite(updated) && Math.abs(updated) <= 8.64e15
        ? { updatedAt: new Date(updated).toISOString() } : {}),
      kind: knownDaily ? knownDaily[2] === "早" ? "morning" : "evening" : knownReview ? "review" : "note"
    };
  }
  function relations(file: TFile, body: string): NeuralRecordRelation[] {
    const result: NeuralRecordRelation[] = [];
    // Cached link offsets must still match the selected raw note. Only exact
    // vault-relative targets are supported; no ambiguous basename resolution,
    // embeddings, external links or synthesized semantic associations.
    for (const link of store.app.metadataCache?.getFileCache(file)?.links ?? []) {
      const start = link.position?.start?.offset, end = link.position?.end?.offset;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start
        || body.slice(start, end) !== link.original) continue;
      const target = link.link.split("#")[0];
      const path = target.endsWith(".md") ? target : `${target}.md`;
      const id = recordId(path);
      if (id === recordId(file.path) || !catalog.has(id) || !domainFor(path) || !nativeFileAllowed(path) || result.some(item => item.id === id)) continue;
      const destination = store.getFile(path);
      if (!destination || destination.path !== path || destination.extension !== "md") continue;
      result.push({ id, path, title: destination.basename, kind: "link" });
    }
    return result;
  }
  async function read(id: string, options: ReadOptions, publish = true): Promise<NeuralRecordDetail> {
    check(options);
    const file = resolve(id);
    const policy = JSON.stringify([store.settings.folders, store.settings.privacy?.excludedVaultPrefixes]);

    const body = await store.app.vault.read(file);
    check(options);
    if (JSON.stringify([store.settings.folders, store.settings.privacy?.excludedVaultPrefixes]) !== policy) throw Error("记录权限已变化，请刷新。");
    resolve(id);
    const linked = relations(file, body);
    if (publish) displayed.set(id, { revision: hash(body), relations: linked.map(item => ({ ...item })) });
    return { ...summary(file), body, relations: linked };
  }
  async function open(id: string, options: ReadOptions, allowRelated = false): Promise<void> {
    check(options);
    const file = resolve(id, allowRelated);
    await openFile(file, options.signal);
    check(options);
  }
  return {
    async list(options) {
      check(options);
      const files = store.app.vault.getMarkdownFiles().filter(file => domainFor(file.path) && nativeFileAllowed(file.path));
      const rows = files.map(summary).sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.path.localeCompare(b.path));
      catalog = new Map(rows.map(row => [row.id, row.path]));
      const selected = rows.filter(row => options.domain === "all" || row.domain === options.domain);
      visible = new Set(selected.map(row => row.id)); displayed.clear();
      check(options); return selected;
    },
    read: (id, options) => read(id, options),
    open,
    async openRelation(id, relationId, options) {
      check(options);
      const shown = displayed.get(id);
      if (!shown || !shown.relations.some(item => item.id === relationId)) throw Error("关联来源已失效，请重新选择记录。");
      const policy = JSON.stringify([store.settings.folders, store.settings.privacy?.excludedVaultPrefixes]);


      const currentOptions: ReadOptions = { signal: options.signal, assertCurrent: () => {
        check(options);
        if (JSON.stringify([store.settings.folders, store.settings.privacy?.excludedVaultPrefixes]) !== policy) throw Error("记录权限已变化，请刷新。");
        resolve(id);
      } };
      const current = await read(id, currentOptions, false);
      check(currentOptions);
      if (hash(current.body) !== shown.revision || !current.relations.some(item => item.id === relationId)) throw Error("关联原文已变化，请重新选择记录。");
      await open(relationId, currentOptions, true);
    }
  };
}
