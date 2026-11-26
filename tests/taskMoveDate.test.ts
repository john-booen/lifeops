import { expect, it, vi } from "vitest";
import type { AiToolCall } from "../src/ai";
import type { StoreHost } from "../src/store/settingsSlice";
const data = vi.hoisted(() => ({ available: true, tasks: [] as { id: string; title: string; date: string }[] }));
vi.mock("../src/contextData", () => ({ readContextTasks: vi.fn(async () => data) }));
const { bindTaskMoveDate } = await import("../src/agent/taskMoveDate");
const store = {} as StoreHost, now = new Date("2026-11-12T12:00:00+08:00");
const row = (id = "fictional-a", date = "2026-11-16") => ({ taskIdOrTitle: id, date, startTime: "19:00", endTime: "19:30", dueDate: "2026-11-20", expectedRevision: "fictional-version" });
const call = (updates = [row()]): AiToolCall => ({ id: "fictional-call", name: "update_tasks", arguments: { updates } });
const reset = () => { data.available = true; data.tasks = [{ id: "fictional-a", title: "虚构甲", date: "2026-11-09" }, { id: "fictional-b", title: "虚构乙", date: "2026-11-16" }]; };

it("grounds the selected batch destination from the actual calendar without changing clocks, deadlines, identities or source input", async () => {
  reset(); const calls = [call()], before = JSON.stringify(calls);
  const result = await bindTaskMoveDate(store, calls, "挪到周日吧，周六也有事情。", now);
  expect(result).toEqual([{ ...calls[0], arguments: { updates: [{ ...row(), date: "2026-11-15" }] } }]);
  expect(JSON.stringify(calls)).toBe(before);
});
it("does not move a time-only task whose model echoed its unchanged date", async () => {
  reset(); const calls = [call(), { id: "fictional-time", name: "reschedule_task", arguments: { taskIdOrTitle: "fictional-b", date: "2026-11-16", time: "15:00" } }];
  const result = await bindTaskMoveDate(store, calls, "把虚构甲挪到周日；虚构乙只改时间。", now);
  expect((result[0].arguments.updates as any[])[0].date).toBe("2026-11-15"); expect(result[1]).toBe(calls[1]);
  const mixed = [call([row(), row("fictional-b")])];
  expect(await bindTaskMoveDate(store, mixed, "虚构甲挪到周日，虚构乙只改时间。", now)).toEqual(mixed);
});
it("keeps explicit end dates, separate destinations, missing identities and non-move tools unchanged", async () => {
  reset();
  for (const calls of [[{ ...call(), arguments: { updates: [{ ...row(), endDate: "2026-11-20" }] } }],
    [call([row("unknown")])], [{ ...call(), name: "create_task" }], [{ ...call(), name: "get_stats" }]]) {
    expect(await bindTaskMoveDate(store, calls, "挪到周日。", now)).toEqual(calls);
  }
  const calls = [call()];
  for (const text of ["虚构甲挪到周六，虚构乙挪到周日。", "截止到周日，原来的安排保留。", "挪到周末。", "查周日的任务，不修改。"])
    expect(await bindTaskMoveDate(store, calls, text, now)).toEqual(calls);
});
it("does not bind duplicate titles or unavailable records", async () => {
  reset(); data.tasks.push({ id: "fictional-duplicate", title: "虚构甲", date: "2026-11-10" });
  const calls = [call([row("虚构甲")])];
  expect(await bindTaskMoveDate(store, calls, "挪到周日。", now)).toEqual(calls);
  data.available = false; expect(await bindTaskMoveDate(store, [call()], "挪到周日。", now)).toEqual([call()]);
});
it("does not interpret move words in quoted task names or code as scheduling instructions", async () => {
  reset(); const calls = [call()];
  for (const message of ['把“挪到周日”的任务只改时间。', '把`挪到周日`的任务只改时间。', '把虚构甲挪到“周六”周日。'])
    expect(await bindTaskMoveDate(store, calls, message, now)).toEqual(calls);
  expect(((await bindTaskMoveDate(store, calls, '把“虚构甲”挪到 周日。', now))[0].arguments.updates as any[])[0].date).toBe('2026-11-15');
});
