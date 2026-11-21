import type { StoreHost } from "../../src/store/settingsSlice";
import { journalDateFromPath } from "../../src/journalResolver";
import { readSummaryScope, renderSummary, summaryPath } from "../../src/features/summaries/notes";
import { summaryPeriod } from "../../src/features/summaries/periods";

/** Never use a real vault to reproduce a misleading legacy model summary. */
export async function prepareSparseSummaryFixture(store: StoreHost): Promise<void> {
  if (!store.getFile("TEST_VAULT_ONLY.md") || !(await store.readPath("TEST_VAULT_ONLY.md")).includes("内容全部为虚构数据")) {
    throw Error("旧摘要复现只允许全虚构夹具。");
  }
  await store.writeTaskDb({ ...await store.readTaskDb(), tasks: [] });
  await store.writeHabitDb({ ...await store.readHabitDb(), checkins: [] });
  for (const file of store.app.vault.getMarkdownFiles()) {
    const date = journalDateFromPath(file.path, store.settings.folders.dailyRoot);
    if (date && date >= "2026-11-02" && date <= "2026-11-08") await store.app.vault.delete(file);
  }
  const original = "纯虚构归档：11月3日已整理10张青色样片；当日没有登记打卡。本条只记当日事件，不代表全周情况，也不新增长期规则。";
  await store.appendDaily("2026-11-03", "日记", original, "晚", original);
  const scope = await readSummaryScope(store), period = summaryPeriod("week", "2026-11-03");
  await store.writeFile(summaryPath(store, period), renderSummary(period, period.to, scope.hash,
    { tasksCompleted: 0, taskCompletionPercent: null, energy: null, tradePnlCny: 0, tradePnlUsd: 0 }, 1, true, "model",
    "虚构归档习惯的打卡记录为0，因此本周一张也没有归档，之前的补偿规则应该立即取消。"));
}
