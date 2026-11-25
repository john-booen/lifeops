import assert from 'node:assert/strict';
import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';

/** Native UI coverage; providers and all tasks are fictional. */
export async function nativeCreationConfirmation(page, root, result) {
  await page.evaluate(async () => {
    const p = app.plugins.getPlugin('lifeops-assistant');
    const held = globalThis.__creationConfirmation = {
      before: (await p.store.readTaskDb()).tasks, receipts: [], factory: p.createAgentRuntime,
      instance: p.ai.agentTurnStream, prototype: Object.getPrototypeOf(p.ai).agentTurnStream,
      provider: p.settings.ai.provider, calls: 0, phase: 'hold'
    };
    const mock = async () => {
      held.calls++;
      return {content: '', toolCalls: [{id: `fictional-native-create-${held.phase}`, name: 'create_task',
        arguments: {title: `虚构原生创建${held.phase}`, date: '明天'}}]};
    };
    p.ai.agentTurnStream = mock; Object.getPrototypeOf(p.ai).agentTurnStream = mock;
    p.createAgentRuntime = function(...args) {
      const runtime = held.factory.apply(this, args), execute = runtime.executeToolCall.bind(runtime);
      runtime.executeToolCall = async (...values) => {
        const output = await execute(...values); if (output.receipt) held.receipts.push(output.receipt); return output;
      };
      return runtime;
    };
    held.facts = async () => Promise.all([p.store.taskDbPath(), p.store.taskMirrorPath(),
      p.store.path(p.settings.folders.aiReports, 'Operations', 'operation-ledger.json')].map(path => p.store.readPath(path)));
    const view = app.workspace.getLeavesOfType('lifeops-assistant-view')[0].view;
    view.agentMode = 'text'; view.agentMessages = []; view.pendingAgentActions = []; await view.navigateSteward('chat');
  });
  try {
    const preview = await page.evaluate(async () => {
      const held = globalThis.__creationConfirmation, view = app.workspace.getLeavesOfType('lifeops-assistant-view')[0].view;
      const before = await held.facts();
      view.setAgentInput('明天下午3点提醒我交虚构报告，等我确认再保存。'); await view.sendAgentMessage();
      held.action = view.pendingAgentActions[0];
      return {before, after: await held.facts(), pending: view.pendingAgentActions.length,
        type: held.action?.type, content: held.action?.content, calls: held.calls};
    });
    assert.deepEqual(preview.after, preview.before); assert.equal(preview.pending, 1); assert.equal(preview.type, 'tool_batch');
    const toggle = page.getByRole('button', {name: '查看待确认动作', exact: true});
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    const card = page.getByRole('textbox', {name: '确认后执行的修改', exact: true});
    await card.waitFor(); assert((await card.inputValue()).includes('虚构原生创建hold'));
    await card.scrollIntoViewIfNeeded(); await page.screenshot({path: join(root, 'creation-waits-for-confirmation.png')});
    const confirmed = await page.evaluate(async () => {
      const p = app.plugins.getPlugin('lifeops-assistant'), held = globalThis.__creationConfirmation;
      const view = app.workspace.getLeavesOfType('lifeops-assistant-view')[0].view;
      view.setAgentInput('确定'); await view.sendAgentMessage();
      const first = await held.facts(); await p.executeAgentAction(held.action).catch(() => undefined);
      return {first, replay: await held.facts(), calls: held.calls, pending: view.pendingAgentActions.length,
        count: (await p.store.readTaskDb()).tasks.filter(t => t.title === '虚构原生创建hold').length};
    });
    assert.equal(confirmed.calls, preview.calls); assert.equal(confirmed.pending, 0); assert.equal(confirmed.count, 1);
    assert.deepEqual(confirmed.replay, confirmed.first);
    const cancelled = await page.evaluate(async () => {
      const p = app.plugins.getPlugin('lifeops-assistant'), held = globalThis.__creationConfirmation;
      const view = app.workspace.getLeavesOfType('lifeops-assistant-view')[0].view;
      held.phase = 'cancel'; const before = await held.facts();
      view.setAgentInput('新建虚构原生创建cancel，先给我确认卡。'); await view.sendAgentMessage();
      const action = view.pendingAgentActions[0], calls = held.calls;
      view.setAgentInput('取消'); await view.sendAgentMessage();
      let refused = false; try { await p.executeAgentAction(action); } catch { refused = true; }
      return {before, after: await held.facts(), refused, pending: view.pendingAgentActions.length, noExtraModel: held.calls === calls};
    });
    assert.deepEqual(cancelled.after, cancelled.before); assert(cancelled.refused && cancelled.noExtraModel); assert.equal(cancelled.pending, 0);
    const offline = await page.evaluate(async () => {
      const p = app.plugins.getPlugin('lifeops-assistant'), held = globalThis.__creationConfirmation;
      const view = app.workspace.getLeavesOfType('lifeops-assistant-view')[0].view;
      p.settings.ai.provider = 'off'; const before = await held.facts(), calls = held.calls;
      view.setAgentInput('/todo 明天 10:00 虚构原生离线 等我确认'); await view.sendAgentMessage();
      const unchanged = JSON.stringify(before) === JSON.stringify(await held.facts()), pending = view.pendingAgentActions.length;
      view.setAgentInput('确定'); await view.sendAgentMessage();
      return {unchanged, pending, noModel: held.calls === calls,
        count: (await p.store.readTaskDb()).tasks.filter(t => t.title === '虚构原生离线').length};
    });
    assert(offline.unchanged && offline.noModel); assert.equal(offline.pending, 1); assert.equal(offline.count, 1);
    await writeFile(join(root, 'creation-confirmation.json'), JSON.stringify({preview, confirmed, cancelled, offline}, null, 2));
    result.checks.nativeCreationWaitsBeforeTaskAndLedgerWrite = true;
    result.checks.nativeCreationBareConfirmOnce = true;
    result.checks.nativeCreationCancelRevokesCard = true;
    result.checks.nativeOfflineCreationWaitsForConfirmation = true;
  } finally {
    const cleanup = await page.evaluate(async () => {
      const p = app.plugins.getPlugin('lifeops-assistant'), held = globalThis.__creationConfirmation;
      p.createAgentRuntime = held.factory; p.ai.agentTurnStream = held.instance;
      Object.getPrototypeOf(p.ai).agentTurnStream = held.prototype; p.settings.ai.provider = held.provider;
      for (const receipt of [...new Map(held.receipts.map(r => [r.operationId, r])).values()].reverse()) await p.createAgentRuntime().undoOperation(receipt.operationId);
      delete globalThis.__creationConfirmation;
      return {before: held.before, after: (await p.store.readTaskDb()).tasks};
    });
    assert.deepEqual(cleanup.after, cleanup.before); result.checks.nativeCreationUndoRestoresTasks = true;
  }
}
