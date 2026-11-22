import type { StoreHost } from "../../src/store/settingsSlice";
import { journalDateFromPath } from "../../src/journalResolver";
import { createPersonalMemory, emptyPersonalMemoryDocument } from "../../src/personalMemory";
import { memorySourcePolicy } from "../../src/personalMemorySources";
import { fileRevision } from "../../src/operationIdentity";
import { readSummaryScope, renderSummary, summaryPath } from "../../src/features/summaries/notes";
import { summaryPeriod } from "../../src/features/summaries/periods";

export const originalPreference = "我长期习惯用两列对照表比较虚构检索方案。";
export const inventedPreference = "我长期习惯只听单一结论，不看方案对照。";

/** The generated summary contradicts a dated, fictional user original. */
export async function prepareSummaryMemoryFixture(store: StoreHost): Promise<void> {
  if (!store.getFile("TEST_VAULT_ONLY.md") || !(await store.readPath("TEST_VAULT_ONLY.md")).includes("内容全部为虚构数据")) {
    throw Error("原话记忆复现只允许全虚构夹具。");
  }
  for (const file of store.app.vault.getMarkdownFiles()) {
    const date = journalDateFromPath(file.path, store.settings.folders.dailyRoot);
    if (date && date >= "2026-11-02" && date <= "2026-11-08") await store.app.vault.delete(file);
    if (file.path.startsWith(store.path(store.settings.folders.aiReports, "摘要", "日") + "/")) await store.app.vault.delete(file);
  }
  const date = "2026-11-03", now = "2026-11-09T01:00:00.000Z";
  await store.appendDaily(date, "日记", "模型整理：" + inventedPreference, "晚", originalPreference);
  const period = summaryPeriod("day", date), scope = await readSummaryScope(store), path = summaryPath(store, period);
  const raw = renderSummary(period, date, scope.hash,
    { taskCompletionPercent: null, tasksCompleted: 0, energy: null, tradePnlCny: null, tradePnlUsd: null },
    1, true, "model", inventedPreference);
  await store.writeFile(path, raw);
  const record = { ...createPersonalMemory({ kind: "user_rule", content: inventedPreference,
    sourceRefs: [{ sourceId: "summary:" + date, path, capturedAt: now, observedDate: date,
      contentHash: fileRevision(raw), extractionVersion: "summary-v1", excerpt: inventedPreference, excerptHash: fileRevision(inventedPreference) }] }, now),
    status: "active" as const, summarySource: { settingsRevision: memorySourcePolicy(store) } };
  const document = await store.readPersonalMemories();
  await store.writePersonalMemories({ ...document, ...emptyPersonalMemoryDocument(now), records: [record], summaryMemoryWeek: "2026-W45" });
}

/** A paused automatic memory must not block a new, explicit user statement. */
export async function prepareBoundMemoryRestatementFixture(store: StoreHost): Promise<void> {
  await prepareSummaryMemoryFixture(store);
  const date = "2026-11-03", now = "2026-11-09T01:00:00.000Z";
  const original = store.app.vault.getMarkdownFiles().find(file => journalDateFromPath(file.path, store.settings.folders.dailyRoot) === date);
  if (!original) throw Error("虚构原始记忆来源缺失。");
  const raw = await store.readPath(original.path), summary = summaryPath(store, summaryPeriod("day", date));
  const record = { ...createPersonalMemory({ kind: "user_rule", content: originalPreference,
    sourceRefs: [{ sourceId: "summary-journal:" + date, path: original.path, capturedAt: now, observedDate: date,
      contentHash: fileRevision(raw), extractionVersion: "summary-original-v2", excerpt: originalPreference, excerptHash: fileRevision(originalPreference) },
    { sourceId: "summary:" + date, path: summary, capturedAt: now,
      contentHash: fileRevision(await store.readPath(summary)), extractionVersion: "summary-v1" }] }, now),
    status: "active" as const, summarySource: { settingsRevision: memorySourcePolicy(store), evidenceVersion: 2 as const } };
  const document = await store.readPersonalMemories();
  await store.writePersonalMemories({ ...document, records: [record] });
  await store.writeFile(original.path, raw + "\n虚构旧原文后来补写过，旧记忆须暂停使用。\n");
}
