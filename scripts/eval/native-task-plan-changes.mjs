/** Native schedule confirmation on fictional records; invoked by the remote-only harness. */
import assert from "node:assert/strict";
import { join } from "node:path";

async function prepare(page) {
  return page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant");
    const before = (await p.store.readTaskDb()).tasks;
    for (let i = 0; i < 11; i++) await p.store.createTask({ title: "虚构整批区间" + String(i + 1).padStart(2, "0"),
      date: new Date().toLocaleDateString("sv-SE"), startTime: `${12 + i}:00`, endTime: `${12 + i}:30`, note: "虚构原备注" + i });
    globalThis.__nativePlanRows = (await p.store.readTaskDb()).tasks.filter(row => row.title.startsWith("虚构整批区间"));
    globalThis.__nativePlanOld = { ai: p.settings.ai, privacy: p.settings.privacy,
      instance: p.ai.agentTurnStream, prototype: Object.getPrototypeOf(p.ai).agentTurnStream };
    p.settings.ai = { ...p.settings.ai, provider: "custom", endpoint: "https://fiction.invalid/chat", apiKey: "fictional-plan-key",
      model: "synthetic", fallbackProvider: "off", dataDisclosureAccepted: true };
    p.settings.privacy = { ...p.settings.privacy, plaintextCredentialStorageAccepted: true };
    globalThis.__nativePlanCalls = 0;
    let turn = -1, stage = 0;
    const mock = async messages => {
      globalThis.__nativePlanCalls++;
      const userCount = messages.filter(message => message.role === "user").length;
      if (turn !== userCount) { turn = userCount; stage = 0; }
      if (stage++ === 0) return { content: "", toolCalls: [{ id: "fictional-plan-lookup", name: "list_tasks", arguments: { directReply: true } }] };
      if (stage === 2) return { content: "", toolCalls: [{ id: "fictional-full-interval-plan", name: "update_tasks",
        arguments: { updates: globalThis.__nativePlanRows.map((row, i) => ({ taskIdOrTitle: row.id,
          startTime: String(9 + i).padStart(2, "0") + ":00", endTime: String(9 + i).padStart(2, "0") + ":30" })) } }] };
      return { content: "完整调整已准备，确认前没有修改原安排。", toolCalls: [] };
    };
    p.ai.agentTurnStream = mock; Object.getPrototypeOf(p.ai).agentTurnStream = mock;
    await p.activateView(true); const view = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;
    view.agentMode = "text"; view.agentMessages = []; view.pendingAgentActions = []; view.setAgentInput("");
    await view.navigateSteward("chat");
    return { before, planned: globalThis.__nativePlanRows };
  });
}

async function proposal(page) {
  const input = page.locator("textarea.lifeops-agent-input").last();
  await input.fill("把十一项虚构整批区间的完整时段统一调整，其他内容不变，给我一份确认。"); await input.press("Enter");
  await page.waitForFunction(() => {
    const v = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;
    return !v.agentBusy && v.pendingAgentActions.length === 1;
  });
  return page.evaluate(() => {
    const v = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;
    const a = v.pendingAgentActions[0];
    return { preview: a.content, updates: a.toolBatch[0].arguments.updates, calls: globalThis.__nativePlanCalls };
  });
}

async function confirm(page) {
  const input = page.locator("textarea.lifeops-agent-input").last();
  await input.fill("确定"); await input.press("Enter");
  await page.waitForFunction(() => !app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view.agentBusy);
  return page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), v = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;
    return { tasks: (await p.store.readTaskDb()).tasks, pending: v.pendingAgentActions.length,
      reply: v.agentReply, calls: globalThis.__nativePlanCalls };
  });
}

async function mixedTitleCorrection(page, root, result, baseline) {
  const request = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), rows = (await p.store.readTaskDb()).tasks;
    p.settings.ai = { ...p.settings.ai, provider: "custom", endpoint: "https://fiction.invalid/chat", apiKey: "fictional-mixed-key",
      model: "synthetic", fallbackProvider: "off", dataDisclosureAccepted: true };
    p.settings.privacy = { ...p.settings.privacy, plaintextCredentialStorageAccepted: true };
    let calls = 0;
    const mock = async () => ++calls === 1 ? { content: "", toolCalls: [{ id: "fictional-only-create", name: "create_task",
      arguments: { title: "虚构混合新增纸袋" } }] } : { content: "模型结束语不作保存证据。", toolCalls: [] };
    p.ai.agentTurnStream = mock; Object.getPrototypeOf(p.ai).agentTurnStream = mock;
    const view = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;
    view.agentMessages = []; view.pendingAgentActions = []; view.setAgentInput(""); await view.navigateSteward("chat");
    return `把「${rows[0].title}」改为「虚构混合改名甲」，把「${rows[1].title}」改为「虚构混合改名乙」。原安排和状态保留，再新增虚构混合新增纸袋。`;
  });
  const input = page.locator("textarea.lifeops-agent-input").last(); await input.fill(request); await input.press("Enter");
  await page.waitForFunction(() => !app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view.agentBusy);
  const saved = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), view = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;
    return { tasks: (await p.store.readTaskDb()).tasks, receipts: view.agentMessages.at(-1)?.receipts ?? [], pending: view.pendingAgentActions.length };
  });
  assert.equal(saved.tasks.length, baseline.length + 1); assert.equal(saved.pending, 0); assert.equal(saved.receipts.length, 2);
  for (const [i, row] of baseline.entries()) {
    const current = saved.tasks.find(task => task.id === row.id), { title, updatedAt, ...rest } = current;
    const { title: oldTitle, updatedAt: oldUpdated, ...old } = row;
    assert.equal(title, i === 0 ? "虚构混合改名甲" : i === 1 ? "虚构混合改名乙" : row.title); assert.deepEqual(rest, old);
  }
  assert(saved.tasks.some(task => task.title === "虚构混合新增纸袋"));
  result.checks.explicitRenamesAndNewTaskCompleteWhenModelOmitsEdits = true;
  await page.screenshot({ path: join(root, "mixed-title-and-new-task.png") });
  const after = await page.evaluate(async receipts => {
    const p = app.plugins.getPlugin("lifeops-assistant"), runtime = p.createAgentRuntime();
    for (const receipt of receipts.slice().reverse()) await runtime.undoOperation(receipt.operationId);
    const old = globalThis.__nativePlanOld; p.settings.ai = old.ai; p.settings.privacy = old.privacy;
    p.ai.agentTurnStream = old.instance; Object.getPrototypeOf(p.ai).agentTurnStream = old.prototype;
    return (await p.store.readTaskDb()).tasks;
  }, saved.receipts);
  assert.deepEqual(after, baseline); result.checks.mixedCorrectionUndoRestoresExistingTasks = true;
}

export async function taskPlanChangesUi(page, root, result) {
  assert.equal(process.env.GITHUB_ACTIONS, "true"); assert.equal(process.env.RUNNER_OS, "macOS");
  const original = await prepare(page), prepared = await proposal(page);
  assert.equal(prepared.updates.length, 11); assert(!prepared.preview.includes("expectedRevision"));
  assert(!prepared.preview.includes("taskIdOrTitle"));
  for (const row of original.planned) assert(prepared.preview.includes(row.title));
  assert.deepEqual(await page.evaluate(async () => (await app.plugins.getPlugin("lifeops-assistant").store.readTaskDb()).tasks), [...original.before, ...original.planned]);
  result.checks.fullIntervalPreviewBindsAllElevenOriginals = true;
  const saved = await confirm(page); assert.equal(saved.pending, 0); assert.equal(saved.calls, prepared.calls);
  assert(saved.reply.includes("实际更新11项"));
  for (const [i, row] of original.planned.entries()) {
    const current = saved.tasks.find(task => task.id === row.id);
    assert.equal(current.startTime, String(9 + i).padStart(2, "0") + ":00");
    assert.equal(current.endTime, String(9 + i).padStart(2, "0") + ":30");
    assert.equal(current.title, row.title); assert.equal(current.date, row.date); assert.equal(current.note, row.note);
  }
  result.checks.bareTextConfirmationSavesElevenWithoutAnotherModelRound = true;
  await page.screenshot({ path: join(root, "eleven-schedule-confirmed.png") });
  await page.evaluate(() => app.plugins.getPlugin("lifeops-assistant").createAgentRuntime().undoLatestOperation());
  assert.deepEqual(await page.evaluate(async () => (await app.plugins.getPlugin("lifeops-assistant").store.readTaskDb()).tasks), [...original.before, ...original.planned]);
  result.checks.elevenScheduleUndoPreservesOriginalRecords = true;
  const next = await proposal(page);
  const changed = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), last = globalThis.__nativePlanRows.at(-1);
    await p.store.updateTask(last.id, current => ({ ...current, note: "虚构确认前的外部新备注" }));
    return (await p.store.readTaskDb()).tasks;
  });
  const stale = await confirm(page); assert.equal(stale.calls, next.calls); assert(stale.reply.includes("过期"));
  assert.deepEqual(stale.tasks, changed); result.checks.stalePlanKeepsExternalEditAndAllOriginalSlots = true;
  await page.screenshot({ path: join(root, "eleven-schedule-stale.png") });
  const cleaned = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), v = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;
    v.pendingAgentActions = []; v.agentMessages = []; v.setAgentInput(""); v.refreshAgentSuggestions();
    for (const row of globalThis.__nativePlanRows) await p.store.deleteTask(row.id);
    const saved = globalThis.__nativePlanOld; p.settings.ai = saved.ai; p.settings.privacy = saved.privacy;
    p.ai.agentTurnStream = saved.instance; Object.getPrototypeOf(p.ai).agentTurnStream = saved.prototype;
    return (await p.store.readTaskDb()).tasks;
  });
  assert.deepEqual(cleaned, original.before); result.checks.scheduleFixtureLeavesUnrelatedTasksUntouched = true;
  await mixedTitleCorrection(page, root, result, original.before);
}
