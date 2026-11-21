import assert from "node:assert/strict";

/** Actual native chat UI and fact readers; synthetic model failure, no egress. */
export async function nativeReadOnlyRecovery(page, result) {
  const prepared = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant");
    const original = globalThis.__lifeOpsNativeOriginalTextTurn;
    if (typeof original !== "function") throw Error("Native original text entry missing");
    const saved = { ai: p.settings.ai, privacy: p.settings.privacy, instance: p.ai.agentTurnStream,
      prototype: Object.getPrototypeOf(p.ai).agentTurnStream, fetch: globalThis.fetch, fetchCalls: 0, calls: 0 };
    p.settings.ai = { ...p.settings.ai, provider: "custom", endpoint: "https://fictional.invalid", apiKey: "fictional-native-key",
      model: "synthetic-read-only", fallbackProvider: "off", dataDisclosureAccepted: true };
    p.settings.privacy = { ...p.settings.privacy, plaintextCredentialStorageAccepted: false };
    let configuration;
    globalThis.fetch = async () => { saved.fetchCalls++; throw Error("Native fixture forbids transport"); };
    const probe = new p.ai.constructor(p.settings);
    try { await original.call(probe, [{ role: "user", content: "虚构凭据预检" }], () => {}, { preferFinite: true }); }
    catch (error) { configuration = error; }
    finally { globalThis.fetch = saved.fetch; }
    if (configuration?.code !== "configuration" || !configuration.providerRun?.attempts?.length
      || configuration.providerRun.attempts.some(row => row.errorCode !== "configuration") || saved.fetchCalls) {
      p.settings.ai = saved.ai; p.settings.privacy = saved.privacy;
      throw Error("Synthetic native failure must be obtained before any egress");
    }
    saved.interrupted = new configuration.constructor(configuration.providerRun, "response_incomplete");
    p.settings.privacy = { ...p.settings.privacy, plaintextCredentialStorageAccepted: true };
    const done = await p.store.createTask({ title: "虚构原生二月纸样", date: "2025-02-04" });
    await p.store.updateTask(done.id, row => ({ ...row, createdAt: "2025-02-04T08:00:00+08:00",
      status: "completed", completedAt: "2025-02-05T17:00:00+08:00" }));
    const pending = await p.store.createTask({ title: "虚构原生三月纸盒", date: "2025-03-04" });
    saved.ids = [done.id, pending.id]; globalThis.__readOnlyRecoveryNative = saved;
    return { before: await p.store.readPath(p.store.taskDbPath()) };
  });
  await page.waitForFunction(() => { const p = app.plugins.getPlugin("lifeops-assistant"), s = globalThis[Symbol.for("lifeops.fact-operation-state.v1")];
    return !p.sourceChangeTimers?.size && !p.dataFoundationBootstrap && !s?.locks?.has(app.vault) && !s?.activeWrites?.has(app.vault); });
  const observed = await page.evaluate(async prepared => {
    const p = app.plugins.getPlugin("lifeops-assistant"), saved = globalThis.__readOnlyRecoveryNative;
    const mock = async () => {
      if (++saved.calls > 1) throw saved.interrupted;
      return { content: "", toolCalls: [
        { id: "fictional-native-february", name: "get_stats", arguments: { domain: "tasks", range: { from: "2025-02-01", to: "2025-02-28" } } },
        { id: "fictional-native-march", name: "get_stats", arguments: { domain: "tasks", range: { from: "2025-03-01", to: "2025-03-28" } } }
      ] };
    };
    p.ai.agentTurnStream = mock; Object.getPrototypeOf(p.ai).agentTurnStream = mock;
    const view = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;
    try {
      view.agentMessages = []; view.pendingAgentActions = []; view.agentMode = "text"; await view.navigateSteward("chat");
      view.setAgentInput("对照2025年2月和3月的任务完成情况与交易净盈亏，仅给登记统计，不保存任何记录。");
      await view.sendAgentMessage();
      return { reply: view.agentReply, calls: saved.calls, fetchCalls: saved.fetchCalls,
        actions: view.pendingAgentActions.length, receipts: view.agentMessages.at(-1)?.receipts ?? [],
        unchanged: await p.store.readPath(p.store.taskDbPath()) === prepared.before,
        activeProviders: p.activeProviderRequests.size };
    } finally {
      p.settings.ai = saved.ai; p.settings.privacy = saved.privacy;
      p.ai.agentTurnStream = saved.instance; Object.getPrototypeOf(p.ai).agentTurnStream = saved.prototype;
      for (const id of saved.ids) await p.store.deleteTask(id);
      view.agentMessages = []; view.pendingAgentActions = []; delete globalThis.__readOnlyRecoveryNative;
    }
  }, prepared);
  assert.equal(observed.calls, 2); assert.equal(observed.fetchCalls, 0); assert.equal(observed.actions, 0);
  assert.equal(observed.activeProviders, 0); assert.deepEqual(observed.receipts, []); assert(observed.unchanged);
  for (const value of ["2025-02-01", "2025-02-28", "2025-03-01", "2025-03-28", "100%", "0%", "重新核对"]) {
    assert(observed.reply.includes(value), value + ": " + observed.reply);
  }
  result.checks.readOnlyStatisticsStayVisibleAfterNativeModelInterruption = true;
  result.checks.readOnlyRecoveryChangesNoTasksAndRepeatsNoModelRequest = true;
  await page.waitForFunction(() => { const p = app.plugins.getPlugin("lifeops-assistant"), s = globalThis[Symbol.for("lifeops.fact-operation-state.v1")];
    return !p.sourceChangeTimers?.size && !p.dataFoundationBootstrap && !s?.locks?.has(app.vault) && !s?.activeWrites?.has(app.vault); });
}
