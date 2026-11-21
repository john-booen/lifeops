import assert from "node:assert/strict";

/** Version-bound original evidence in the native fictional vault, without AI traffic. */
export async function nativeSummaryOriginalMemory(page, result) {
  const observed = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant");
    const hash = text => require("node:crypto").createHash("sha256").update(text, "utf8").digest("hex");
    const now = new Date().toISOString(), date = "2026-01-04", original = "我长期使用虚构双栏纸卡比较方案。";
    const invented = "我长期只看虚构单项结论。";
    const path = p.store.path(p.settings.folders.dailyRoot, "2026", "01", date + "晚.md");
    const summary = p.store.path(p.settings.folders.aiReports, "摘要", "日", date + ".md");
    const raw = "# 虚构晚间日记\n\n## 整理\n\n" + invented + "\n\n## 原话\n\n" + original + "\n";
    await p.store.writeFile(path, raw); await p.store.writeFile(summary, invented);
    const before = await p.store.readPath(p.store.taskDbPath());
    const grounded = await p.store.upsertPersonalMemory({ kind: "user_rule", content: original,
      sourceRefs: [{ sourceId: "summary-journal:" + date, path, capturedAt: now, observedDate: date,
        contentHash: hash(raw), extractionVersion: "summary-original-v2", excerpt: original, excerptHash: hash(original) },
      { sourceId: "summary:" + date, path: summary, capturedAt: now,
        contentHash: hash(invented), extractionVersion: "summary-v1" }] });
    const legacy = await p.store.upsertPersonalMemory({ kind: "user_rule", content: invented,
      sourceRefs: [{ sourceId: "summary:" + date, path: summary, capturedAt: now,
        contentHash: hash(invented), extractionVersion: "summary-v1" }] });
    const policy = hash(JSON.stringify({ folders: p.settings.folders, privacy: p.settings.privacy, externalVaults: p.settings.externalVaults ?? [] }));
    const document = await p.store.readPersonalMemories();
    document.records = document.records.map(row => row.id === grounded.id || row.id === legacy.id
      ? { ...row, status: "active", summarySource: { settingsRevision: policy, ...(row.id === grounded.id ? { evidenceVersion: 2 } : {}) } } : row);
    await p.store.writePersonalMemories(document);
    const memoryBytes = await p.store.readPath(p.store.personalMemoryPath());
    const context = await p.store.buildPersonalMemoryContext(original);
    await p.store.writeFile(summary, "虚构模型摘要重写，与原话无关。");
    const regenerated = await p.store.buildPersonalMemoryContext(original);
    await p.store.writeFile(path, raw + "\n用户后来更新原文。\n");
    const changed = await p.store.buildPersonalMemoryContext(original);
    const current = await p.getStewardMemories();
    return { original, invented, context, regenerated, changed,
      retained: current.some(row => row.id === legacy.id && row.content === invented),
      sameMemoryBytes: await p.store.readPath(p.store.personalMemoryPath()) === memoryBytes,
      sameTasks: await p.store.readPath(p.store.taskDbPath()) === before };
  });
  assert(observed.context.includes(observed.original)); assert(!observed.context.includes(observed.invented));
  assert(observed.regenerated.includes(observed.original)); assert(!observed.changed.includes(observed.original));
  assert(observed.retained && observed.sameMemoryBytes && observed.sameTasks);
  result.checks.legacyAutomaticSummaryIsRetainedWithoutBecomingUserFact = true;
  result.checks.automaticMemoryUsesOriginalVersionInsteadOfModelSummary = true;
}
