/** Called only by the guarded remote-native runner; every file belongs to its fictional fixture. */
import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";

async function syntheticModel(page) {
  await page.evaluate(() => {
    const p = app.plugins.getPlugin("lifeops-assistant");
    p.settings.ai = { ...p.settings.ai, provider: "custom", endpoint: "https://fiction.invalid/chat", apiKey: "fictional-key",
      model: "synthetic", fallbackProvider: "off", dataDisclosureAccepted: true };
    p.settings.privacy = { ...p.settings.privacy, plaintextCredentialStorageAccepted: true };
    globalThis.__nativeBatchCalls = 0;
    const mock = async messages => {
      const input = messages.filter(message => message.role === "user").at(-1)?.content ?? "";
      const prefix = input.includes("虚构离线批") ? "虚构离线批" : input.includes("虚构设备批") ? "虚构设备批" : "虚构手机批";
      if (++globalThis.__nativeBatchCalls > 2) throw Error("Unexpected repeated model call");
      const tasks = Array.from({ length: 5 }, (_, i) => ({ title: prefix === "虚构手机批" && i === 0 ? "虚构已完成纸样" : prefix + i, estimateMin: 20 }));
      return { content: "模型口头承诺不作为保存回执。", toolCalls: [{ id: "fictional-native-batch", name: "schedule_task_batch", arguments: { date: "今天", tasks } }] };
    };
    p.ai.agentTurnStream = mock; Object.getPrototypeOf(p.ai).agentTurnStream = mock;
  });
}

async function phoneBatchUi(page, root) {
  await syntheticModel(page);
  const state = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), date = new Date().toLocaleDateString("sv-SE");
    const existing=(await p.store.readTaskDb()).tasks;
    if(!existing.length){
      await p.store.createTask({ title: "虚构已完成纸样", date });
      const first = (await p.store.readTaskDb()).tasks.find(row=>row.title==="虚构已完成纸样"); await p.store.completeTask(first.id);
      await p.store.createTask({ title: "虚构保留的独立任务", date });
    }
    const preserved = (await p.store.readTaskDb()).tasks;
    p.settings.phoneInboxEnabled = true;
    const raw = `[${date} 10:00] 虚构手机批：今天五项纸样工作全部安排并一次保存。\n`;
    await p.store.ensureFile("输入/手机随手记.md", raw);
    await p.phoneInbox.scan(); await p.phoneInbox.scan();
    const rows = await p.phoneInbox.list(), tasks = (await p.store.readTaskDb()).tasks;
    p.openPhoneInbox();
    return { raw, preserved, tasks, rows, calls: globalThis.__nativeBatchCalls };
  });
  assert.equal(state.calls, 1); assert.equal(state.tasks.length, 6); assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0].status, "saved"); assert.deepEqual(state.rows[0].taskBatch, { created: 4, existing: 1 });
  for (const before of state.preserved) assert.deepEqual(state.tasks.find(row => row.id === before.id), before);
  await page.getByRole("button", { name: "查看完整回执", exact: true }).click();
  await page.getByText("本批任务回执", { exact: true }).waitFor();
  assert((await page.locator(".modal-container").last().innerText()).includes("虚构手机批4"));
  await page.screenshot({ path: join(root, "phone-batch-receipt.png") });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "撤销本批任务", exact: true }).click();
  await page.waitForFunction(async () => (await app.plugins.getPlugin("lifeops-assistant").store.readTaskDb()).tasks.length === 2);
  const after = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"); await p.phoneInbox.scan();
    return { tasks: (await p.store.readTaskDb()).tasks, row: (await p.phoneInbox.list())[0],
      raw: await p.store.readPath("输入/手机随手记.md"), calls: globalThis.__nativeBatchCalls };
  });
  assert.deepEqual(after.tasks, state.preserved); assert.equal(after.raw, state.raw); assert.equal(after.row.undone, true); assert.equal(after.calls, 1);
  await page.keyboard.press("Escape");
  return state.preserved;
}

async function captureProfileUi(page, root, sourceVault) {
  // The companion is copied externally before its first launch. A plugin can
  // exist before the native Vault cache has indexed its copied recovery and
  // audit files; the role action correctly refuses unreadable fact state.
  const copied = (await readdir(sourceVault, { recursive: true }))
    .filter(path => path.endsWith(".json") && !path.split("/").some(part => part.startsWith(".")));
  await page.waitForFunction(paths => paths.every(path => app.vault.getAbstractFileByPath(path)), copied);
  const settings = JSON.parse(await readFile(join(sourceVault, ".obsidian/plugins/lifeops-assistant/data.json"), "utf8"));
  const prerequisites = await Promise.all(["输入/设备协作.json", ...["operation-ledger.json", "write-recovery.json"]
    .map(name => settings.folders.aiReports + "/Operations/" + name)].map(async path => ({ path,
      hash: await readFile(join(sourceVault, path)).then(bytes => createHash("sha256").update(bytes).digest("hex")).catch(error => { if (error.code === "ENOENT") return null; throw error; }) })));
  const readyDeadline = Date.now() + 30000; let ready = false;
  do {
    ready = await page.evaluate(async expected => {
      const p = app.plugins.getPlugin("lifeops-assistant"), state = globalThis[Symbol.for("lifeops.fact-operation-state.v1")];
      if (!p || p.dataFoundationBootstrap || p.activeProviderRequests.size || state?.locks?.has(app.vault) || state?.activeWrites?.has(app.vault) || p.sourceChangeTimers?.size) return false;
      for (const row of expected) {
        const file = p.store.getFile(row.path), raw = file ? await p.store.readPath(row.path) : null;
        const hash = raw === null ? null : require("crypto").createHash("sha256").update(raw).digest("hex");
        if (hash !== row.hash) return false;
      }
      return true;
    }, prerequisites);
    if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
  } while (!ready && Date.now() < readyDeadline);
  assert(ready, "Copied role metadata did not become readable and idle within 30000ms");
  await page.evaluate(() => {
    globalThis.__nativeCaptureRoleNotices = [];
    globalThis.__nativeCaptureRoleNoticeObserver = new MutationObserver(() => {
      for (const node of document.querySelectorAll(".notice")) if (node.textContent && !globalThis.__nativeCaptureRoleNotices.includes(node.textContent)) globalThis.__nativeCaptureRoleNotices.push(node.textContent);
    });
    globalThis.__nativeCaptureRoleNoticeObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  // First launch already opens the role dialog; opening another would cover the real dialog.
  await page.getByRole("button", { name: "这台只记录并同步", exact: true }).waitFor();
  await page.getByRole("button", { name: "这台只记录并同步", exact: true }).click();
  try {
    await page.waitForFunction(() => !app.plugins.getPlugin("lifeops-assistant").devices.execution.needsSetup);
    // The role flips before refreshViews and the native dialog close finish.
    // Wait for that UI transition too, so it cannot steal the capture's focus.
    await page.getByRole("button", { name: "这台只记录并同步", exact: true }).waitFor({ state: "detached" });
    await page.waitForFunction(() => !app.plugins.getPlugin("lifeops-assistant").dataFoundationBootstrap);
  } catch (error) {
    const state = await page.evaluate(() => {
      const p = app.plugins.getPlugin("lifeops-assistant");
      return { role: p.devices.execution.role, problem: p.devices.execution.problemMessage,
        booting: !!p.dataFoundationBootstrap, notices: globalThis.__nativeCaptureRoleNotices };
    });
    throw Error(error.message + " Role selection state: " + JSON.stringify(state));
  } finally {
    await page.evaluate(() => { globalThis.__nativeCaptureRoleNoticeObserver?.disconnect(); delete globalThis.__nativeCaptureRoleNoticeObserver; });
  }
  const state = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), before = await p.store.readPath(p.store.taskDbPath());
    let denied = false; try { await p.store.createTask({ title: "虚构禁止直接入账" }); } catch { denied = true; }
    p.openDeviceCapture();
    return { id: p.devices.execution.deviceId, canWrite: p.devices.execution.canWriteFacts, before, denied };
  });
  assert.equal(state.canWrite, false); assert.equal(state.denied, true);
  const capture = page.locator(".modal-container").last(), input = capture.getByPlaceholder("例如：明天提醒我整理学习笔记");
  const original = "虚构设备批：五项纸样工作全部安排今天并一次创建。";
  try {
    await input.fill(original);
    assert.equal(await input.inputValue(), original, "The intended capture text must be present before one save click");
    await capture.getByRole("button", { name: "保存待处理记录", exact: true }).click();
    await capture.getByText("原始记录已保存在本机，等待同步到处理端。任务是否入账以回执为准。", { exact: true }).waitFor();
  } catch (error) {
    const diagnostic = await page.evaluate(() => {
      const p = app.plugins.getPlugin("lifeops-assistant"), modal = [...document.querySelectorAll(".modal-container")].at(-1);
      return { role: p.devices.execution.role, deviceId: p.devices.execution.deviceId, booting: !!p.dataFoundationBootstrap,
        input: modal?.querySelector("textarea")?.value, status: modal?.querySelector('[role="status"]')?.textContent,
        focused: document.activeElement?.getAttribute("placeholder"), notices: [...document.querySelectorAll(".notice")].map(node => node.textContent) };
    });
    throw Error(error.message + " Capture UI state: " + JSON.stringify(diagnostic));
  }
  await page.screenshot({ path: join(root, "capture-profile.png") });
  const after = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), old = new Date(Date.now() - 2 * 86_400_000);
    const offlinePath = await p.devices.queueCapture("虚构离线批：今天五项纸样工作全部保存。", old);
    return { raw: await p.store.readPath(p.store.taskDbPath()), providerRequests: p.activeProviderRequests.size,
      pendingDate: old.toLocaleDateString("sv-SE"), offlinePath };
  });
  assert.equal(after.raw, state.before); assert.equal(after.providerRequests, 0);
  const transferPaths = (await readdir(join(sourceVault, "输入/设备随手记"), { recursive: true })).filter(path => path.endsWith(".json"));
  const paths = transferPaths.filter(path => path.split("/").length === 2);
  assert.equal(paths.length, 2);
  return { id: state.id, paths: paths.map(path => join("输入/设备随手记", path)),
    transferPaths: transferPaths.map(path => join("输入/设备随手记", path)), pendingDate: after.pendingDate, offlinePath: after.offlinePath };
}

async function receiveAndCheck(page, root, vault, senderVault, captures, expected, preserved) {
  await syntheticModel(page);
  for (const path of captures.transferPaths) await cp(join(senderVault, path), join(vault, path), { recursive: true, force: false }).catch(async error => {
    if (error.code !== "ENOENT") throw error;
    const { dirname } = await import("node:path"); await mkdir(dirname(join(vault, path)), { recursive: true });
    await cp(join(senderVault, path), join(vault, path), { force: false });
  });
  // External copies are not instantly visible to the older native Vault cache.
  // Wait for the real input files, rather than pretending an immediate scan synced them.
  await page.waitForFunction(paths=>paths.every(path=>app.vault.getAbstractFileByPath(path)),captures.paths);
  // A scan deliberately defers while startup/background fact writes are live.
  // Exercise that normal retry path instead of assuming two immediate scans
  // must finish receipt processing before the delayed retry has run.
  const received = await page.waitForFunction(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant");
    await p.deviceInbox.scan();
    const rows = await p.deviceInbox.list(), tasks = (await p.store.readTaskDb()).tasks;
    if (p.dataFoundationBootstrap || rows.length !== 2 || tasks.length !== 12
      || rows.some(row => row.status !== "saved" || row.taskBatch?.created !== 5 || row.taskBatch?.existing !== 0)) return false;
    const heartbeat = await p.store.readJson(p.store.path(p.settings.folders.aiReports, "System", "heartbeat.json"), {});
    return { rows, tasks, heartbeat, id: p.devices.execution.deviceId, version: p.manifest.version,
      calls: globalThis.__nativeBatchCalls, canWrite: p.devices.execution.canWriteFacts };
  }, null, { timeout: 30_000, polling: 500 });
  const state = await received.jsonValue(); await received.dispose();
  assert.equal(state.tasks.length, 12,JSON.stringify({rows:state.rows,calls:state.calls,canWrite:state.canWrite})); assert.equal(state.rows.length, 2); assert.equal(state.calls, 2); assert.equal(state.canWrite, true);
  for (const row of state.rows) { assert.equal(row.status, "saved"); assert.deepEqual(row.taskBatch, { created: 5, existing: 0 }); }
  for (const row of preserved) assert.deepEqual(state.tasks.find(item => item.id === row.id), row);
  const delayed = state.tasks.filter(row => row.title.startsWith("虚构离线批"));
  assert.equal(delayed.length, 5); assert(delayed.every(row => row.date === captures.pendingDate && !row.time && !row.startTime && !row.endTime));
  assert(state.heartbeat.ok && !state.heartbeat.errors.length && state.heartbeat.mainSha256 === expected);
  for (const path of captures.paths) assert((await readFile(join(senderVault, path))).equals(await readFile(join(vault, path))));
  await page.evaluate(() => app.plugins.getPlugin("lifeops-assistant").openDeviceReceipts());
  await page.getByRole("button", { name: "查看完整回执", exact: true }).first().click();
  await page.getByText("本批任务回执", { exact: true }).waitFor();
  await page.screenshot({ path: join(root, "device-batch-receipt.png") });
  await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
  const offline = state.rows.find(row => row.sourcePath === captures.offlinePath); assert(offline?.operationId);
  return { ...state, offlineOperationId: offline.operationId };
}

async function conflictStopsWrites(page) {
  const state = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), path = "输入/设备协作.sync-conflict-20660110-000000-FICTIONAL.json";
    const before = await p.store.readPath(p.store.taskDbPath());
    await app.vault.create(path, await app.vault.adapter.read("输入/设备协作.json"));
    await p.devices.execution.refresh();
    let denied = false; try { await p.store.createTask({ title: "虚构冲突时禁止入账" }); } catch { denied = true; }
    const held = { denied, problem: !!p.devices.execution.problemMessage, canWrite: p.devices.execution.canWriteFacts,
      unchanged: await p.store.readPath(p.store.taskDbPath()) === before };
    await p.activateView(true);
    await app.vault.delete(app.vault.getAbstractFileByPath(path)); await p.devices.execution.refresh();
    return { ...held, recovered: p.devices.execution.canWriteFacts };
  });
  assert.deepEqual(state, { denied: true, problem: true, canWrite: false, unchanged: true, recovered: true });
}

export async function exerciseNativeDeviceBatch({ getPage, root, vault, profile, candidate, rollback, dailyRollback = rollback, expected, result, launch, close, packageFiles }) {
  assert.equal(process.env.GITHUB_ACTIONS, "true"); assert.equal(process.env.RUNNER_OS, "macOS");
  let page = getPage();
  const initial = await page.evaluate(() => {
    const p = app.plugins.getPlugin("lifeops-assistant");
    return { setup: p.devices.execution.needsSetup, canWrite: p.devices.execution.canWriteFacts };
  });
  assert.deepEqual(initial, { setup: true, canWrite: false });
  const writerId=await (await import("./native-setup-rollback.mjs")).immediateSetupRollback({getPage,result,candidate,rollback,packageFiles,launch,close});
  page=getPage();
  await page.getByRole("button", { name: "这台负责处理", exact: true }).waitFor();
  await page.getByRole("button", { name: "这台负责处理", exact: true }).click();
  await page.waitForFunction(() => app.plugins.getPlugin("lifeops-assistant").devices.execution.canWriteFacts
    && !app.plugins.getPlugin("lifeops-assistant").dataFoundationBootstrap
    && app.plugins.getPlugin("lifeops-assistant").store.getFile(app.plugins.getPlugin("lifeops-assistant").store.taskDbPath()));
  assert.equal(await page.evaluate(() => app.plugins.getPlugin("lifeops-assistant").devices.execution.deviceId),writerId);
  await page.evaluate(() => { const p = app.plugins.getPlugin("lifeops-assistant");
    globalThis.__lifeOpsNativeOriginalTextTurn = p.ai.agentTurnStream; });
  await (await import("./native-chat-interaction.mjs")).chatInteractionUi(page,root,result);
  await (await import("./native-task-plan-changes.mjs")).taskPlanChangesUi(page,root,result);
  await (await import("./native-cross-week.mjs")).crossWeekUi(page,root,result);
  await (await import("./native-historical-followup.mjs")).nativeHistoricalFollowup(page,root,result);
  await (await import("./native-historical-stats-fallback.mjs")).nativeHistoricalStatsFallback(page,root,result);
  await (await import("./native-journal-range-routing.mjs")).nativeJournalRangeRouting(page,root,result);
  await (await import("./native-hotwords.mjs")).nativeHotwords(page,result);
  await (await import("./native-task-lookup.mjs")).nativeTaskLookup(page,result);
  await (await import("./native-mixed-task-batch.mjs")).nativeMixedTaskBatch(page,root,result);
  await (await import("./native-recurring-memory.mjs")).nativeRecurringMemory(page,result);
  await (await import("./native-recent-undo.mjs")).nativeRecentUndo(page,result);
  await (await import("./native-task-follow-through.mjs")).nativeTaskFollowThrough(page,root,result);
  await (await import("./native-deferred-title-confirmation.mjs")).nativeDeferredTitleConfirmation(page,root,result);
  await (await import("./native-report-speech.mjs")).nativeReportSpeech(page,result);
  await (await import("./native-stat-meaning.mjs")).nativeStatMeaning(page,result);
  await (await import("./native-summary-refresh.mjs")).nativeSummaryRefresh(page,result);
  await (await import("./native-summary-original-memory.mjs")).nativeSummaryOriginalMemory(page,result);
  await (await import("./native-task-metric-meaning.mjs")).nativeTaskMetricMeaning(page,result);
  await (await import("./native-read-only-recovery.mjs")).nativeReadOnlyRecovery(page,result);
  await (await import("./native-tool-protocol.mjs")).nativeToolProtocol(page,result);
  await (await import("./native-text-route-cooldown.mjs")).nativeTextRouteCooldown(page,result);
  await (await import("./native-summary-journal-coverage.mjs")).nativeSummaryJournalCoverage(page,result);
  await (await import("./native-summary-evidence.mjs")).nativeSummaryEvidence(page,root,result);
  await (await import("./native-selected-journals.mjs")).nativeSelectedJournals(page,root,result);
  await (await import("./native-task-period-window.mjs")).nativeTaskPeriodWindow({ getPage, root, result, candidate, dailyRollback, launch, close, packageFiles });
  page = getPage();
  const preserved = await phoneBatchUi(page, root);
  result.checks.firstRoleUiAndPhoneBatchUndo = true;
  await close();
  const senderVault = join(root, "Companion-vault"), senderProfile = join(root, "capture-profile");
  await cp(vault, senderVault, { recursive: true }); await mkdir(senderProfile);
  await writeFile(join(senderProfile, "obsidian.json"), JSON.stringify({ vaults: {
    [randomBytes(8).toString("hex")]: { path: senderVault, ts: Date.now(), open: true }
  }, updateDisabled: true }));
  await launch(senderProfile, senderVault); page = getPage();
  const captures = await captureProfileUi(page, root, senderVault); assert.notEqual(captures.id, writerId);
  result.checks.separateCaptureProfileDeniesFactsAndKeepsRawInput = true; await close();
  await launch(); page = getPage();
  const received = await receiveAndCheck(page, root, vault, senderVault, captures, expected, preserved);
  assert.equal(received.id, writerId); result.version = received.version;
  result.checks.reopenedWriterIdentityAndSealedHeartbeat = true;
  result.checks.deviceAndOfflineBatchesSavedOnce = true;
  result.checks.completeReceiptsAndRawInputPreserved = true;
  await conflictStopsWrites(page); result.checks.conflictKeepsReaderAndStopsWrites = true;
  await close(); await packageFiles(dailyRollback); await launch(); page = getPage();
  const old = await page.evaluate(async operationId => {
    const p = app.plugins.getPlugin("lifeops-assistant"); await p.createAgentRuntime().undoOperation(operationId);
    return { version: p.manifest.version, tasks: (await p.store.readTaskDb()).tasks };
  }, received.offlineOperationId);
  assert.equal(old.version, JSON.parse(await readFile(join(dailyRollback, "manifest.json"), "utf8")).version);
  result.previousDailyRollbackVersion = old.version; assert.equal(old.tasks.length, 7);
  assert(old.tasks.every(row => !row.title.startsWith("虚构离线批")));
  for (const row of old.tasks) assert.deepEqual(row, received.tasks.find(item => item.id === row.id));
  result.checks.rollbackWholeBatchUndoPreservesOtherTasks = true;
  await close(); await packageFiles(candidate); await launch(); page = getPage();
  // Reopened Obsidian can expose the plugin before its copied ledger and
  // writer bootstrap are readable. Retain the actual undone-receipt gate.
  const readbackDeadline = Date.now() + 15000;
  let restored;
  do {
    restored = await page.evaluate(async operationId => {
      const p = app.plugins.getPlugin("lifeops-assistant");
      if (!p?.deviceInbox || p.dataFoundationBootstrap) return null;
      await p.deviceInbox.scan();
      const rows = await p.deviceInbox.list(), tasks = (await p.store.readTaskDb()).tasks;
      const state = globalThis[Symbol.for("lifeops.fact-operation-state.v1")];
      if (!rows.some(row => row.operationId === operationId && row.undone)
        || state?.locks?.has(app.vault) || state?.activeWrites?.has(app.vault)) return null;
      return { tasks, version: p.manifest.version, id: p.devices.execution.deviceId, rows };
    }, received.offlineOperationId);
    if (restored) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < readbackDeadline);
  assert(restored, "Reinstalled package did not read the actual undone receipt within 15000ms");
  assert.equal(restored.version, received.version); assert.equal(restored.id, writerId); assert.deepEqual(restored.tasks, old.tasks);
  assert(restored.rows.some(row => row.operationId === received.offlineOperationId && row.undone));
  result.checks.reinstallRetainsDataAndDoesNotReplay = true;
  result.syntheticFixtureTransfer = true; result.actualSecondMac = false; result.actualAndroid = false;
  await close(); result.passed = true;
}
