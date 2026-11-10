import { formatDate } from "../../date";
import type { StoreHost } from "../../store/settingsSlice";
import type { LocalOperationHost } from "../serviceHost";
import { assertIdeaCandidate, decideIdeaCandidates, type IdeaCandidate } from "./candidates";
import { createIdeaNote, ideaFields, ideaLink, ideaTitleKey, listIdeas, updateIdeaNote, type IdeaNote } from "./notes";
import { applyIdeaNoteRegistration, prepareIdeaNoteRegistration, type PreparedIdeaNote } from "./registerNote";

export interface IdeaDraft { title: string; description: string; nextAction?: string; mergeId?: string; sourcePath?: string }
export interface IdeaChoice { candidate: IdeaCandidate; mergeId?: string; mergeRevision?: string }

export function sameIdea(ideas: readonly IdeaNote[], title: string, mergeId?: string): IdeaNote | undefined {
  if (mergeId) {
    const matches = ideas.filter(idea => idea.ideaId === mergeId);
    if (matches.length !== 1) throw new Error("要合并的想法已变化，请重新查看列表。");
    return matches[0];
  }
  const matches = ideas.filter(idea => ideaTitleKey(idea.title) === ideaTitleKey(title));
  return matches.length === 1 ? matches[0] : undefined;
}

export async function upsertIdea(store: StoreHost, draft: IdeaDraft, now = new Date()): Promise<{ idea: IdeaNote; merged: boolean }> {
  const title = draft.title.trim(), body = draft.description.trim();
  if (!title || title.length > 150 || /[\r\n]/.test(title) || !body || body.length > 5000
    || draft.nextAction !== undefined && draft.nextAction.length > 500) throw new Error("请提供简短的想法标题和内容。");
  const existing = sameIdea(await listIdeas(store), title, draft.mergeId);
  const link = draft.sourcePath ? ideaLink(draft.sourcePath) : undefined;
  if (existing) {
    const nextAction = draft.nextAction?.trim() ?? existing.nextAction;
    const sources = link && !existing.sources.includes(link) ? [...existing.sources, link] : existing.sources;
    const idea = nextAction === existing.nextAction && sources === existing.sources
      ? existing : await updateIdeaNote(store, existing, { nextAction, sources });
    return { idea, merged: true };
  }
  return { idea: await createIdeaNote(store, title, body, ideaFields(formatDate(now), draft.nextAction, link ? [link] : [])), merged: false };
}

export async function registerIdeaCandidates(host: LocalOperationHost, base: StoreHost, choices: readonly IdeaChoice[],
  assertCurrent?: () => void): Promise<IdeaNote[]> {
  if (!choices.length) throw new Error("没有选中的想法。");
  const selected = structuredClone(choices);
  const initial = await listIdeas(base), prepared = new Map<string, PreparedIdeaNote>();
  for (const { candidate, mergeId, mergeRevision } of selected) {
    assertCurrent?.();
    await assertIdeaCandidate(base, candidate);
    const match = sameIdea(initial, candidate.title, mergeId);
    if (mergeRevision && match?.revision !== mergeRevision) throw new Error("相似想法已更新，请重新核对。");
    if (candidate.kind === "note" && !match) {
      prepared.set(candidate.id, await prepareIdeaNoteRegistration(base, candidate.path, candidate.revision, ideaFields(candidate.created)));
    }
  }

  let saved: IdeaNote[] = [], unchangedSources: IdeaCandidate[] = [];
  await host.saveLocalOperation("local_register_idea_candidates", { candidates: selected.map(({ candidate }) => candidate.id) }, async store => {
    saved = []; unchangedSources = [];
    await decideIdeaCandidates(store, selected.map(({ candidate }) => candidate.id), "registered");
    const ideas = await listIdeas(store);
    for (const { candidate, mergeId, mergeRevision } of selected) {
      if (mergeRevision && sameIdea(ideas, candidate.title, mergeId)?.revision !== mergeRevision) throw new Error("相似想法已更新，请重新核对。");
    }
    for (const { candidate, mergeId } of selected) {
      assertCurrent?.();
      await assertIdeaCandidate(store, candidate);
      const existing = sameIdea(ideas, candidate.title, mergeId);
      if (existing) {
        unchangedSources.push(candidate);
        const sources = [...new Set([...existing.sources, ideaLink(candidate.path)])];
        const note = sources.length === existing.sources.length ? existing : await updateIdeaNote(store, existing, { sources });
        ideas[ideas.indexOf(existing)] = note;
        saved.push(note);
      } else if (candidate.kind === "note") {
        const registration = prepared.get(candidate.id);
        if (!registration) throw new Error("可合并的想法已变化，请刷新后再确认。");
        const note = await applyIdeaNoteRegistration(store, registration);
        ideas.push(note); saved.push(note);
      } else {
        unchangedSources.push(candidate);
        const note = await createIdeaNote(store, candidate.title, candidate.description, ideaFields(candidate.created, "", [ideaLink(candidate.path)]));
        ideas.push(note); saved.push(note);
      }
    }
  }, { assertCurrent, assertBeforeCommit: async () => {
    for (const candidate of unchangedSources) await assertIdeaCandidate(base, candidate);
  } });
  await host.refreshViews().catch(() => undefined);
  return saved;
}

export async function ignoreIdeaCandidate(host: LocalOperationHost, candidate: IdeaCandidate): Promise<void> {
  await host.saveLocalOperation("local_ignore_idea_candidate", { candidate: candidate.id }, async store => {
    await assertIdeaCandidate(store, candidate);
    await decideIdeaCandidates(store, [candidate.id], "ignored");
  });
  await host.refreshViews().catch(() => undefined);
}
