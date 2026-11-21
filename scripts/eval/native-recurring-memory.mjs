import assert from "node:assert/strict";

export async function nativeRecurringMemory(page, result) {
  const prepared = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), ids = [];
    const records = ["我每周三晚上整理虚构读书卡。", "用户明确要求记住：周三晚上固定开会。"];
    for (const [i, content] of records.entries()) {
      const path = p.store.path(p.settings.folders.ideas, "虚构固定安排来源" + i + ".md");
      await p.store.writeFile(path, content);
      const record = await p.store.upsertPersonalMemory({ kind: "user_rule", content, sourceRefs: [{ sourceId: "fictional-recurring-" + i, path, capturedAt: new Date().toISOString() }] });
      await p.store.reviewPersonalMemory(record.id, { decision: "confirm" }); ids.push(record.id);
    }
    globalThis.__recurringNative = { ids, ai: p.settings.ai, privacy: p.settings.privacy,
      instance: p.ai.agentTurnStream, prototype: Object.getPrototypeOf(p.ai).agentTurnStream, calls: 0 };
    return { before: await p.store.readPath(p.store.taskDbPath()), records };
  });
  await page.waitForFunction(() => { const p = app.plugins.getPlugin("lifeops-assistant"), s = globalThis[Symbol.for("lifeops.fact-operation-state.v1")];
    return !p.sourceChangeTimers?.size && !p.dataFoundationBootstrap && !s?.locks?.has(app.vault) && !s?.activeWrites?.has(app.vault); });
  const observed = await page.evaluate(async prepared => {
    const p = app.plugins.getPlugin("lifeops-assistant"), old = globalThis.__recurringNative;
    p.settings.ai = { ...p.settings.ai, provider: "custom", endpoint: "https://fiction.invalid/chat", apiKey: "fictional-recurring-key", model: "synthetic", fallbackProvider: "off", dataDisclosureAccepted: true };
    p.settings.privacy = { ...p.settings.privacy, plaintextCredentialStorageAccepted: true };
    const mock = async messages => {
      old.calls++; for (const content of prepared.records) if (!JSON.stringify(messages).includes(content)) throw Error("A confirmed recurring fact was omitted from model context");
      return { content: "周三晚上有固定会议，以及整理虚构读书卡。", toolCalls: [] };
    };
    p.ai.agentTurnStream = mock; Object.getPrototypeOf(p.ai).agentTurnStream = mock;
    const view = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;
    view.agentMessages = []; view.pendingAgentActions = []; view.setAgentInput("我周三晚上有什么？"); await view.sendAgentMessage();
    const answer = { reply: view.agentReply, calls: old.calls, after: await p.store.readPath(p.store.taskDbPath()) };
    p.settings.ai = old.ai; p.settings.privacy = old.privacy; p.ai.agentTurnStream = old.instance; Object.getPrototypeOf(p.ai).agentTurnStream = old.prototype;
    for (const id of old.ids) await p.store.reviewPersonalMemory(id, { decision: "forget" });
    view.agentMessages = []; view.pendingAgentActions = []; return answer;
  }, prepared);
  assert.equal(observed.calls, 1); assert(observed.reply.includes("会议") && observed.reply.includes("读书卡"));
  assert.equal(observed.after, prepared.before);
  result.checks.relatedRecurringMemoryIsNotHiddenByNarrowLocalShortcut = true;
}
