import assert from "node:assert/strict";

/** Production background speech preparation in the native fictional app.
 * No microphone, playback, provider traffic or facts writes are involved. */
export async function nativeReportSpeech(page, result) {
  const observed = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), before = await p.store.readPath(p.store.taskDbPath());
    const instance = p.ai.agentTurnStream, proto = Object.getPrototypeOf(p.ai), prototype = proto.agentTurnStream;
    const ai = p.settings.ai, privacy = p.settings.privacy;
    const reports = [
      ["交易", ["上周记录4笔交易。", "上周人民币净盈亏是-120元。", "上周美元净盈亏是35美元。"]],
      ["学习", ["上周学习记录75分钟。", "上周完成3项练习。", "上周计划150分钟。"]],
      ["归档", ["这两周覆盖14天。", "这两周2天命中归档主题。", "这两周12天有日记但未提及归档主题。"]]
    ];
    const runs = [];
    p.settings.ai = { ...ai, provider: "custom", endpoint: "https://fiction.invalid/chat", apiKey: "fictional-key",
      model: "synthetic", fallbackProvider: "off", dataDisclosureAccepted: true };
    p.settings.privacy = { ...privacy, plaintextCredentialStorageAccepted: true };
    try {
      for (const [name, facts] of reports) for (const mode of ["unavailable", "wrong-number", "markdown"]) {
        let calls = 0;
        const detail = "# 虚构" + name + "报告\n\n" + facts.join("\n");
        const mock = async () => {
          calls++;
          if (calls === 1) return { content: "正在核对。", toolCalls: [] };
          if (calls === 2) return { content: detail, toolCalls: [] };
          if (calls !== 3) throw Error("Unexpected extra report request");
          if (mode === "unavailable") throw Error("虚构口语整理不可用");
          return { content: mode === "wrong-number" ? "上周记录999笔交易。" : "# 请看面板", toolCalls: [] };
        };
        p.ai.agentTurnStream = mock; proto.agentTurnStream = mock;
        const answer = await p.submitAgentMessage("总结虚构" + name + "报告", [], { source: "voice", voiceBackground: true, selfTest: true });
        runs.push({ name, mode, facts, detail, reply: answer.reply, speech: answer.voiceSpeech,
          receipts: answer.receipts?.length ?? 0, calls });
      }
    } finally {
      p.ai.agentTurnStream = instance; proto.agentTurnStream = prototype; p.settings.ai = ai; p.settings.privacy = privacy;
    }
    return { runs, before, after: await p.store.readPath(p.store.taskDbPath()) };
  });
  assert.equal(observed.runs.length, 9); assert.equal(observed.after, observed.before);
  for (const run of observed.runs) {
    assert.equal(run.reply, run.detail); assert.equal(run.calls, 3); assert.equal(run.receipts, 0);
    for (const fact of run.facts) assert(run.speech.includes(fact));
    assert(run.speech.length <= 180 && !/999|面板|\||#/u.test(run.speech));
  }
  result.checks.backgroundReportSpeechKeepsFactsAcrossNineFailures = true;
  result.reportSpeech = { reports: 3, runs: 9, passed: 9, physicalAudio: false, providerTraffic: false };
}
