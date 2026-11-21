import type { StoreHost } from "../../src/store/settingsSlice";
import { summaryPath } from "../../src/features/summaries/notes";
import { summaryPeriod } from "../../src/features/summaries/periods";

/** A fictional task waits overnight; no work timer or actual-duration record exists. */
export async function prepareTaskIntervalFixture(store: StoreHost): Promise<void> {
  if (!store.getFile("TEST_VAULT_ONLY.md") || !(await store.readPath("TEST_VAULT_ONLY.md")).includes("内容全部为虚构数据")) {
    throw Error("间隔含义复现只允许全虚构夹具。");
  }
  await store.writeTaskDb({ ...await store.readTaskDb(), tasks: [] });
  // The base fixture's older weekly summary describes a different task population.
  // This scenario only exercises one freshly seeded task, so do not leave that
  // unrelated derived total available as if it summarized these records.
  const oldSummary = store.getFile(summaryPath(store, summaryPeriod("week", "2026-11-03")));
  if (oldSummary) await store.app.vault.delete(oldSummary);
  const task = await store.createTask({ title: "虚构跨日纸样归档", date: "2026-11-03", estimateMin: 30,
    startTime: "09:00", endTime: "09:30" });
  await store.updateTask(task.id, row => ({ ...row, createdAt: "2026-11-03T08:00:00+08:00",
    status: "completed", completedAt: "2026-11-04T17:00:00+08:00" }));
}
