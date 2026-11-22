/** Display aliases only; the expected group must already allow a yearless date. */
export function hasEquivalentDateAlias(reply: string, alternatives: string[]): boolean {
  if (alternatives.length < 2) return false;
  const dates = alternatives.map(text => {
    let match = /^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})$/.exec(text);
    if (match) return { year: match[1], month: Number(match[2]), day: Number(match[3]) };
    match = /^(\d{1,2})月(\d{1,2})日$/.exec(text);
    return match ? { year: undefined, month: Number(match[1]), day: Number(match[2]) } : undefined;
  });
  const first = dates[0];
  if (!first || !dates.some(date => date?.year === undefined) || dates.some(date => !date || date.month !== first.month || date.day !== first.day)) return false;
  const years = [...new Set(dates.flatMap(date => date?.year ? [date.year] : []))];
  if (years.length > 1 || first.month < 1 || first.month > 12 || first.day < 1
    || first.day > new Date(Number(years[0] ?? 2024), first.month, 0).getDate()) return false;
  const number = (value: number) => value < 10 ? "0?" + value : String(value);
  const monthDay = number(first.month) + "/" + number(first.day);
  return new RegExp("(?<![\\d/])(?:" + (years.length ? years[0] + "/" + monthDay + "|" : "") + monthDay + ")(?![\\d/])", "u").test(reply);
}
