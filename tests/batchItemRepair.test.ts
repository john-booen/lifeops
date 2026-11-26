import { expect, it } from "vitest";
import type { AiToolCall } from "../src/ai";
import { repairedBatchItems } from "../src/agent/batchItemRepair";

const call = (patch: Record<string, unknown> = {}): AiToolCall => ({name: "schedule_task_batch", arguments: {
  date: "2026-11-26", availableEnd: "22:00", tasks: [
    {title: "虚构蓝鲸清单", estimateMin: "30", category: null, priority: "medium", dueDate: "2026-11-27", dueTime: "17:00"},
    {title: "虚构星河纸样", estimateMin: 20, category: "work"}
  ], ...patch}});
const good = (): AiToolCall => call({tasks: [
  {title: "虚构蓝鲸清单", estimateMin: 30, dueDate: "2026-11-27", dueTime: "17:00"},
  {title: "虚构星河纸样", estimateMin: 20, category: "work"}
]});

it("allows representation repair with identical titles, order, numeric duration and deadline", () => {
  const next = good(); expect(repairedBatchItems(call(), [next])).toBe(next);
});
it.each(["drop", "add", "reverse", "title", "duration", "date", "availability", "deadline", "category", "extra", "multiple"])("refuses a repair that changes frozen semantics: %s", kind => {
  const next = good(), rows = next.arguments.tasks as Record<string, unknown>[];
  if (kind === "drop") rows.pop();
  if (kind === "add") rows.push({...rows[1], title: "虚构额外任务"});
  if (kind === "reverse") rows.reverse();
  if (kind === "title") rows[0].title = "虚构改名不能算格式修复";
  if (kind === "duration") rows[0].estimateMin = 25;
  if (kind === "date") next.arguments.date = "2026-11-27";
  if (kind === "availability") delete next.arguments.availableEnd;
  if (kind === "deadline") rows[0].dueDate = "2026-11-28";
  if (kind === "category") rows[1].category = "life";
  if (kind === "extra") rows[0].note = "虚构新附加字段";
  expect(repairedBatchItems(call(), kind === "multiple" ? [next, next] : [next])).toBeUndefined();
});
it.each(["30分钟", -1, 721, 2.5, null, false])("does not invent a duration for an unprovable invalid estimate %s", estimateMin => {
  const old = call(), rows = old.arguments.tasks as Record<string, unknown>[]; rows[0].estimateMin = estimateMin;
  expect(repairedBatchItems(old, [good()])).toBeUndefined();
});
