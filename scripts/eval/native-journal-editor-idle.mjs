/** Real native Markdown input; all notes and measurements belong to the remote fictional vault. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

async function quiet(page) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await page.evaluate(() => {
      const p=app.plugins.getPlugin("lifeops-assistant"),state=globalThis[Symbol.for("lifeops.fact-operation-state.v1")];
      return !p.sourceChangeTimers.size&&!p.dataFoundationBootstrap&&!state?.locks?.has(app.vault)&&!state?.activeWrites?.has(app.vault);
    })) return;
    await setTimeout(100);
  }
  throw Error("Fictional source updates did not settle within 30s");
}

async function exercise(page, path, base, screenshot) {
  // Plugin exposure precedes layout bootstrap on the older native host.
  // Observe the real writer and installed listeners before generating saves.
  try { await page.waitForFunction(path => {
    const p = app.plugins.getPlugin("lifeops-assistant");
    return p.dataFoundationEventsRegistered === true && !p.dataFoundationBootstrap
      && p.store.canWriteFacts() && p.store.isManagedSourcePath(path);
  }, path, { timeout: 30_000 }); } catch (error) {
    const state = await page.evaluate(async path => {
      const p = app.plugins.getPlugin("lifeops-assistant");
      const heartbeat = await p.store.readJson(p.store.path(p.settings.folders.aiReports,"System/heartbeat.json"), {});
      const recovery = await p.store.readJson(p.store.path(p.settings.folders.aiReports,"Operations/write-recovery.json"), {});
      return { version:p.manifest.version, registered:p.dataFoundationEventsRegistered,
        booting:!!p.dataFoundationBootstrap, canWrite:p.store.canWriteFacts(), managed:p.store.isManagedSourcePath(path),
        deviceProblem:p.devices.execution.problemMessage, path,
        heartbeat:{version:heartbeat.version,ok:heartbeat.ok,errors:heartbeat.errors},recoveryStatus:recovery.status };
    }, path);
    throw new Error("Native journal preflight failed: " + JSON.stringify(state), { cause:error });
  }
  await quiet(page);
  await page.evaluate(async ({ path, base }) => {
    const file = app.vault.getAbstractFileByPath(path);
    await app.vault.modify(file, base);
    const leaf = app.workspace.getLeaf("tab");
    await leaf.openFile(file, { state: { mode: "source" } });
    globalThis.__nativeJournalLeaf = leaf;
  }, { path, base });
  await quiet(page);
  await page.waitForFunction(() => globalThis.__nativeJournalLeaf.view.containerEl.classList.contains("lifeops-journal-note"));
  await page.evaluate(path => {
    const p = app.plugins.getPlugin("lifeops-assistant"), ws = app.workspace;
    const view = globalThis.__nativeJournalLeaf.view, editor = view.editor;
    editor.setCursor(editor.lastLine(), editor.getLine(editor.lastLine()).length); editor.focus();
    const probe = { inside: false, typing: true, events: 0, synchronousScans: 0, typingIndexCalls: 0, indexCalls: 0, times: [] };
    const trigger = ws.trigger, leaves = ws.getLeavesOfType, upsert = p.store.upsertVaultSource;
    ws.trigger = function(name, ...args) {
      if (name !== "editor-change") return trigger.call(this, name, ...args);
      const start = performance.now(); probe.inside = true;
      try { return trigger.call(this, name, ...args); }
      finally { probe.inside = false; probe.events++; probe.times.push(performance.now() - start); }
    };
    ws.getLeavesOfType = function(type) {
      if (type === "markdown" && probe.inside) probe.synchronousScans++;
      return leaves.call(this, type);
    };
    p.store.upsertVaultSource = function(filePath) {
      if (filePath === path) { probe.indexCalls++; if (probe.typing) probe.typingIndexCalls++; }
      return upsert.call(this, filePath);
    };
    globalThis.__nativeJournalProbe = probe;
    globalThis.__restoreNativeJournalProbe = () => { ws.trigger = trigger; ws.getLeavesOfType = leaves; p.store.upsertVaultSource = upsert; };
  }, path);
  try {
    await page.keyboard.insertText("a");
    // Exercise an actual vault save while the native editor continues receiving keys.
    await page.evaluate(async path => app.vault.modify(app.vault.getAbstractFileByPath(path), globalThis.__nativeJournalLeaf.view.editor.getValue()), path);
    await page.keyboard.type("a".repeat(59), { delay: 25 });
    for (let i = 0; i < 30; i++) { await page.keyboard.press("Backspace"); await setTimeout(25); }
    await page.keyboard.insertText("中文");
    await page.keyboard.press("Backspace"); await page.keyboard.press("Backspace");
    const immediate = await page.evaluate(() => {
      const q = globalThis.__nativeJournalProbe; q.typing = false;
      return { events: q.events, synchronousScans: q.synchronousScans, typingIndexCalls: q.typingIndexCalls,
        eventHandlerMs: q.times, text: globalThis.__nativeJournalLeaf.view.editor.getValue() };
    });
    assert.equal(immediate.text, base + "a".repeat(30), "Native deletion must remove exactly the requested characters");
    const deadline = Date.now() + 15_000;
    let persisted = false;
    do {
      persisted = await page.evaluate(async ({ path, expected }) =>
        await app.vault.read(app.vault.getAbstractFileByPath(path)) === expected, { path, expected: immediate.text });
      if (!persisted) await setTimeout(100);
    } while (!persisted && Date.now() < deadline);
    assert(persisted, "Native editor did not persist exact typed/deleted text within 15s");
    await page.waitForFunction(() => globalThis.__nativeJournalProbe.indexCalls > 0, null, { timeout: 15_000 });
    await quiet(page);
    const saved = await page.evaluate(async path => ({
      text: await app.vault.read(app.vault.getAbstractFileByPath(path)),
      indexCalls: globalThis.__nativeJournalProbe.indexCalls,
      journalStyle: globalThis.__nativeJournalLeaf.view.containerEl.classList.contains("lifeops-journal-note")
    }), path);
    assert.equal(saved.text, immediate.text); assert(saved.indexCalls > 0); assert(saved.journalStyle);
    await page.screenshot({ path: screenshot });
    return { ...immediate, text: undefined, exactNativeTextAndSavedBytes: true,
      noteCharacters: saved.text.length, indexCalls: saved.indexCalls, journalStyle: saved.journalStyle };
  } finally {
    await page.evaluate(() => { globalThis.__restoreNativeJournalProbe?.(); globalThis.__nativeJournalLeaf.detach(); });
  }
}

export async function nativeJournalEditorIdle({ getPage, root, result, candidate, dailyRollback, close, launch, packageFiles }) {
  const fixture = await getPage().evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), name = "2099-01-01_输入验收虚构";
    const path = p.settings.folders.dailyRoot.replace(/\/$/, "") + "/" + name + ".md";
    if (app.vault.getAbstractFileByPath(path)) throw Error("Fictional journal path already exists");
    const base = "# " + name + "\n\n" + "这是虚构的长日记正文，用来验收原生编辑与删除。\n".repeat(2000) + "\n";
    await app.vault.create(path, base); return { path, base };
  });
  // Native file observation can follow create()'s resolution. Do not close the
  // fixture while its first derived source generation has not been committed.
  await getPage().waitForFunction(async path => {
    const p=app.plugins.getPlugin("lifeops-assistant"),manifest=await p.store.readSourceManifest();
    return manifest.entries.some(row=>row.path===path&&row.status==='active');
  }, fixture.path, { timeout:30_000 });
  await quiet(getPage());
  await close(); await packageFiles(dailyRollback); await launch();
  const previous = await exercise(getPage(), fixture.path, fixture.base, join(root, "native-journal-previous.png"));
  assert(previous.synchronousScans > 0, "Previous package must reproduce the synchronous editor listener");
  await close(); await packageFiles(candidate); await launch();
  const current = await exercise(getPage(), fixture.path, fixture.base, join(root, "native-journal-current.png"));
  assert(current.events >= 90); assert.equal(current.synchronousScans, 0);
  assert.equal(current.typingIndexCalls, 0, "Derived indexing must wait for a pause in native typing/deletion");
  result.checks.journalNativeTypingAndBackspacePreserveExactText = true;
  result.checks.journalEditorEventsAvoidSynchronousWorkspaceScan = true;
  result.checks.journalDerivedIndexWaitsForTypingPause = true;
  await getPage().evaluate(async path => { await app.vault.delete(app.vault.getAbstractFileByPath(path)); }, fixture.path);
  await quiet(getPage());
  assert.equal(await getPage().evaluate(path => !!app.vault.getAbstractFileByPath(path), fixture.path), false);
  result.checks.journalFictionalNoteCleanupAndStylePreserved = true;
  result.journalEditor = { previous, current, realNativeKeyboard: true, fictionalOnly: true,
    interpretation: "Event-handler cost only; not proof of every cause of user-perceived latency." };
  await writeFile(join(root, "native-journal-editor-idle.json"), JSON.stringify(result.journalEditor, null, 2));
}
