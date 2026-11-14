import { selectPersonalMemories, type PersonalMemoryRecord } from "../personalMemory";
import { createPersonalMemoryContextFilter } from "../personalMemoryContext";

const scheduleQuestion = /^(?:请问[，, ]*)?(?:我)?(?:每)?(?:周|星期)([一二三四五六日天])(早上|上午|中午|下午|傍晚|晚上|晚)(?:固定)?(?:有(?:什么|哪些)(?:安排|活动|事情)?|安排了什么|要做什么)[？?。]?$/u;

export function recurringScheduleAnswer(message: string, memories: PersonalMemoryRecord[], now: Date): string | undefined {
  const question = scheduleQuestion.exec(message.trim());
  if (!question) return;
  const weekday = /[日天]/u.test(question[1]) ? "[日天]" : question[1];
  const period = /^晚/u.test(question[2]) ? "晚(?:上)?" : question[2];
  const recurring = new RegExp(`^(?:我)?(?:(?:每|固定)(?:周|星期)${weekday}${period}|(?:周|星期)${weekday}${period}固定)[^，,。；;？！!?\\r\\n]+`, "u");
  const protect = createPersonalMemoryContextFilter(memories);
  const facts = selectPersonalMemories(memories, "", memories.length, now).flatMap(record => {
    if (record.summarySource || !record.confirmedAt || record.content.length > 90 || !recurring.test(record.content)
      || /[，,；;？！!?\r\n]|取消|暂停|改到|不再|改期|如果/u.test(record.content)) return [];
    return protect(record.content) === record.content ? [record.content.replace(/[。]$/u, "")] : [];
  });
  if (facts.length) return `已确认的固定安排：${[...new Set(facts)].join("；")}。`;
}
