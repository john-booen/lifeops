/** Exact first-setup boundary, in a remote fictional profile only. */
import assert from "node:assert/strict";

export async function immediateSetupRollback({getPage,result,candidate,rollback,packageFiles,launch,close}) {
  assert.equal(process.env.GITHUB_ACTIONS,"true");assert.equal(process.env.RUNNER_OS,"macOS");
  await close();await packageFiles(rollback);await launch();let page=getPage();
  const baseline=await page.evaluate(async()=>{
    const p=app.plugins.getPlugin("lifeops-assistant"),date=new Date().toLocaleDateString("sv-SE");
    await p.store.createTask({title:"虚构已完成纸样",date});
    const first=(await p.store.readTaskDb()).tasks[0];await p.store.completeTask(first.id);
    await p.store.createTask({title:"虚构保留的独立任务",date});
    return {version:p.manifest.version,tasks:(await p.store.readTaskDb()).tasks,raw:await p.store.readPath(p.store.taskDbPath())};
  });
  assert.equal(baseline.version,"0.5.100");assert.equal(baseline.tasks.length,2);
  await close();await packageFiles(candidate);await launch();page=getPage();
  const setup=await page.evaluate(async()=>{
    const p=app.plugins.getPlugin("lifeops-assistant");
    if(!p.devices.execution.needsSetup)throw Error("Fixture must reach its first setup");
    const before=await p.store.readPath(p.store.taskDbPath());
    // This is the real installer path; no bootstrap or later business write may replace its WAL.
    await p.devices.chooseWriter(p.createAgentRuntime());
    const wal=await p.store.readJson(p.store.path(p.settings.folders.aiReports,"Operations","write-recovery.json"),{});
    const ledger=await p.store.readJson(p.store.path(p.settings.folders.aiReports,"Operations","operation-ledger.json"),{});
    const claim=ledger.records.find(row=>row.operationId===wal.operationId);
    return {before,after:await p.store.readPath(p.store.taskDbPath()),wal,claim,
      policy:await p.store.readPath("输入/设备协作.json"),writerId:p.devices.execution.deviceId};
  });
  assert.equal(setup.before,baseline.raw);assert.equal(setup.after,baseline.raw);
  assert.match(setup.wal.operationId,/^local:configure-device:/);assert.equal(setup.wal.status,"committed");assert.deepEqual(setup.wal.entries,[]);
  assert.equal(setup.claim.status,"verified");assert.equal(setup.claim.result.undo.files.length,1);
  assert.equal(setup.claim.result.undo.files[0].after,setup.policy);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".modal-container").count(),0);
  result.checks.installerEscapeClosesSetupModal=true;
  await close();await packageFiles(rollback);await launch();page=getPage();
  const old=await page.evaluate(async()=>{
    const p=app.plugins.getPlugin("lifeops-assistant"),before=(await p.store.readTaskDb()).tasks;
    const ledgerPath=p.store.path(p.settings.folders.aiReports,"Operations","operation-ledger.json");
    const setup=(await p.store.readJson(ledgerPath,{})).records.find(row=>row.toolName==="scheduled_configure_device_execution");
    const runtime=p.createAgentRuntime(),created=await runtime.executeAiToolCall({id:"fictional-old-after-first-setup",name:"create_task",
      arguments:{title:"虚构回退后临时纸样"}},"kimi");
    if(!created.success||!created.receipt)throw Error("Old daily version could not create after setup rollback");
    await runtime.undoOperation(created.receipt.operationId);
    const heartbeat=await p.store.readJson(p.store.path(p.settings.folders.aiReports,"System","heartbeat.json"),{});
    return {version:p.manifest.version,before,after:(await p.store.readTaskDb()).tasks,setup,
      policy:await p.store.readPath("输入/设备协作.json"),heartbeat};
  });
  assert.equal(old.version,"0.5.100");assert.deepEqual(old.before,baseline.tasks);assert.deepEqual(old.after,baseline.tasks);
  assert.deepEqual(old.setup,setup.claim);assert.equal(old.policy,setup.policy);assert.equal(old.heartbeat.ok,true);assert.deepEqual(old.heartbeat.errors,[]);
  result.checks.immediateFirstSetupRollbackReadsCreatesAndUndoes=true;
  result.checks.immediateRollbackPreservesOriginalTasksPolicyAndAudit=true;
  await close();await packageFiles(candidate);await launch();page=getPage();
  assert.equal(await page.evaluate(()=>app.plugins.getPlugin("lifeops-assistant").devices.execution.deviceId),setup.writerId);
  // Also exercise the normal role button and its close handler after restoring the candidate.
  await page.evaluate(()=>app.plugins.getPlugin("lifeops-assistant").openDeviceSettings());
  return setup.writerId;
}
