export function clockMatches(text: string): RegExpMatchArray[] {
  return [...text.matchAll(/(?:(凌晨|早上|上午|中午|下午|傍晚|晚上|今晚)\s*)?([\d零〇一二两三四五六七八九十百]+)\s*(?:[:：]([\d零〇一二两三四五六七八九十百]+)|[点时]\s*(?:(半|一刻|三刻)|([\d零〇一二两三四五六七八九十百]+)\s*(分)?)?)(?:钟)?(?:整(?=$|[\s，,。；;]|开始))?/gu)];
}

export function clockFromMatch(match: RegExpMatchArray): string | null {
  let hour = clockNumber(match[2]);
  const minute = match[4] === "半" ? 30 : match[4] === "一刻" ? 15 : match[4] === "三刻" ? 45 : clockNumber(match[3] ?? match[5] ?? "0");
  if (hour === null || minute === null || hour > 23 || minute > 59) return null;
  const period = match[1];
  if (period === "上午" || period === "早上") {
    if (hour >= 12) return null;
  } else if (period === "凌晨") {
    if (hour === 12) hour = 0;
    if (hour > 6) return null;
  } else if (period === "中午") {
    if (hour === 1) hour = 13;
    if (hour < 11 || hour > 13) return null;
  } else if (period) {
    if (hour === 0) return null;
    // These night-time readings can refer to the next calendar day.
    if ((period === "晚上" || period === "今晚") && (hour < 6 || hour === 12)) return null;
    if (period === "傍晚" && !(hour >= 5 && hour <= 7 || hour >= 17 && hour <= 19)) return null;
    if (hour < 12) hour += 12;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function clockNumber(value: string): number | null {
  if (/^\d{1,2}$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value in digits) return digits[value];
  if (/^[零〇][一二三四五六七八九]$/.test(value)) return digits[value[1]];
  if (/^[二两三四五六七八九]?十[一二三四五六七八九]?$/.test(value)) {
    const [tens, units] = value.split("十");
    return (tens ? digits[tens] : 1) * 10 + (units ? digits[units] : 0);
  }
  return null;
}
