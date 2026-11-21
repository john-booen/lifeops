/** Native windows are permitted only on an ephemeral GitHub macOS runner, never on the user's desktop. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, cp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { nativeFixtureSeed } from "./native-fixture.mjs";

assert(process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_OS === "macOS", "Native QA runs on GitHub macOS only");
const source = process.env.LIFEOPS_QA_SOURCE, candidate = process.env.LIFEOPS_QA_PACKAGE;
const rollback = process.env.LIFEOPS_QA_ROLLBACK, nativeApp = process.env.LIFEOPS_NATIVE_APP;
const expected = process.env.LIFEOPS_QA_EXPECTED_SHA;
assert(source && candidate && rollback && nativeApp && /^[a-f0-9]{64}$/.test(expected ?? ""));
const require = createRequire(process.env.LIFEOPS_QA_AUTOMATION_PACKAGE);
const { chromium } = require("playwright");
const root = await mkdtemp(join(process.env.RUNNER_TEMP, "native-task-content-"));
const vault = join(root, "Fictional-vault"), profile = join(root, "profile");
const plugin = join(vault, ".obsidian/plugins/lifeops-assistant");
await mkdir(plugin, { recursive: true }); await mkdir(profile);
await writeFile(join(vault, "TEST_VAULT_ONLY.md"), "内容全部为虚构数据。\n");
const seed = nativeFixtureSeed(JSON.parse(await readFile(join(source, "fixtures/test-vault/.obsidian/plugins/lifeops-assistant/data.json"), "utf8")));
await writeFile(join(plugin, "data.json"), JSON.stringify(seed));
await writeFile(join(vault, ".obsidian/community-plugins.json"), JSON.stringify(["lifeops-assistant"]));
await writeFile(join(vault, ".obsidian/app.json"), JSON.stringify({ safeMode: false }));
await writeFile(join(profile, "obsidian.json"), JSON.stringify({ vaults: {
  [randomBytes(8).toString("hex")]: { path: vault, ts: Date.now(), open: true }
}, updateDisabled: true }));
const result = { root, candidateSha256: expected, nativeVersion: process.env.LIFEOPS_QA_NATIVE_VERSION,
  githubRunnerOnly: true, fixtureOnly: true, realProviders: false, microphone: false, checks: {}, exits: [] };
let proc, exited, browser, page;
async function packageFiles(path) {
  const files = await readdir(path); assert.equal(files.length, 6);
  for (const name of files) await cp(join(path, name), join(plugin, name));
}
async function launch(profilePath = profile, vaultPath = vault) {
  await rm(join(profilePath, "DevToolsActivePort"), { force: true });
  const fd = openSync(join(root, "app.log"), "a", 0o600);
  proc = spawn("/usr/bin/open", ["-g", "-j", "-n", "-W", "-a", nativeApp,
    "--stdout", join(root, "native-stdout.log"), "--stderr", join(root, "native-stderr.log"),
    "--args", "--remote-debugging-port=0", "--user-data-dir=" + profilePath, "--no-first-run", "--no-sandbox"],
    { stdio: ["ignore", fd, fd] }); closeSync(fd);
  exited = new Promise((resolve, reject) => { proc.once("error", reject); proc.once("exit", (code, signal) => resolve({ code, signal })); });
  for (let i = 0; i < 150; i++) {
    assert.equal(proc.exitCode, null, "Fixture launcher exited during startup");
    try {
      const port = (await readFile(join(profilePath, "DevToolsActivePort"), "utf8")).split("\n")[0];
      browser = await chromium.connectOverCDP("http://127.0.0.1:" + port, { noDefaults: true, timeout: 1500 });
      page = browser.contexts()[0].pages()[0]; if (!page) throw Error("No fixture page"); break;
    } catch (error) { if (i === 149) throw error; await setTimeout(200); }
  }
  page.setDefaultTimeout(30_000);
  await page.waitForFunction(v => typeof app !== "undefined" && app.vault?.adapter?.getBasePath?.() === v
    && (!!app.plugins?.getPlugin?.("lifeops-assistant")?.store || /信任仓库作者并启用插件|Trust author and enable plugins/.test(document.body.innerText)), vaultPath);
  const trust = page.getByText(/^(?:信任仓库作者并启用插件|Trust author and enable plugins)$/);
  if (await trust.count()) await trust.click();
  await page.waitForFunction(() => !!app.plugins?.getPlugin("lifeops-assistant")?.store && app.workspace.layoutReady
    && !app.plugins.getPlugin("lifeops-assistant").dataFoundationBootstrap);
}
async function close() {
  if (!proc || proc.exitCode !== null) return;
  if (browser) {
    if (page && !page.isClosed()) await page.waitForFunction(() => {
      const p = app.plugins?.getPlugin("lifeops-assistant"), state = globalThis[Symbol.for("lifeops.fact-operation-state.v1")];
      return !p?.dataFoundationBootstrap && !p?.activeProviderRequests?.size && !state?.locks?.has(app.vault)
        && !state?.activeWrites?.has(app.vault) && !p?.sourceChangeTimers?.size;
    }, null, { timeout: 30_000 });
    const session = await browser.newBrowserCDPSession();
    await session.send("Browser.close").catch(error => { if (!error.message.includes("closed")) throw error; });
  }
  const timer = new AbortController();
  try {
    const exit = await Promise.race([exited, setTimeout(20_000, undefined, { signal: timer.signal }).then(() => { throw Error("Fixture did not close"); })]);
    assert.equal(exit.code, 0); result.exits.push(exit);
  } finally { timer.abort(); }
}
try {
  await packageFiles(candidate);
  assert.equal(createHash("sha256").update(await readFile(join(plugin, "main.js"))).digest("hex"), expected);
  await launch();
  if (process.env.LIFEOPS_QA_SCENARIO === "devices") {
    result.scenario = "devices";
    await (await import("./native-device-batch.mjs")).exerciseNativeDeviceBatch({ getPage: () => page,
      root, vault, profile, candidate, rollback, dailyRollback: process.env.LIFEOPS_QA_PREVIOUS_DAILY,
      expected, result, launch, close, packageFiles });
  } else {
  await page.waitForFunction(async sha => {
    const p = app.plugins.getPlugin("lifeops-assistant");
    const heartbeat = await p.store.readJson(p.store.path(p.settings.folders.aiReports, "System", "heartbeat.json"), {});
    return heartbeat.ok === true && heartbeat.mainSha256 === sha;
  }, expected);
  result.checks.loadedHeartbeatMatchesSealedPackage = true;
  const edited = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant");
    const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    for (let i = 0; i < 12; i++) await p.store.createTask({ title: "虚构旧纸样" + i, date,
      startTime: String(8 + i).padStart(2, "0") + ":00", endTime: String(8 + i).padStart(2, "0") + ":30", note: "虚构备注" + i });
    const before = (await p.store.readTaskDb()).tasks;
    await p.store.completeTask(before[7].id);
    const baseline = (await p.store.readTaskDb()).tasks;
    p.settings.ai = { ...p.settings.ai, provider: "custom", endpoint: "https://fiction.invalid/chat", apiKey: "fictional-fixture-key",
      model: "synthetic", fallbackProvider: "off", dataDisclosureAccepted: true };
    p.settings.privacy = { ...p.settings.privacy, plaintextCredentialStorageAccepted: true };
    await p.activateView(true); const view = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;
    await view.navigateSteward("chat");
    const installModel = responses => {
      const mock = async () => { const response = responses.shift(); if (!response) throw Error("Unexpected synthetic model call"); return response; };
      p.ai.agentTurnStream = mock; Object.getPrototypeOf(p.ai).agentTurnStream = mock;
    };
    installModel([{ content: "", toolCalls: [
      { id: "fictional-edit", name: "update_tasks", arguments: { updates: [
        { taskIdOrTitle: before[4].id, title: "虚构更正纸样甲" }, { taskIdOrTitle: before[7].id, title: "虚构更正纸样乙" }
      ] } }, { id: "fictional-new", name: "create_task", arguments: { title: "虚构新增纸样", date } }
    ] }, { content: "模型结束语不作为保存证据。", toolCalls: [] }]);
    view.setAgentInput("把虚构旧纸样4和虚构旧纸样7的标题分别改为虚构更正纸样甲和虚构更正纸样乙，保留原安排；再新建虚构新增纸样。");
    await view.sendAgentMessage();
    const firstReply = view.agentReply;
    const firstReceipts = view.agentMessages.at(-1).receipts;
    installModel([{ content: "把虚构旧纸样1改为虚构后续名称甲，把虚构旧纸样8改为虚构后续名称乙。请确认。", toolCalls: [] }]);
    view.setAgentInput("另外，把虚构旧纸样1改为虚构后续名称甲，把虚构旧纸样8改为虚构后续名称乙。");
    await view.sendAgentMessage();
    let calls = 0, historyPresent = false;
    const confirm = async messages => {
      if (++calls === 1) {
        const history = JSON.stringify(messages); historyPresent = history.includes("虚构后续名称甲") && history.includes("虚构后续名称乙");
        if (!historyPresent) throw Error("Previous correction disappeared from the live UI conversation");
        return { content: "", toolCalls: [{ id: "fictional-confirm", name: "update_tasks", arguments: { updates: [
          { taskIdOrTitle: before[1].id, title: "虚构后续名称甲" }, { taskIdOrTitle: before[8].id, title: "虚构后续名称乙" }
        ] } }] };
      }
      return { content: "模型结束语。", toolCalls: [] };
    };
    p.ai.agentTurnStream = confirm; Object.getPrototypeOf(p.ai).agentTurnStream = confirm;
    view.setAgentInput("确定"); await view.sendAgentMessage();
    return { baseline, tasks: (await p.store.readTaskDb()).tasks, firstReply, firstReceipts, reply: view.agentReply,
      receipts: view.agentMessages.at(-1).receipts, historyPresent, version: p.manifest.version };
  });
  assert.equal(edited.tasks.length, 13); assert(edited.firstReply.includes("实际更新2项")); assert(edited.reply.includes("实际更新2项"));
  assert.equal(edited.firstReceipts.flatMap(r => r.taskEdits ?? []).length, 2); assert(edited.historyPresent);
  for (const [index, title] of [[4, "虚构更正纸样甲"], [7, "虚构更正纸样乙"], [1, "虚构后续名称甲"], [8, "虚构后续名称乙"]]) {
    assert.equal(edited.tasks.find(row => row.id === edited.baseline[index].id)?.title, title);
  }
  assert(edited.tasks.some(row => row.title === "虚构新增纸样"));
  for (const prior of edited.baseline) {
    const current = edited.tasks.find(row => row.id === prior.id); assert(current);
    const { title: _title, updatedAt: _time, ...same } = current;
    const { title: _oldTitle, updatedAt: _oldTime, ...original } = prior; assert.deepEqual(same, original);
  }
  result.version = edited.version; result.checks.originalIdentitiesSchedulesAndStatus = true;
  result.checks.twoEditsAndNewTask = true; result.checks.liveUiBareConfirmation = true;
  await page.screenshot({ path: join(root, "task-content.png") });
  await close(); await launch();
  assert.equal(await page.evaluate(async () => (await app.plugins.getPlugin("lifeops-assistant").store.readTaskDb()).tasks.length), 13);
  result.checks.reopen = true; await close();
  await packageFiles(rollback); await launch();
  const reverted = await page.evaluate(async id => {
    const p = app.plugins.getPlugin("lifeops-assistant"); await p.createAgentRuntime().undoOperation(id);
    return { version: p.manifest.version, tasks: (await p.store.readTaskDb()).tasks };
  }, edited.receipts[0].operationId);
  assert.equal(reverted.version, "0.5.98"); assert.equal(reverted.tasks.length, 13);
  assert.equal(reverted.tasks.find(t => t.id === edited.baseline[1].id).title, edited.baseline[1].title);
  assert.equal(reverted.tasks.find(t => t.id === edited.baseline[8].id).title, edited.baseline[8].title);
  assert(reverted.tasks.some(t => t.title === "虚构新增纸样")); result.checks.rollbackUndoPreservesOtherTasks = true;
  await close(); await packageFiles(candidate); await launch();
  assert.equal(await page.evaluate(() => app.plugins.getPlugin("lifeops-assistant").manifest.version), edited.version);
  result.checks.reinstall = true; await close(); result.passed = true;
  }
} catch (error) {
  result.error = error.message; result.passed = false;
  if (page && !page.isClosed()) await page.screenshot({ path: join(root, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await close().catch(error => { result.closeError = error.message; result.passed = false; });
  await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
}
