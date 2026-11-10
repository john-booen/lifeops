import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";
import { LifeOpsAi } from "../../src/ai";
import { AgentRuntime } from "../../src/agentRuntime";
import { BailianRealtimeClient } from "../../src/bailianRealtime";
import { configuredCredentials, redactSensitiveText } from "../../src/credentialSecurity";
import { DEFAULT_SETTINGS } from "../../src/defaults";
import LifeOpsPlugin from "../../src/main";
import { migrateRealtimeVoiceSettings } from "../../src/settingsMigration";
import { LifeOpsStore } from "../../src/store";
import type { StoreHost } from "../../src/store/settingsSlice";
import type { LifeOpsSettings, RealtimeVoiceSettings } from "../../src/types";
import { markVoiceLatency, type VoiceLatency } from "../../src/voice/latency";
import { BreezeResidentWorker } from "../../src/voice/breezeResident";
import { BreezeResidentTtsClient, VoiceSpeechParts } from "../../src/voice/breezeSpeech";
import { ServerVoiceEndpoint } from "../../src/voice/continuousInput";
import { backgroundVoiceQuestion, VoiceJobManager, voiceJobSpeech } from "../../src/voice/jobs";
import { base64ToPcm16, cleanVoiceReplyForSpeech } from "../../src/voice/voiceRealtime";
import { createFsApp } from "../helpers/fsApp";
import { isolatedProviderConfig } from "./isolatedProviderConfig";
import { EvalTransport } from "./liveTransport";
import { correctionHistory } from "./correctionHistory";
import { scoreEvaluationCase, type EvalObservation, type EvalQuestion } from "./scoring";
import { createVoiceWorklet } from "./voiceWorklet";
// @ts-expect-error The fixture marker and clock are shared with the text evaluation.
import { EVAL_MARKER, EVAL_NOW } from "../../scripts/make-eval-vault.mjs";

vi.mock("obsidian", () => ({
  App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {},
  Modal: class {}, PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, Notice: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(), requestUrl: vi.fn(),
  parseYaml: (yaml: string) => JSON.parse(yaml), stringifyYaml: (fields: unknown) => JSON.stringify(fields)
}));
const { requestUrl } = await import("obsidian");
const run = promisify(execFile);

interface VoiceCase { id: string; text: string }

async function voiceSettings() {
  const config = JSON.parse(await readFile(await isolatedProviderConfig(), "utf8")) as LifeOpsSettings;
  const { ai, realtimeVoice } = config;
  if (ai.provider === "off" || !ai.apiKey || !ai.dataDisclosureAccepted || !ai.model || !ai.endpoint
    || realtimeVoice.provider !== "qwen-omni-realtime" || !realtimeVoice.apiKey || !realtimeVoice.dataDisclosureAccepted
    || !config.privacy?.plaintextCredentialStorageAccepted) throw Error("语音评测需要已授权的文字和百炼语音设置");
  const voiceUrl = new URL(realtimeVoice.endpoint || "wss://dashscope.aliyuncs.com");
  if (voiceUrl.protocol !== "wss:" || voiceUrl.hostname !== "dashscope.aliyuncs.com" || voiceUrl.username || voiceUrl.password) {
    throw Error("虚构语音只发送给百炼官方实时地址");
  }
  const endpoints = [ai.endpoint, ...(ai.fallbackProvider !== "off" && ai.fallbackEndpoint ? [ai.fallbackEndpoint] : [])];
  for (const endpoint of endpoints) {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw Error("虚构评测模型须使用无凭据参数的 HTTPS 地址");
  }
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.ai = { ...settings.ai, ...ai };
  settings.privacy = { ...settings.privacy, plaintextCredentialStorageAccepted: true, excludedVaultPrefixes: [] };
  settings.realtimeVoice = migrateRealtimeVoiceSettings({ ...settings.realtimeVoice, ...realtimeVoice, ttsEngine: "breeze-local",
    plaintextCredentialStorageAccepted: true, speakReplies: true });
  settings.embedding.provider = "off";
  settings.proactive.enabled = false;
  return { settings, transport: new EvalTransport(endpoints) };
}

async function preparePcm(directory: string, item: VoiceCase, speechRate = 200): Promise<Buffer> {
  const aiff = join(directory, item.id + ".aiff"), pcm = join(directory, item.id + ".pcm");
  await run("say", ["-v", "Tingting", "-r", String(speechRate), "-o", aiff, item.text]);
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", aiff, "-af", "adelay=250,apad=pad_dur=1.3",
    "-f", "s16le", "-ar", "16000", "-ac", "1", pcm]);
  const audio = await readFile(pcm);
  let peak = 0;
  for (let index = 0; index + 1 < audio.length; index += 2) peak = Math.max(peak, Math.abs(audio.readInt16LE(index)));
  if (peak < 1000) throw Error(item.id + " 的虚构录音没有有效声音");
  return audio;
}

async function transcribe(pcm: Buffer, settings: RealtimeVoiceSettings, latency: VoiceLatency): Promise<string> {
  let transcript = "", error = "";
  const endpoint = new ServerVoiceEndpoint();
  const client = new BailianRealtimeClient(settings, {
    onCascadeCapture: event => {
      const capture = endpoint.accept(event);
      if (!capture) return;
      if (event.type === "stopped") markVoiceLatency(latency, "t0");
      if (event.type === "final") markVoiceLatency(latency, "t1");
      if (capture.ready !== undefined) transcript = capture.ready;
    },
    onError: () => { error = "听写服务报错"; },
    onDisconnected: () => { error ||= "听写连接中断"; }
  });
  try {
    await client.connect();
    await wait(500);
    const audio = Buffer.concat([pcm, Buffer.alloc(16_000)]);
    for (let offset = 0; offset < audio.length && !error && (latency.t0 === undefined || latency.t1 === undefined); offset += 640) {
      client.appendPcm16(audio.subarray(offset, offset + 640).toString("base64"));
      await wait(20);
    }
    for (let attempt = 0; !error && (latency.t0 === undefined || latency.t1 === undefined) && attempt < 80; attempt++) await wait(100);
    if (error || latency.t0 === undefined || latency.t1 === undefined || !transcript.trim()) throw Error(error || "听写未完整返回");
    return transcript;
  } finally { client.close(); }
}

async function renderFirstAudio(text: string | VoiceSpeechParts, settings: RealtimeVoiceSettings, worker: BreezeResidentWorker, latency: VoiceLatency): Promise<void> {
  const output = createVoiceWorklet(event => {
    if (event.type === "started") markVoiceLatency(latency, "t5");
  });
  let rendered: Promise<void> | undefined;
  const breeze = new BreezeResidentTtsClient(settings, { onOpen: () => { markVoiceLatency(latency, "t3"); }, onAudioDelta: (base64, rate) => {
    const pcm = base64ToPcm16(base64);
    if (!pcm.length || !markVoiceLatency(latency, "t4")) return;
    rendered = output.actor.start("voice-latency", "fallback-tts").then(() => {
      if (!output.actor.appendPcm16("voice-latency", pcm, rate)) throw Error("首段 PCM 入队失败");
      output.render();
    });
    void rendered.catch(() => undefined);
  } }, worker);
  try {
    await (typeof text === "string" ? breeze.speak(text) : breeze.speakStream(text));
    await rendered;
    if (latency.t5 === undefined) throw Error("AudioWorklet 未渲染首段声音");
  } finally {
    breeze.cancel();
    await output.actor.close();
  }
}

function transcriptKey(text: string): string {
  return text.normalize("NFKC").replace(/[\p{P}\p{Z}\s]/gu, "");
}

async function sample(item: VoiceCase, pcm: Buffer, settings: LifeOpsSettings, worker: BreezeResidentWorker, round: number, transport: EvalTransport) {
  const root = await mkdtemp(join(tmpdir(), "lifeops-voice-eval-vault-"));
  const latency: VoiceLatency = {};
  const parts = new VoiceSpeechParts();
  let playback: Promise<void> | undefined;
  let exactTranscript = false, reason: string | undefined;
  try {
    await cp("fixtures/eval-vault", root, { recursive: true });
    if (!(await readFile(join(root, "TEST_VAULT_ONLY.md"), "utf8")).includes(EVAL_MARKER)) throw Error("语音评测夹具缺少全虚构标记");
    const app = createFsApp(root), store = new LifeOpsStore(app, structuredClone(settings));
    await store.initializeVault();
    const plugin: LifeOpsPlugin = Object.assign(Object.create(LifeOpsPlugin.prototype), {
      app, store, settings: store.settings, lifecycleGeneration: 1, unloaded: false, ai: new LifeOpsAi(store.settings),
      updateStatusBar: async () => {}, refreshViews: async () => {}, lifeOpsEvents: { publish: () => {} }, buildSemanticContext: async () => ""
    });
    const transcript = await transcribe(pcm, settings.realtimeVoice, latency);
    exactTranscript = transcriptKey(transcript) === transcriptKey(item.text);
    const jobs = new VoiceJobManager(async () => "这是语音时延夹具的后台占位结果。", () => undefined);
    const response = await plugin.submitAgentMessageStream(transcript, [], text => {
      if (text.trim()) markVoiceLatency(latency, "t2");
    }, { source: "voice", signal: AbortSignal.timeout(60_000), voiceJobs: jobs, deferConversation: true,
      onVoiceText: delta => {
        parts.push(delta);
        playback ??= renderFirstAudio(parts, settings.realtimeVoice, worker, latency);
        void playback.catch(() => undefined);
      } });
    const text = cleanVoiceReplyForSpeech(response.reply);
    parts.finish(text);
    if (!text || latency.t2 === undefined) throw Error("模型没有返回可朗读文字");
    await (playback ?? renderFirstAudio(text, settings.realtimeVoice, worker, latency));
  } catch (error) {
    reason = redactSensitiveText(error, configuredCredentials(settings)).slice(0, 160);
  } finally {
    parts.finish("");
    await playback?.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
  return { id: item.id, round, kind: item.id.startsWith("s") ? "simple" : "complex", exactTranscript, latency,
    ...(await transport.usage()), ...(reason ? { reason } : {}) };
}

const reportOnly = process.env.LIFEOPS_VOICE_REPORT === "1";
const correctionOnly = process.env.LIFEOPS_VOICE_CORRECTIONS === "1";

it.skipIf(reportOnly || correctionOnly || process.env.LIFEOPS_VOICE_JOBS === "1" || process.env.LIFEOPS_VOICE_SOAK === "1")("measures 30 simple and 15 complex fictional turns through real providers and the PCM worklet", async () => {
  const rows = (await readFile("tests/eval/voice-cases.tsv", "utf8")).trim().split("\n").map(row => {
    const [id, text] = row.split("\t");
    if (!/^[sc]\d{2}$/.test(id) || !text) throw Error("语音评测夹具格式异常");
    return { id, text };
  });
  expect(rows.filter(item => item.id.startsWith("s"))).toHaveLength(10);
  expect(rows.filter(item => item.id.startsWith("c"))).toHaveLength(5);
  const selected = process.env.LIFEOPS_VOICE_PROBE;
  const cases = selected ? rows.filter(item => item.id === selected)
    : process.env.LIFEOPS_VOICE_SIMPLE_ONLY === "1" ? rows.filter(item => item.id.startsWith("s")) : rows;
  if (!cases.length) throw Error("未知语音诊断编号");
  const directory = await mkdtemp(join(tmpdir(), "lifeops-voice-eval-"));
  process.stdout.write(`虚构语音评测输出 ${directory}\n`);
  const { settings, transport } = await voiceSettings();
  const worker = new BreezeResidentWorker(settings.realtimeVoice);
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("fetch", transport.fetch);
  vi.mocked(requestUrl).mockImplementation(transport.requestUrl);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(EVAL_NOW));
  try {
    const clips = new Map<string, Buffer>();
    for (const item of cases) clips.set(item.id, await preparePcm(directory, item));
    const sha256 = createHash("sha256");
    for (const [id, pcm] of clips) sha256.update(id).update(pcm);
    process.stdout.write(`虚构音频指纹 ${sha256.digest("hex")}\n`);
    await worker.warm();
    for (let round = 1; round <= (selected ? 1 : 3); round++) {
      for (const item of cases) {
        transport.reset();
        const line = JSON.stringify(await sample(item, clips.get(item.id)!, settings, worker, round, transport)) + "\n";
        await appendFile(join(directory, "voice-metrics.jsonl"), line);
        process.stdout.write(line);
      }
    }
  } finally { await worker.close(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }
}, 30 * 60_000);

it.runIf(correctionOnly)("answers finalized fictional spoken corrections through the production conversation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lifeops-voice-correction-"));
  const { settings, transport } = await voiceSettings();
  const questions = (JSON.parse(await readFile("tests/eval/questions.json", "utf8")) as EvalQuestion[])
    .filter(question => question.domain === "voice-correction");
  const failures: string[] = [];
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("fetch", transport.fetch);
  vi.mocked(requestUrl).mockImplementation(transport.requestUrl);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(EVAL_NOW));
  try {
    expect(questions).toHaveLength(5);
    for (const question of questions) {
      const root = join(directory, question.id);
      const tools: EvalObservation["tools"] = [];
      const execute = AgentRuntime.prototype.executeToolCall;
      const spy = vi.spyOn(AgentRuntime.prototype, "executeToolCall").mockImplementation(async function (this: AgentRuntime, request, control) {
        const result = await execute.call(this, request, control);
        let facts: unknown;
        const expectedFacts = [...(question.checks.toolFacts ?? []), ...(question.checks.anyToolFacts ?? [])];
        if (result.success && expectedFacts.some(fact => fact.name === request.toolName)) {
          try { facts = JSON.parse(result.output); } catch { /* A non-JSON result cannot prove the queried period. */ }
        }
        tools.push({ name: request.toolName, ok: result.success, facts });
        return result;
      });
      try {
        const pcm = await preparePcm(directory, { id: question.id, text: question.input }, 145);
        const transcript = await transcribe(pcm, settings.realtimeVoice, {});
        expect(transcriptKey(transcript)).toBe(transcriptKey(question.input));
        await cp("fixtures/eval-vault", root, { recursive: true });
        expect(await readFile(join(root, "TEST_VAULT_ONLY.md"), "utf8")).toContain(EVAL_MARKER);
        const app = createFsApp(root), store = new LifeOpsStore(app, structuredClone(settings));
        await store.initializeVault();
        const host = store as unknown as StoreHost;
        const before = (await host.readTaskDb()).tasks;
        const plugin: LifeOpsPlugin = Object.assign(Object.create(LifeOpsPlugin.prototype), {
          app, store, settings: store.settings, lifecycleGeneration: 1, unloaded: false, ai: new LifeOpsAi(store.settings),
          updateStatusBar: async () => {}, refreshViews: async () => {}, lifeOpsEvents: { publish: () => {} }, buildSemanticContext: async () => ""
        });
        const history = await correctionHistory(question, host);
        const reply = await plugin.submitAgentMessage(transcript, history, { source: "voice", deferConversation: true });
        const after = (await host.readTaskDb()).tasks;
        const createdTasks = after.filter(task => !before.some(previous => previous.id === task.id));
        const issues = scoreEvaluationCase(question, { reply: reply.reply, tools, tasks: after, createdTasks, preludeCreatedTasks: 0,
          confirmations: reply.actions.length, receipts: reply.receipts?.length ?? 0, writes: { "tasks.created": createdTasks.length,
            "tasks.deleted": before.filter(task => !after.some(current => current.id === task.id)).length }, confirmationActions: [] });
        expect(issues, reply.reply).toEqual([]);
        expect(reply.receipts ?? []).toEqual([]);
        process.stdout.write(`${question.id} · 录音与回答通过 · ${tools.map(tool => tool.name).join("、")}\n`);
      } catch (error) {
        const failure = redactSensitiveText(error instanceof Error ? error.message : String(error), configuredCredentials(settings));
        failures.push(`${question.id} · ${failure}`);
        process.stdout.write(`${failures.at(-1)}\n`);
      } finally { spy.mockRestore(); }
    }
    expect(failures).toEqual([]);
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
});

async function checkSpokenMonthlyReport(plugin: LifeOpsPlugin): Promise<void> {
  const original = LifeOpsAi.prototype.agentTurnStream;
  const draft: string[] = [];
  const trace = process.env.LIFEOPS_EVAL_DIAGNOSTICS === "1" ? vi.spyOn(LifeOpsAi.prototype, "agentTurnStream")
    .mockImplementation(async function (this: LifeOpsAi, ...args) {
      const speechRequest = args[0][0]?.content.includes("只返回要念的句子");
      try {
        const result = await original.call(this, ...args);
        if (speechRequest) draft.push(result.content);
        return result;
      } catch (error) {
        if (speechRequest) draft.push(error instanceof Error ? error.message : String(error));
        throw error;
      }
    }) : undefined;
  const executeTool = AgentRuntime.prototype.executeToolCall;
  const ranges: Array<{ from: string; to: string }> = [];
  const tools = vi.spyOn(AgentRuntime.prototype, "executeToolCall").mockImplementation(
    async function (this: AgentRuntime, request, control) {
      const result = await executeTool.call(this, request, control);
      if (result.success && ["get_summaries", "get_stats"].includes(request.toolName)) {
        const { range } = JSON.parse(result.output);
        if (range) ranges.push({ from: range.from, to: range.to });
      }
      return result;
    });
  const report = async (question: string, range: { from: string; to: string }) => {
    ranges.length = 0;
    let failure = "";
    const jobs = new VoiceJobManager((request, signal) => plugin.submitAgentMessage(backgroundVoiceQuestion(request), [], {
      source: "voice", voiceBackground: true, deferConversation: true, signal: AbortSignal.any([signal, AbortSignal.timeout(110_000)])
    }).catch(error => {
      failure = redactSensitiveText(error, configuredCredentials(plugin.settings));
      throw error;
    }), () => undefined);
    try {
      const ack = await plugin.submitAgentMessage(question, [], { source: "voice", voiceJobs: jobs, deferConversation: true,
        signal: AbortSignal.timeout(25_000) });
      expect(ack.reply).toBe("好，我去整理一下，好了告诉你。");
      await vi.waitFor(() => expect(jobs.list()[0]?.status).not.toBe("running"), { timeout: 115_000, interval: 250 });
      const result = jobs.list()[0];
      expect(result.status, `${range.from} 至 ${range.to} · ${failure || result.result || "没有结果"} · 工具读回 ${JSON.stringify(ranges)}`).toBe("done");
      expect(ranges).toContainEqual(range);
      process.stdout.write(`虚构后台日期通过 · ${range.from} 至 ${range.to}\n`);
      return { reply: result.result!, voiceSpeech: result.voiceSpeech };
    } finally { jobs.stop(); }
  };
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-08T21:00:00+08:00"));
  const issues: string[] = [];
  const saveFailure = (label: string, error: unknown) => {
    const reason = redactSensitiveText(error, configuredCredentials(plugin.settings));
    issues.push(`${label} · ${reason}`);
    process.stdout.write(`${issues.at(-1)}\n`);
  };
  try {
    try {
      const monthly = await report("请在后台用 Markdown 表格总结上个月的虚构任务完成情况。列周起始日、计划数、完成数、完成率，最后一行为合计。表格后给一条下一步建议。",
        { from: "2026-10-01", to: "2026-10-31" });
      if (trace && monthly.voiceSpeech === "详细内容已经放到面板里了。") {
        const evidence = JSON.stringify({ detail: monthly.reply.slice(0, 1500), draft });
        process.stdout.write(`虚构口语稿回退 · ${redactSensitiveText(evidence, configuredCredentials(plugin.settings))}\n`);
      }
      expect(monthly.reply).toMatch(/\|.*周起始日.*\|/);
      expect(monthly.voiceSpeech).toBeTruthy();
      expect(monthly.voiceSpeech).not.toMatch(/[|#]|周起始日|\bpunishment\b/iu);
      expect(monthly.voiceSpeech!.length).toBeLessThanOrEqual(180);
      process.stdout.write(JSON.stringify({ reportHasTable: true, detailLength: monthly.reply.length, spoken: monthly.voiceSpeech }) + "\n");
    } catch (error) { saveFailure("月报", error); }
    try {
      await report("请在后台总结上周的虚构任务完成情况。", { from: "2026-10-26", to: "2026-11-01" });
    } catch (error) { saveFailure("周报", error); }
    expect(issues).toEqual([]);
  } finally {
    tools.mockRestore();
    trace?.mockRestore();
    vi.useRealTimers();
  }
}

it.runIf(reportOnly || process.env.LIFEOPS_VOICE_JOBS === "1")(reportOnly
  ? "keeps a fictional monthly report table and prepares separate speech"
  : "routes fictional long work, two short turns and ten spoken cancellations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lifeops-voice-jobs-eval-"));
  const root = join(directory, "vault");
  const { settings, transport } = await voiceSettings();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("fetch", transport.fetch);
  vi.mocked(requestUrl).mockImplementation(transport.requestUrl);
  let releaseDeep!: () => void;
  const foregroundDone = new Promise<void>(resolve => { releaseDeep = resolve; });
  let jobs: VoiceJobManager | undefined;
  let controlJobs: VoiceJobManager | undefined;
  try {
    await cp("fixtures/eval-vault", root, { recursive: true });
    expect(await readFile(join(root, "TEST_VAULT_ONLY.md"), "utf8")).toContain(EVAL_MARKER);
    const app = createFsApp(root), store = new LifeOpsStore(app, settings);
    await store.initializeVault();
    const plugin: LifeOpsPlugin = Object.assign(Object.create(LifeOpsPlugin.prototype), {
      app, store, settings: store.settings, lifecycleGeneration: 1, unloaded: false, ai: new LifeOpsAi(store.settings),
      updateStatusBar: async () => {}, refreshViews: async () => {}, lifeOpsEvents: { publish: () => {} }, buildSemanticContext: async () => ""
    });
    if (reportOnly) return await checkSpokenMonthlyReport(plugin);
    const dictate = async (id: string, text: string) => transcribe(await preparePcm(directory, { id, text }), settings.realtimeVoice, {});
    const long = await dictate("job", "请在后台复盘十月的虚构交易，逐项核对统计和交易纪律。");
    const cancel = await dictate("cancel", "上面那个不用了。");
    expect(transcriptKey(cancel)).toBe("上面那个不用了");
    const cancellationSignals: AbortSignal[] = [];
    controlJobs = new VoiceJobManager((_request, signal) => {
      cancellationSignals.push(signal);
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }, () => undefined);
    let deepError = "";
    jobs = new VoiceJobManager(async (request, signal) => {
      const result = await plugin.submitAgentMessage(backgroundVoiceQuestion(request), [], { source: "voice", voiceBackground: true,
        signal: AbortSignal.any([signal, AbortSignal.timeout(125_000)]), deferConversation: true }).catch(error => {
          deepError = redactSensitiveText(error, configuredCredentials(settings));
          throw error;
        });
      await foregroundDone;
      return result.reply;
    }, () => undefined);
    const ask = (text: string, manager = jobs) => plugin.submitAgentMessage(text, [], { source: "voice", voiceJobs: manager,
      signal: AbortSignal.timeout(25_000), deferConversation: true });
    const ack = await ask(long);
    expect(ack.reply).toBe("好，我去整理一下，好了告诉你。");
    process.stdout.write("实际快速模型已接到后台任务。\n");
    for (const question of ["你好。", "你能帮我做什么？"]) {
      expect((await ask(question)).reply.trim().length).toBeGreaterThan(0);
      expect(jobs.list()[0].status).toBe("running");
    }
    releaseDeep();
    process.stdout.write("实际快速模型已答完两轮短问。\n");
    const cancelled: boolean[] = [];
    const failureReplies: string[] = [];
    for (let index = 0; index < 10; index++) {
      controlJobs.start({ title: `虚构复盘${index + 1}`, question: "整理虚构材料", scope: "" });
      const response = await ask(cancel, controlJobs).catch(() => undefined);
      const ok = Boolean(response?.reply.includes("已经取消") && cancellationSignals[index]?.aborted);
      cancelled.push(ok);
      if (!ok) {
        failureReplies.push(response?.reply.slice(0, 120) ?? "请求失败");
        controlJobs.cancel("latest");
      }
    }
    controlJobs.start({ title: "虚构交易", question: "整理虚构材料", scope: "" });
    controlJobs.start({ title: "虚构学习", question: "整理虚构材料", scope: "" });
    const unclear = await ask(cancel, controlJobs);
    const clarified = ["虚构交易", "虚构学习"].every(title => unclear.reply.includes(title))
      && cancellationSignals.slice(-2).every(signal => !signal.aborted);
    process.stdout.write(JSON.stringify({ cancelled, clarified, failureReplies,
      ...(!clarified ? { clarificationReply: unclear.reply.slice(0, 120), abortedDuringClarification: cancellationSignals.slice(-2).map(signal => signal.aborted) } : {}) }) + "\n");
    await vi.waitFor(() => expect(jobs?.list()[0].status).not.toBe("running"), { timeout: 128_000, interval: 150 });
    const usage = await transport.usage();
    process.stdout.write(JSON.stringify({ long: jobs.list()[0].status, deepError, short: 2, cancelled, ...usage }) + "\n");
    const result = jobs.takeAnnouncement();
    expect(result?.result).toBeTruthy();
    jobs.settleAnnouncement(result!.id, false);
    const undo = await dictate("undo", "撤销。");
    expect(transcriptKey(undo)).toBe("撤销");
    for (const [manager, command] of [[jobs, undo], [controlJobs, "撤销刚刚的代办。"], [jobs, "把上面的撤销。"], [controlJobs, undo]] as const) {
      const title = "给虚构样品盒贴标签";
      await ask(`请新建待办，标题是「${title}」，安排在明天下午三点。`, manager);
      expect((await store.readTaskDb()).tasks.some(task => task.title === title)).toBe(true);
      const reverted = await ask(command, manager);
      process.stdout.write(JSON.stringify({ undoCase: manager === jobs ? "interrupted-result" : "running-jobs",
        reply: reverted.reply.slice(0, 100), spoken: reverted.voiceSpeech }) + "\n");
      expect(reverted.voiceSpeech).toContain(`已撤销创建任务「${title}」`);
      expect((await store.readTaskDb()).tasks.some(task => task.title === title)).toBe(false);
    }
    expect(jobs.list()[0].status).toBe("done");
    expect(controlJobs.list().slice(-2).every(job => job.status === "running")).toBe(true);
    process.stdout.write("真实模型完成四次保存与语音撤销，后台任务状态保持正确。\n");
    expect(cancelled.filter(Boolean)).toHaveLength(10);
    expect(clarified).toBe(true);
    await checkSpokenMonthlyReport(plugin);
  } catch (error) {
    throw Error(redactSensitiveText(error, configuredCredentials(settings)));
  } finally {
    releaseDeep();
    jobs?.stop();
    controlJobs?.stop();
    vi.unstubAllGlobals(); vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
}, 12 * 60_000);

class IsolatedVoiceInput {
  private readonly endpoint = new ServerVoiceEndpoint();
  private readonly silence = Buffer.alloc(640).toString("base64");
  private ticker?: ReturnType<typeof setInterval>;
  private pending?: { pcm: Buffer; offset: number; timer: ReturnType<typeof setTimeout>; resolve: (text: string) => void; reject: (error: Error) => void };
  private failure?: string;
  private readonly client: BailianRealtimeClient;
  private socket?: WebSocket;

  constructor(settings: RealtimeVoiceSettings) {
    this.client = new BailianRealtimeClient(settings, {
      onCascadeCapture: event => {
        const text = this.endpoint.accept(event)?.ready;
        if (text !== undefined && text.trim()) this.finish(text);
      },
      onError: () => this.fail("听写服务错误"),
      onDisconnected: ({ code }) => this.fail(`听写连接断开 ${code}`)
    });
  }

  async connect(): Promise<void> {
    const connecting = this.client.connect();
    this.socket = this.client["socket"] ?? undefined;
    await connecting;
    this.ticker = setInterval(() => {
      if (this.failure) return;
      const read = this.pending;
      const chunk = read && read.offset < read.pcm.length ? read.pcm.subarray(read.offset, read.offset += 640) : undefined;
      this.client.appendPcm16(chunk?.toString("base64") || this.silence);
    }, 20);
  }

  read(pcm: Buffer): Promise<string> {
    if (this.failure || this.pending) return Promise.reject(Error(this.failure || "上一轮听写尚未完成"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.finish(undefined, Error("听写等待超时")), 18_000);
      this.pending = { pcm, offset: 0, timer, resolve, reject };
    });
  }

  async close(): Promise<void> {
    clearInterval(this.ticker);
    this.ticker = undefined;
    this.finish(undefined, Error("听写已结束"));
    this.client.close();
    const socket = this.socket;
    if (!socket) return;
    const closed = () => expect(socket.readyState).toBe(WebSocket.CLOSED);
    try {
      await vi.waitFor(closed, { timeout: 5000 });
    } catch (error) {
      socket.terminate();
      await vi.waitFor(closed, { timeout: 2000 });
      throw error;
    }
  }

  resources(): number {
    return Number(Boolean(this.ticker)) + Number(Boolean(this.pending))
      + Number(Boolean(this.socket && this.socket.readyState !== WebSocket.CLOSED));
  }

  private fail(message: string): void {
    this.failure = message;
    this.finish(undefined, Error(message));
  }

  private finish(text?: string, error?: Error): void {
    const current = this.pending;
    if (!current) return;
    this.pending = undefined;
    clearTimeout(current.timer);
    this.client.resetTranscript();
    if (error) current.reject(error); else current.resolve(text ?? "");
  }
}

async function speakSoakReply(output: ReturnType<typeof createVoiceWorklet>, worker: BreezeResidentWorker,
  settings: RealtimeVoiceSettings, id: string, text: string, interrupt: boolean): Promise<void> {
  const stop = new AbortController();
  await output.actor.start(id, "fallback-tts");
  let first = false;
  const client = new BreezeResidentTtsClient(settings, { onAudioDelta: (encoded, rate) => {
    const pcm = base64ToPcm16(encoded);
    if (!pcm.length || stop.signal.aborted) return;
    if (!output.actor.appendPcm16(id, pcm, rate)) throw Error("首段声音未进入播放器");
    first = true;
    if (interrupt) {
      output.render();
      output.actor.cancel(id, "soak_voice_interruption");
      if (output.render().some(value => value !== 0)) throw Error("打断后仍有音频");
      stop.abort();
      return;
    }
    const frames = Math.ceil(pcm.length * 48_000 / rate / 128);
    for (let index = 0; index < frames; index++) output.render();
  } }, worker);
  try {
    await client.speak(cleanVoiceReplyForSpeech(text), { signal: stop.signal }).catch(error => {
      if (!stop.signal.aborted) throw error;
    });
    if (!first) throw Error("没有生成音频");
    if (!interrupt) {
      output.actor.finish(id);
      output.render();
      if (output.actor.snapshot()?.status !== "completed") throw Error("音频未完全退出队列");
    }
  } finally { client.cancel(); }
}

async function reportSoakResources(minute: number, input: IsolatedVoiceInput, worker: BreezeResidentWorker,
  output: ReturnType<typeof createVoiceWorklet>, plugin: LifeOpsPlugin, jobs: VoiceJobManager): Promise<void> {
  const pid = worker["worker"]?.child.pid;
  const breezeRssKiB = pid ? Number((await run("ps", ["-o", "rss=", "-p", String(pid)]).catch(() => ({ stdout: "" }))).stdout.trim()) || null : 0;
  process.stdout.write(JSON.stringify({ minute, evalProcessRssKiB: Math.round(process.memoryUsage().rss / 1024),
    breezeRssKiB, playbackNodes: Number(Boolean(output.actor["node"])), inputResources: input.resources(),
    pendingModelRequests: plugin["activeVoiceRequests"]?.size ?? 0, runningJobs: jobs.list().filter(job => job.status === "running").length }) + "\n");
}

it.runIf(process.env.LIFEOPS_VOICE_SOAK === "1")("keeps isolated voice resources stable for a continuous sixty-minute session", async () => {
  const smoke = process.env.LIFEOPS_VOICE_SOAK_SMOKE === "1";
  const rounds = smoke ? 3 : 60, interval = smoke ? 10_000 : 60_000;
  const directory = await mkdtemp(join(tmpdir(), "lifeops-voice-soak-")), root = join(directory, "vault");
  const { settings, transport } = await voiceSettings();
  const input = new IsolatedVoiceInput(settings.realtimeVoice);
  const worker = new BreezeResidentWorker(settings.realtimeVoice);
  const output = createVoiceWorklet(() => undefined);
  const failures: string[] = [];
  let heldJob = false, turns = 0;
  let jobs: VoiceJobManager | undefined;
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("fetch", transport.fetch);
  vi.mocked(requestUrl).mockImplementation(transport.requestUrl);
  try {
    await cp("fixtures/eval-vault", root, { recursive: true });
    expect(await readFile(join(root, "TEST_VAULT_ONLY.md"), "utf8")).toContain(EVAL_MARKER);
    const app = createFsApp(root), store = new LifeOpsStore(app, settings);
    await store.initializeVault();
    const plugin: LifeOpsPlugin = Object.assign(Object.create(LifeOpsPlugin.prototype), {
      app, store, settings: store.settings, lifecycleGeneration: 1, unloaded: false, ai: new LifeOpsAi(store.settings),
      updateStatusBar: async () => {}, refreshViews: async () => {}, lifeOpsEvents: { publish: () => {} }, buildSemanticContext: async () => ""
    });
    jobs = new VoiceJobManager(async ({ question }, signal) => {
      if (smoke && question === "预检已播完的虚构学习规划") return "虚构旧结果。";
      if (heldJob) await wait(150_000, undefined, { signal });
      const result = await plugin.submitAgentMessage(question, [], { source: "voice", voiceBackground: true, deferConversation: true,
        signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
      return result;
    }, () => undefined);
    if (smoke) {
      jobs.start({ title: "旧的虚构学习规划", question: "预检已播完的虚构学习规划", scope: "" });
      await vi.waitFor(() => expect(jobs?.list()[0].status).toBe("done"));
      jobs.settleAnnouncement(jobs.takeAnnouncement()!.id, true);
    }
    const prompts = [
      { id: "hello", text: "你好，简短回答一句。" },
      { id: "date", text: "今天是几号？只说日期。" },
      { id: "long", text: "请在后台整理三点虚构学习规划，限制在三句话。" },
      { id: "cancel", text: "上面那个不用了。" }
    ];
    const clips = new Map(await Promise.all(prompts.map(async item => [item.id, await preparePcm(directory, item)] as const)));
    await worker.warm();
    await input.connect();
    const started = performance.now();
    process.stdout.write(`隔离连续语音开始 ${smoke ? "预检" : "60 分钟"}\n`);
    for (let index = 0; index < rounds; index++) {
      const next = started + index * interval;
      if (next > performance.now()) await wait(next - performance.now());
      if (index % 5 === 0) await reportSoakResources(index, input, worker, output, plugin, jobs);
      const slot = smoke ? index + 3 : index % 12;
      const id = slot === 3 ? "long" : slot === 5 && (smoke || Math.floor(index / 12) % 2 === 0) ? "cancel" : index % 2 ? "date" : "hello";
      heldJob = id === "long" && (smoke || Math.floor(index / 12) % 2 === 0);
      let transcript = "";
      try {
        transcript = await input.read(clips.get(id)!);
        const result = await plugin.submitAgentMessage(transcript, [], { source: "voice", voiceJobs: jobs, deferConversation: true, signal: AbortSignal.timeout(25_000) });
        if (id === "long" && !result.reply.includes("好了告诉你")) throw Error("后台任务没有开始");
        if (id === "cancel" && !result.reply.includes("已经取消")) throw Error("取消未执行");
        await speakSoakReply(output, worker, settings.realtimeVoice, `soak-${index}`, result.reply, slot === 8);
        const completed = jobs.takeAnnouncement();
        if (completed?.result) {
          const spoken = `刚才的「${completed.title}」好了。${voiceJobSpeech(completed.result, completed.voiceSpeech)}`;
          await speakSoakReply(output, worker, settings.realtimeVoice, `soak-result-${index}`, spoken, false);
          jobs.settleAnnouncement(completed.id, true);
        }
        turns++;
      } catch (error) {
        failures.push(`${index + 1} ${redactSensitiveText(error, configuredCredentials(settings)).slice(0, 120)}`);
        process.stdout.write(JSON.stringify({ turn: index + 1, failure: failures.at(-1), syntheticTranscript: transcript.slice(0, 120) }) + "\n");
      }
    }
    const remaining = started + rounds * interval - performance.now();
    if (remaining > 0) await wait(remaining);
    const durationMs = Math.round(performance.now() - started);
    await reportSoakResources(rounds, input, worker, output, plugin, jobs);
    jobs.stop();
    await input.close();
    await Promise.all([output.actor.close(), worker.close()]);
    await vi.waitFor(() => expect(plugin["activeVoiceRequests"]?.size ?? 0).toBe(0), { timeout: 6000 });
    const resources = input.resources() + Number(Boolean(output.actor["node"])) + Number(Boolean(output.actor["context"]))
      + Number(Boolean(worker["worker"])) + Number(Boolean(output.actor["firstAudioTimer"] || output.actor["drainTimer"] || output.actor["idleSuspendTimer"]));
    process.stdout.write(JSON.stringify({ turns, durationMs, failures, resources }) + "\n");
    expect(resources).toBe(0);
    expect(failures).toEqual([]);
    expect(turns).toBe(rounds);
  } finally {
    jobs?.stop();
    try {
      await input.close();
    } finally {
      try {
        await Promise.all([output.actor.close(), worker.close()]);
      } finally {
        vi.unstubAllGlobals(); vi.restoreAllMocks();
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}, 75 * 60_000);
