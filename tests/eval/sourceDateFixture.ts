import type { StoreHost } from "../../src/store/settingsSlice";
import { journalDateFromPath } from "../../src/journalResolver";
import { summaryPath } from "../../src/features/summaries/notes";
import { summaryPeriod } from "../../src/features/summaries/periods";

/** Relative narration is anchored to these fictional morning notes, not today. */
export async function prepareSourceDateFixture(store: StoreHost): Promise<void> {
  if (!store.getFile("TEST_VAULT_ONLY.md") || !(await store.readPath("TEST_VAULT_ONLY.md")).includes("内容全部为虚构数据")) {
    throw Error("事件日期复现只允许全虚构夹具。");
  }
  const oldSummary = store.getFile(summaryPath(store, summaryPeriod("week", "2026-11-04")));
  if (oldSummary) await store.app.vault.delete(oldSummary);
  for (const file of store.app.vault.getMarkdownFiles()) {
    const date = journalDateFromPath(file.path, store.settings.folders.dailyRoot);
    if (date && date >= "2026-11-02" && date <= "2026-11-08") await store.app.vault.delete(file);
  }
  for (const [date, text] of [
    ["2026-11-04", "全虚构早间记录：昨晚21:15到家，23:40开始整理纸样，今天凌晨00:20整理结束。今早08:00起床。明天计划给青色纸盒编号，但还没有做。"],
    ["2026-11-05", "全虚构早间记录：昨晚22:10完成黄纸袋标记，今早07:30起床。青色纸盒编号仍只是今天的计划，没有完成记录。"]
  ]) await store.appendDaily(date, "日记", text, "早", text);
}
