import assert from 'node:assert/strict';
import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';

/** Original voice entry, fictional model, actual card and canonical task ledger. */
export async function nativeTaskSubject(page, root, result) {
  await page.evaluate(async () => {
    const p = app.plugins.getPlugin('lifeops-assistant');
    const h = globalThis.__taskSubject = {before: (await p.store.readTaskDb()).tasks, group: [], receipts: [],
      instance: p.ai.agentTurnStream, prototype: Object.getPrototypeOf(p.ai).agentTurnStream,
      factory: p.createAgentRuntime, submit: p.submitAgentMessageStream, phase: 'history', round: 0, requests: []};
    for (let i = 1; i <= 4; i++) h.group.push(await p.store.createTask({title: '虚构原生指代纸样0' + i,
      date: '2026-11-23', startTime: '19:00', endTime: '19:30'}));
    h.other = await p.store.createTask({title: '虚构原生无关邮箱设置', date: '2026-11-28', time: '10:00'});
    h.list = '11月23日逾期四项：' + h.group.map(t => t.title).join('、');
    const mock = async messages => {
      if (h.phase === 'history') return {content: h.historyReply, toolCalls: []};
      h.requests.push(messages);
      if (h.round++ === 0) return {content: '', toolCalls: [{id: 'fictional-native-wrong-subject', name: 'reschedule_task',
        arguments: {taskIdOrTitle: h.other.id, date: '2026-11-29'}}]};
      if (h.round === 2) return {content: '', toolCalls: [{id: 'fictional-native-correct-subjects', name: 'update_tasks',
        arguments: {updates: h.group.map(t => ({taskIdOrTitle: t.id, date: '2026-11-29'}))}}]};
      return {content: '请核对原四项的一份改期确认卡。', toolCalls: []};
    };
    p.ai.agentTurnStream = mock; Object.getPrototypeOf(p.ai).agentTurnStream = mock;
    p.createAgentRuntime = function(...args) {
      const runtime = h.factory.apply(this, args), execute = runtime.executeToolCall.bind(runtime);
      runtime.executeToolCall = async (...values) => {
        const output = await execute(...values); if (output.receipt) h.receipts.push(output.receipt); return output;
      }; return runtime;
    };
    const view = app.workspace.getLeavesOfType('lifeops-assistant-view')[0].view;
    view.agentMode = 'text'; view.agentMessages = []; view.pendingAgentActions = []; await view.navigateSteward('chat');
    for (const [user, assistant] of [['查一下虚构纸样的逾期任务。', h.list], ['四项统一挪到周末。', '（被打断）'],
      ['工作日没空，原时段保留。', '你选周六还是周日？']]) {
      h.historyReply = assistant; view.setAgentInput(user); await view.sendAgentMessage();
    }
    h.facts = async () => Promise.all([p.store.taskDbPath(), p.store.taskMirrorPath(),
      p.store.path(p.settings.folders.aiReports, 'Operations', 'operation-ledger.json')].map(path => p.store.readPath(path)));
  });
  try {
    const preview = await page.evaluate(async () => {
      const p = app.plugins.getPlugin('lifeops-assistant'), h = globalThis.__taskSubject;
      const view = app.workspace.getLeavesOfType('lifeops-assistant-view')[0].view;
      const before = await h.facts(); h.phase = 'edit';
      // Feed the fictional voice transcript through the actual chat submission,
      // so its producer response, adjacent history and visible card bind together.
      p.submitAgentMessageStream = async function(message, history, onText, options) {
        return h.response = await h.submit.call(this, message, history, onText, {...options, source: 'voice'});
      };
      try { view.setAgentInput('挪到2026年11月29日周日，周六我有事。'); await view.sendAgentMessage(); }
      finally { p.submitAgentMessageStream = h.submit; }
      const response = h.response; h.action = view.pendingAgentActions[0];
      return {unchanged: JSON.stringify(before) === JSON.stringify(await h.facts()), pending: response.actions.length,
        action: h.action, receipts: h.receipts, fullHistory: h.requests[0].some(row => row.role === 'assistant' && row.content === h.list)};
    });
    assert(preview.unchanged && preview.fullHistory); assert.equal(preview.pending, 1); assert.deepEqual(preview.receipts, []);
    assert.equal(preview.action.type, 'tool_batch'); assert.equal(preview.action.toolBatch[0].arguments.updates.length, 4);
    const toggle = page.getByRole('button', {name: '查看待确认动作', exact: true});
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    const card = page.getByRole('textbox', {name: '确认后执行的修改', exact: true}); await card.waitFor();
    const text = await card.inputValue(); for (let i = 1; i <= 4; i++) assert(text.includes('虚构原生指代纸样0' + i));
    assert(!text.includes('无关邮箱')); await card.scrollIntoViewIfNeeded(); await page.screenshot({path: join(root, 'voice-task-subject-card.png')});
    const saved = await page.evaluate(async () => {
      const p = app.plugins.getPlugin('lifeops-assistant'), h = globalThis.__taskSubject;
      const view = app.workspace.getLeavesOfType('lifeops-assistant-view')[0].view;
      view.setAgentInput('确定'); await view.sendAgentMessage(); const beforeReplay = await h.facts();
      await p.executeAgentAction(h.action).catch(() => undefined); const afterReplay = await h.facts();
      return {same: JSON.stringify(beforeReplay) === JSON.stringify(afterReplay), group: await Promise.all(h.group.map(t => p.store.getTask(t.id))),
        other: await p.store.getTask(h.other.id), expectedOther: h.other,
        noExtraModel: h.round === 3,
        writes: [...new Map(h.receipts.map(r => [r.operationId, r])).values()].map(r => r.taskEdits?.length)};
    });
    await writeFile(join(root, 'voice-task-subject.json'), JSON.stringify({preview, saved}, null, 2));
    assert(saved.same && saved.noExtraModel); assert.deepEqual(saved.writes, [4]); assert.deepEqual(saved.other, saved.expectedOther);
    for (const task of saved.group) { assert.equal(task.date, '2026-11-29'); assert.equal(task.startTime, '19:00'); assert.equal(task.endTime, '19:30'); }
    result.voiceTaskSubject = {inputSource: 'voice', originalChatEntry: true, noWriteBeforeCard: preview.unchanged,
      fullHistory: preview.fullHistory, confirmWithoutAnotherModel: saved.noExtraModel, repeatUnchanged: saved.same};
    result.checks.voiceTaskSubjectFullOriginalHistory = true;
    result.checks.voiceWrongTaskStoppedBeforeCanonicalWrite = true;
    result.checks.voiceFourTaskCardConfirmOnceAndReplaySafe = true;
  } finally {
    const cleaned = await page.evaluate(async () => {
      const p = app.plugins.getPlugin('lifeops-assistant'), h = globalThis.__taskSubject;
      p.createAgentRuntime = h.factory; p.submitAgentMessageStream = h.submit;
      p.ai.agentTurnStream = h.instance; Object.getPrototypeOf(p.ai).agentTurnStream = h.prototype;
      for (const receipt of [...new Map(h.receipts.map(r => [r.operationId, r])).values()].reverse()) await p.createAgentRuntime().undoOperation(receipt.operationId);
      for (const task of [...h.group, h.other]) await p.store.deleteTask(task.id);
      const after = (await p.store.readTaskDb()).tasks, before = h.before; delete globalThis.__taskSubject; return {before, after};
    });
    assert.deepEqual(cleaned.after, cleaned.before); result.checks.voiceTaskSubjectUndoRestoresOriginals = true;
  }
}
