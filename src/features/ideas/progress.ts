import { ideaDaysStalled, listIdeas, updateIdeaNote, type IdeaNote, type IdeaStatus } from "./notes";
import type { StoreHost } from "../../store/settingsSlice";

export const ideaIsActive = (idea: IdeaNote) => idea.status !== "parked" && idea.status !== "dropped";

export function ideaIsStalled(idea: IdeaNote, today: string): boolean {
  const threshold = idea.status === "seed" ? 14 : 7;
  return ideaIsActive(idea) && (ideaDaysStalled(idea.lastProgress, today) > threshold || idea.nextReview < today);
}

export function ideaRemindersSinceProgress(idea: IdeaNote, today: string): string[] {
  return [...new Set(idea.ideaReminderDays ?? [])].filter(day => day >= idea.lastProgress && day <= today).sort();
}

export async function findIdea(store: StoreHost, id: string): Promise<IdeaNote> {
  const matches = (await listIdeas(store)).filter(idea => idea.ideaId === id);
  if (matches.length !== 1) throw new Error("找不到唯一匹配的想法，请刷新后选择。");
  return matches[0];
}

export async function setIdeaStatus(store: StoreHost, idea: IdeaNote, decision: IdeaStatus | "continue"): Promise<IdeaNote> {
  const status = decision === "continue" ? (ideaIsActive(idea) ? idea.status : "exploring") : decision;
  const clearReminders = decision === "continue" || !ideaIsActive(idea) || status === "parked" || status === "dropped";
  if (status === idea.status && (!clearReminders || !idea.ideaReminderDays?.length)) return idea;
  return updateIdeaNote(store, idea, { status, ...(clearReminders ? { ideaReminderDays: [] } : {}) });
}

export async function completeLinkedIdeaTask(store: StoreHost, id: string, today: string): Promise<void> {
  const matches = (await listIdeas(store)).filter(idea => idea.ideaId === id);
  if (matches.length !== 1 || matches[0].lastProgress > today) return;
  const idea = matches[0];
  if (idea.lastProgress === today && !idea.ideaReminderDays?.length) return;
  await updateIdeaNote(store, idea, { lastProgress: today, ideaReminderDays: [] });
}

/** Called by the reminder delivery entry point, after its own daily limits. */
export async function recordIdeaReminder(store: StoreHost, id: string, today: string): Promise<string | undefined> {
  const idea = await findIdea(store, id);
  const reminders = ideaRemindersSinceProgress(idea, today);
  if (!ideaIsStalled(idea, today) || reminders.includes(today)) return;
  await updateIdeaNote(store, idea, { ideaReminderDays: [...reminders.slice(-3), today] });
  const duration = ideaDaysStalled(idea.lastProgress, today);
  return reminders.length >= 3
    ? "「" + idea.title + "」已经 " + duration + " 天没有进展。你想继续、暂停还是放弃？"
    : "「" + idea.title + "」已有 " + duration + " 天没有进展。" + (idea.nextAction ? "下一步是" + idea.nextAction + "。" : "");
}
