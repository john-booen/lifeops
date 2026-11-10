import type { StoreHost } from "./store/settingsSlice";

export type ActivityDomain = "tasks" | "habits" | "ideas" | "tradingModels";

export const ACTIVITY_LABELS: Record<ActivityDomain, string> = {
  tasks: "任务记录", habits: "打卡记录", ideas: "知识记录", tradingModels: "交易学习记录"
};

/** Business activity belongs to its own domain; personal journals remain prose. */
export function activityNotePath(store: StoreHost, domain: ActivityDomain, date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Object.hasOwn(ACTIVITY_LABELS, domain)) {
    throw new Error("记录日期或分类不正确。");
  }
  return store.path(store.settings.folders[domain], "每日记录", `${date}.md`);
}
