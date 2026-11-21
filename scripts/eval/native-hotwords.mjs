/** Read the production collector in the guarded fictional native vault, without starting audio. */
import assert from "node:assert/strict";

export async function nativeHotwords(page, result) {
  const state = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant");
    const before = (await p.store.readTaskDb()).tasks, settings = JSON.stringify(p.settings.realtimeVoice);
    const date = new Date().toLocaleDateString("sv-SE"), added = [];
    let words, manual;
    try {
      for (const title of ["和虚构人物陆辰整理蓝色纸盒", "给林小葵送蓝色样品盒"]) {
        const task = await p.store.createTask({ title, date }); added.push(task.id);
      }
      words = await p.collectVoiceSessionHotwords(undefined);
      manual = await p.collectVoiceSessionHotwords(Array.from({ length: 50 }, (_, i) => "虚构手填词" + i).join("\n"));
    } finally {
      for (const id of added) await p.store.deleteTask(id);
    }
    return { before, after: (await p.store.readTaskDb()).tasks, words, manual,
      settingsUnchanged: settings === JSON.stringify(p.settings.realtimeVoice) };
  });
  for (const word of ["陆辰", "林小葵", "纸盒", "样品盒"]) assert(state.words.includes(word), "Missing full fragment: " + word);
  assert(state.words.length <= 50); assert.equal(new Set(state.words).size, state.words.length);
  assert.deepEqual(state.manual, Array.from({ length: 50 }, (_, i) => "虚构手填词" + i));
  assert.deepEqual(state.after, state.before); assert(state.settingsUnchanged);
  result.checks.nativeAutomaticHotwordsKeepCompleteNamesAndObjects = true;
  result.checks.nativeHotwordsPreserveManualPrioritySettingsAndTasks = true;
}
