/** Remote-only fictional completion windows: classification, actual editor and old-package readback. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function nativeTaskPeriodWindow({ getPage, root, result, candidate, dailyRollback, launch, close, packageFiles }) {
  const rollbackVersion = JSON.parse(await readFile(join(dailyRollback, "manifest.json"), "utf8")).version;
  let page = getPage();
  const fixture = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), before = (await p.store.readTaskDb()).tasks;
    const date = offset => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toLocaleDateString("sv-SE"); };
    const week = await p.store.createTask({ title: "虚构周期蓝纸归档", date: date(-2), endDate: date(4),
      startTime: "16:15", endTime: "16:45", estimateMin: 600, note: "虚构原备注", dueDate: date(8), dueTime: "18:00" });
    const month = await p.store.createTask({ title: "虚构跨月紫纸归档", date: date(-20), endDate: date(20), estimateMin: 1200 });
    const board = await p.store.getTaskDashboard(date(0), { forContext: true });
    await p.activateView(true); const v = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;
    v.mode = "tasks"; v.taskFilter = "period"; await v.navigateSteward("affairs"); await v.render();
    return { before, week, month, newEnd: date(5), today: date(0), tomorrow: board.tomorrow.map(t => t.id),
      seven: board.nextSevenDays.map(t => t.id), current: board.today.map(t => t.id) };
  });
  for (const row of [fixture.week, fixture.month]) {
    assert(!fixture.tomorrow.includes(row.id)); assert(fixture.current.includes(row.id)); assert(fixture.seven.includes(row.id));
  }
  await page.locator('[data-lifeops-task-filter="period"]').click();
  await page.getByText(fixture.week.title, { exact: true }).first().waitFor();
  assert((await page.locator(".lifeops-task-main").innerText()).includes("期间完成"));
  await page.screenshot({ path: join(root, "period-task-list.png") });
  result.checks.periodWindowClassificationAndVisibleList = true;
  await page.evaluate(async id => { const p = app.plugins.getPlugin("lifeops-assistant"); p.openTaskEditModal(await p.store.getTask(id)); }, fixture.week.id);
  const mode = page.locator(".modal-container .setting-item").filter({ has: page.getByText("安排方式", { exact: true }) }).locator("select");
  assert.equal(await mode.inputValue(), "window"); await mode.selectOption("window");
  const finish = page.locator('.modal-container input[aria-label="计划完成日期"]');
  await finish.fill(fixture.newEnd);
  await page.screenshot({ path: join(root, "period-task-editor.png") });
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page.waitForFunction(async ({ id, end }) => {
    const p = app.plugins.getPlugin("lifeops-assistant"), row = await p.store.getTask(id);
    return !document.querySelector(".modal-container") && row.endDate === end && row.scheduleMode === "window";
  }, { id: fixture.week.id, end: fixture.newEnd });
  const saved = await page.evaluate(async id => {
    const p = app.plugins.getPlugin("lifeops-assistant"), row = await p.store.getTask(id);
    const plan = await p.createAgentRuntime().executeAiToolCall({ name: "plan_today", arguments: {} }, "kimi");
    return { row, plan: JSON.parse(plan.output) };
  }, fixture.week.id);
  const { endDate, scheduleMode, updatedAt, ...rest } = saved.row;
  const { endDate: priorEnd, updatedAt: priorUpdated, ...original } = fixture.week;
  assert.deepEqual(rest, original); assert.equal(scheduleMode, "window"); assert.equal(endDate, fixture.newEnd);
  assert(saved.plan.capacity.periodCount >= 2); assert(saved.plan.workloadSummary.includes("未把全部估时计入今天"));
  result.checks.periodEditorPersistsWithoutChangingHardDeadline = true;
  await close(); await packageFiles(dailyRollback); await launch(); page = getPage();
  const legacy = await page.evaluate(async id => {
    const p = app.plugins.getPlugin("lifeops-assistant"); return { version: p.manifest.version, row: await p.store.getTask(id) };
  }, fixture.week.id);
  assert.equal(legacy.version, rollbackVersion); assert.deepEqual(legacy.row, saved.row);
  await close(); await packageFiles(candidate); await launch(); page = getPage();
  const restored = await page.evaluate(async id => {
    const p = app.plugins.getPlugin("lifeops-assistant"); return { row: await p.store.getTask(id), board: await p.store.getTaskDashboard(new Date().toLocaleDateString("sv-SE"), { forContext: true }) };
  }, fixture.week.id);
  assert.deepEqual(restored.row, saved.row); assert(!restored.board.tomorrow.some(t => t.id === fixture.week.id));
  result.checks.periodWindowSurvivesPreviousDailyRollbackAndReopen = true;
  const cleaned = await page.evaluate(async ids => {
    const p = app.plugins.getPlugin("lifeops-assistant"), db = await p.store.readTaskDb();
    await p.store.writeTaskDb({ ...db, tasks: db.tasks.filter(t => !ids.includes(t.id)) });
    return (await p.store.readTaskDb({ readOnly: true })).tasks;
  }, [fixture.week.id, fixture.month.id]);
  assert.deepEqual(cleaned, fixture.before); result.checks.periodFixtureCleanupPreservesAllOtherTasks = true;
  result.periodWindows = { week: { date: fixture.week.date, endDate: fixture.newEnd, dueDate: fixture.week.dueDate },
    previousDailyRollbackVersion: legacy.version, metadataRetained: true, originalTasksPreserved: true };
}
