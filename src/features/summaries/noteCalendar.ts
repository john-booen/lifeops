import { addDays, parseLocalDate } from "../../date";

/** Calendar context is derived from the note date, not an assertion about events. */
export function noteCalendar(date: string) {
  const day = (offset: number) => {
    const value = addDays(date, offset);
    return { date: value, weekday: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][parseLocalDate(value).getDay()] };
  };
  const yesterday = day(-1), today = day(0), tomorrow = day(1);
  return { basis: "仅在该段原话以笔记日期为叙述时点时使用；原话另有明确日期或引用时，以原叙述时点为准。这是日历参照，事件日期及完成状态仍须读原话。",
    yesterday, today, tomorrow, relativeWords: {
      昨天: yesterday.date, 昨晚: yesterday.date, 今天: today.date, 今早: today.date, 今天凌晨: today.date, 明天: tomorrow.date
    } };
}
