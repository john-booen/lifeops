import { normalizePath } from "obsidian";
import { normalizeJournalDate } from "../../date";
import { isVaultPathExcluded } from "../../privacy";
import { isGuardedOperationScope } from "../../dataFoundation/factOperation";
import { readScopedMarkdown } from "../../dataFoundation/markdownSources";
import type { StoreHost } from "../../store/settingsSlice";
import type { HealthEntry } from "../../types";
import { healthDay, healthMetricKeys, readHealthMarkdown, type HealthDay } from "./model";

export function healthNotePath(store: StoreHost, date: string): string {
  return store.path(store.settings.folders.health, `${date}.md`);
}

export function healthPathAllowed(store: StoreHost, date: string): boolean {
  return !isVaultPathExcluded(healthNotePath(store, date), store.settings.privacy?.excludedVaultPrefixes);
}

export async function readHealthDay(store: StoreHost, date: string): Promise<HealthDay> {
  const path = healthNotePath(store, date);
  if (!healthPathAllowed(store, date) || !store.getFile(path)) return { date };
  const text = isGuardedOperationScope(store) ? await store.readPath(path) : await readScopedMarkdown(store, path);
  return healthPathAllowed(store, date) ? readHealthMarkdown(date, text) : { date };
}

export async function readHealthRange(store: StoreHost, from: string, to: string): Promise<{ days: HealthDay[]; partial: boolean }> {
  const folder = normalizePath(store.settings.folders.health);
  const files = store.app.vault.getMarkdownFiles().flatMap(file => {
    if (!file.path.startsWith(folder + "/")) return [];
    const rest = file.path.slice(folder.length + 1);
    const date = /^(\d{4}-\d{2}-\d{2})\.md$/u.exec(rest)?.[1];
    return date && date >= from && date <= to && normalizeJournalDate(date) === date ? [date] : [];
  }).sort();
  let partial = false;
  const days: HealthDay[] = [];
  for (const date of files) {
    if (!healthPathAllowed(store, date)) { partial = true; continue; }
    const row = await readHealthDay(store, date).catch(() => undefined);
    if (!row || !healthPathAllowed(store, date)) { partial = true; continue; }
    if (healthMetricKeys.some(key => row[key] !== undefined)) days.push(row);
  }
  return { days, partial };
}

export async function recordHealthEntries(store: StoreHost, entries: readonly HealthEntry[]): Promise<number> {
  let saved = 0;
  for (const input of entries) {
    const { date, ...metrics } = healthDay(input.date, input);
    if (!healthPathAllowed(store, date)) throw Error("健康记录目录已排除。");
    const existing = await readHealthDay(store, date);
    const changed = Object.fromEntries(healthMetricKeys.flatMap(key =>
      metrics[key] !== undefined && metrics[key] !== existing[key] ? [[key, metrics[key]]] : []));
    const extras = { exercise: input.exercise?.trim() || undefined, fatigue: input.fatigue, energy: input.energy, note: input.note?.trim() || undefined };
    if (!Object.keys(changed).length && Object.values(extras).every(value => value === undefined)) continue;
    await store.appendHealthEntry({ date, ...changed, ...extras });
    const checked = await readHealthDay(store, date);
    if (healthMetricKeys.some(key => Object.hasOwn(changed, key) && checked[key] !== metrics[key])) throw Error("健康记录未能读回核对。");
    saved++;
  }
  return saved;
}
