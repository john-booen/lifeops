import assert from "node:assert/strict";

/** Native chat, real original read, injected wire-format failure; no egress. */
export async function nativeToolProtocol(page, result) {
  const observed = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), view = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;
    const prototype = Object.getPrototypeOf(p.ai), saved = { ai: p.settings.ai, privacy: p.settings.privacy,
      instance: p.ai.agentTurnStream, prototype: prototype.agentTurnStream, fetch: globalThis.fetch };
    const path = p.store.path(p.settings.folders.dailyRoot, "2026", "01", "2026-01-02晚.md");
    const old = p.store.getFile(path) ? await p.store.readPath(path) : null, tasks = await p.store.readPath(p.store.taskDbPath());
    await p.store.writeFile(path, "# 虚构日记\n\n## 原话\n\n虚构蓝纸尚未贴好。\n");
    const deadline = Date.now() + 15000;
    while (p.sourceChangeTimers?.size || p.dataFoundationBootstrap) {
      if (Date.now() >= deadline) throw Error("Native original read source did not settle");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    let calls = 0, fetchCalls = 0, repairTools, repairChoice;
    const snapshots = [];
    p.settings.ai = { ...p.settings.ai, provider: "custom", endpoint: "https://fictional.invalid", apiKey: "fictional-native-key",
      model: "synthetic-protocol", fallbackProvider: "off", dataDisclosureAccepted: true };
    p.settings.privacy = { ...p.settings.privacy, plaintextCredentialStorageAccepted: true };
    globalThis.fetch = async () => { fetchCalls++; throw Error("Native protocol fixture forbids transport"); };
    const mock = async (_messages, onText, options) => {
      if (++calls === 1) return { content: "", toolCalls: [{ name: "query_vault", arguments: { domain: "journal", operation: "get", date: "2026-01-02", period: "晚" } }] };
      if (calls === 2) {
        const content = '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="create_task"></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>';
        for (const length of [1, 4, 12, content.length]) { onText(content.slice(0, length)); snapshots.push(view.agentReply); }
        return { content, toolCalls: [] };
      }
      if (calls !== 3) throw Error("Protocol repair exceeded one request");
      repairTools = options?.tools?.length ?? 0; repairChoice = options?.toolChoice;
      return { content: "1月2日的原话是“虚构蓝纸尚未贴好”。这是未完成的记录。", toolCalls: [] };
    };
    p.ai.agentTurnStream = mock; prototype.agentTurnStream = mock;
    try {
      view.agentMessages = []; view.pendingAgentActions = []; view.agentMode = "text"; await view.navigateSteward("chat");
      view.setAgentInput("按1月2日晚间原话说明虚构蓝纸的情况，不创建任务。"); await view.sendAgentMessage();
      return { reply: view.agentReply, calls, fetchCalls, repairTools, repairChoice,
        hidden: snapshots.every(text => !text.includes("DSML")),
        actions: view.pendingAgentActions.length, receipts: view.agentMessages.at(-1)?.receipts ?? [],
        tasksUnchanged: await p.store.readPath(p.store.taskDbPath()) === tasks };
    } finally {
      p.settings.ai = saved.ai; p.settings.privacy = saved.privacy; p.ai.agentTurnStream = saved.instance;
      prototype.agentTurnStream = saved.prototype; globalThis.fetch = saved.fetch;
      if (old === null) await app.vault.delete(p.store.getFile(path)); else await p.store.writeFile(path, old);
      view.agentMessages = []; view.pendingAgentActions = [];
    }
  });
  assert.equal(observed.calls, 3); assert.equal(observed.fetchCalls, 0);
  assert.equal(observed.repairTools, 0); assert.equal(observed.repairChoice, "none");
  assert(observed.hidden && observed.tasksUnchanged); assert.equal(observed.actions, 0); assert.deepEqual(observed.receipts, []);
  assert(observed.reply.includes("虚构蓝纸尚未贴好") && !observed.reply.includes("DSML"));
  result.checks.nativeToolProtocolNeverDisplaysOrExecutesMarkup = true;
  result.checks.nativeToolProtocolRepairIsOneTextOnlyRequest = true;
  await page.waitForFunction(() => { const p = app.plugins.getPlugin("lifeops-assistant"), s = globalThis[Symbol.for("lifeops.fact-operation-state.v1")];
    return !p.sourceChangeTimers?.size && !p.dataFoundationBootstrap && !s?.locks?.has(app.vault) && !s?.activeWrites?.has(app.vault); });
}
