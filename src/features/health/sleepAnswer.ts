export function deviceSleepAnswer(output: string): string {
  const data = JSON.parse(output) as { range: { from: string; to: string }; sleepHours?: { average: number | null; recordedDays: number }; scope?: string };
  const { from, to } = data.range;
  const days = from === to ? from : `${from} 至 ${to}`;
  const sleep = data.sleepHours;
  const scope = data.scope ? "只统计允许读取的健康记录。" : "";
  if (!sleep?.recordedDays || sleep.average === null) return `${days} 暂无可读的设备睡眠记录。${scope}`;
  return `${days} 有 ${sleep.recordedDays} 天设备睡眠记录，平均 ${sleep.average} 小时。${scope}`;
}
