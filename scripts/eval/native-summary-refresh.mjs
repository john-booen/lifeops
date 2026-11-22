import assert from "node:assert/strict";

/** A source edit during an actual native read, in the remote fictional vault only. */
export async function nativeSummaryRefresh(page, result) {
  const observed = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), vault = app.vault;
    const paths = ["2026-01-07", "2026-01-14"].map(date => p.store.path(p.settings.folders.dailyRoot, "2026", "01", date + "晚.md"));
    for (const path of paths) if (p.store.getFile(path) || await vault.adapter.exists(path)) throw Error("Fictional refresh interval already occupied");
    const original = "虚构第一周：蓝纸已归档12张。", latest = original + "\n虚构补充原话：黄纸已归档7张。", other = "虚构第二周：绿纸已归档3张。";
    const tasks = await p.store.readPath(p.store.taskDbPath()), memory = await p.store.readPath(p.store.personalMemoryPath());
    const privacy = p.settings.privacy, rawRead = vault.read, proto = Object.getPrototypeOf(p.ai), model = proto.agentTurnStream;
    const ownModel = Object.getOwnPropertyDescriptor(p.ai, "agentTurnStream"); let calls = 0, phase = "idle", edits = 0;
    async function settle() {
      const deadline = Date.now() + 15000; let previous, quietSince = Date.now();
      while (Date.now() < deadline) {
        const state = globalThis[Symbol.for("lifeops.fact-operation-state.v1")];
        const busy = p.sourceChangeTimers?.size || p.dataFoundationBootstrap || state?.locks?.has(vault) || state?.activeWrites?.has(vault);
        const catalog = JSON.stringify(vault.getFiles().map(file => [file.path, { ...file.stat }]).sort((a, b) => a[0].localeCompare(b[0])));
        if (busy || catalog !== previous) { previous = catalog; quietSince = Date.now(); }
        else if (Date.now() - quietSince >= 250) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw Error("Fictional source refresh did not settle");
    }
    try {
      proto.agentTurnStream = p.ai.agentTurnStream = async () => { calls++; throw Error("Unexpected model call during local read recovery"); };
      await p.store.ensureFile(paths[0], original); await p.store.ensureFile(paths[1], other); await settle();
      const range = { from: "2026-01-05", to: "2026-01-18" }, runtime = p.createAgentRuntime();
      const stats = await runtime.executeAiToolCall({ id: "fictional-refresh-stats", name: "get_stats", arguments: { domain: "tasks", range } }, "kimi");
      if (!stats.success) throw Error(stats.output); await settle();
      vault.read = async function(file) {
        const raw = await rawRead.call(this, file);
        if (file.path === paths[0] && phase !== "idle") {
          const active = phase; phase = "idle"; edits++;
          await vault.modify(file, active === "refresh" ? latest : latest + "\n虚构稍后再次更新。");
          await settle();
          if (active === "exclude") p.settings.privacy = { ...privacy, excludedVaultPrefixes: [...(privacy?.excludedVaultPrefixes ?? []), paths[0]] };
        }
        return raw;
      };
      phase = "refresh";
      const fresh = await runtime.executeAiToolCall({ id: "fictional-refresh-summary", name: "get_summaries", arguments: { level: "week", range, includeOriginals: true } }, "kimi");
      if (!fresh.success) throw Error(fresh.output);
      const notes = JSON.parse(fresh.output).originalEvidence.notes;
      phase = "exclude";
      const blocked = await runtime.executeAiToolCall({ id: "fictional-refresh-excluded", name: "get_summaries", arguments: { level: "week", range, includeOriginals: true } }, "kimi");
      p.settings.privacy = privacy;
      return { notes, fresh: { success: fresh.success, receipt: !!fresh.receipt, actions: fresh.actions.length },
        blocked: { success: blocked.success, output: blocked.output, receipt: !!blocked.receipt, actions: blocked.actions.length },
        edits, calls, tasksUnchanged: tasks === await p.store.readPath(p.store.taskDbPath()), memoryUnchanged: memory === await p.store.readPath(p.store.personalMemoryPath()),
        latest, other, dates: ["2026-01-07", "2026-01-14"], active: p.activeProviderRequests.size };
    } finally {
      phase = "idle"; vault.read = rawRead; proto.agentTurnStream = model;
      if (ownModel) Object.defineProperty(p.ai, "agentTurnStream", ownModel); else delete p.ai.agentTurnStream;
      p.settings.privacy = privacy;
      for (const path of paths) { const file = p.store.getFile(path); if (file) await vault.delete(file); }
    }
  });
  assert.deepEqual(observed.notes.map(note => note.date), observed.dates);
  assert.deepEqual(observed.notes.map(note => note.text), [observed.latest, observed.other]);
  assert(observed.fresh.success && !observed.fresh.receipt && observed.fresh.actions === 0);
  assert(!observed.blocked.success && !observed.blocked.receipt && observed.blocked.actions === 0);
  assert(!observed.blocked.output.includes("蓝纸") && !observed.blocked.output.includes("黄纸") && !observed.blocked.output.includes("绿纸"));
  assert.equal(observed.edits, 2); assert.equal(observed.calls, 0); assert.equal(observed.active, 0);
  assert(observed.tasksUnchanged && observed.memoryUnchanged);
  result.checks.nativeSummarySourceRefreshKeepsBothWeeksWithoutModelReplay = true;
  result.checks.nativeSummarySourceRefreshStopsOnScopeChangeWithoutFactWrites = true;
  result.summaryReadRefresh = { originalEdits: observed.edits, modelCalls: 0, requestedWeeks: 2, tasksUnchanged: true, memoryUnchanged: true };
}
