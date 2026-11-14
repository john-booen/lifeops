import { IDEA_STATES, ideaDaysStalled, ideaTitleKey, listIdeas, updateIdeaNote, type IdeaNote, type IdeaStatus } from "./notes";
import type { StoreHost } from "../../store/settingsSlice";

export const ideaIsActive = (idea: IdeaNote) => idea.status !== "parked" && idea.status !== "dropped";

export function ideaStatusQuestion(message: string): string | undefined {
  const match = /^(?:请问[，, ]*)?([^？?，,。；;\r\n]{1,80}?)(?:(?:这[个项]想法)\s*)?(?:(?:现在什么情况|目前进展如何|现在进展如何)[？?，,]\s*)?(?:多久没进展了?(?:[？?，,]\s*记录的下一步是什么)?|记录的下一步是什么)[。？?]?$/u.exec(message.trim());
  return match?.[1].trim().replace(/^[「『“"]|[」』”"]$/gu, "").trim() || undefined;
}

export function formatIdeaStatus(output: string, title: string): string {
  const list = JSON.parse(output) as { total: number; ideas: Array<Pick<IdeaNote, "title" | "status" | "nextAction"> & { daysStalled: number }> };
  const matches = list.ideas.filter(idea => ideaTitleKey(idea.title) === ideaTitleKey(title));
  if (list.total > list.ideas.length || matches.length > 1) return "暂时无法定位唯一的想法，请核对完整标题。";
  if (!matches.length) return "没有查到这个标题的已登记想法。";
  const [idea] = matches;
  const age = idea.daysStalled === 0 ? "今天有进展记录。" : `已有 ${idea.daysStalled} 天没有进展。`;
  const next = idea.nextAction ? `记录的下一步是${idea.nextAction}。` : "目前没有填写下一步。";
  return `「${idea.title}」目前是${IDEA_STATES[idea.status]}状态。${age}${next}`;
}

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
