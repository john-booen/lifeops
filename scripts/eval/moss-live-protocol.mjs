// Isolated speech comparison only. This module is not imported by the plugin.
// Protocol: https://platform.moss.cn/docs/reference/moss-live/
import assert from "node:assert/strict";

const id = value => typeof value === "string" && value.length > 0 && value.length <= 200;
const text = value => typeof value === "string" && value.length <= 16_000;

export class MossTrialProtocol {
  constructor(send, now = () => performance.now()) {
    this.send = send; this.now = now; this.state = "new";
    this.inputs = new Map(); this.runs = new Map(); this.events = [];
    this.unboundOutput = ""; this.pendingAudio = undefined; this.anonymousInputs = 0;
    this.acks = new Set(); this.totalAudioBytes = 0; this.droppedAudioBytes = 0;
  }

  opened() {
    assert.equal(this.state, "new", "Trial connection cannot be opened twice");
    this.state = "attaching";
    this.send({ action: "attach_session", memory_scope: "session", delegation: { type: "none" } });
  }

  run(data) {
    assert(id(data.run_id) && id(data.turn_id), "Missing speech response identity");
    const key = JSON.stringify([data.run_id, data.turn_id]);
    let run = this.runs.get(key);
    if (!run) {
      assert(this.runs.size < 16, "Trial response limit reached");
      run = { runId: data.run_id, turnId: data.turn_id, text: "", audioBytes: 0, startedAt: this.now() };
      this.runs.set(key, run);
    }
    return run;
  }

  record(kind, values = {}) {
    assert(this.events.length < 512, "Trial event limit reached");
    this.events.push({ kind, atMs: Math.round(this.now()), ...values });
  }

  receive(packet, binary = false) {
    if (this.state === "closed") return;
    if (binary) {
      assert(this.state === "ready", "Audio arrived before configuration");
      assert(Buffer.isBuffer(packet) && packet.length <= 2 * 1024 * 1024 && packet.length % 2 === 0, "Invalid PCM frame");
      assert(this.pendingAudio, "Audio frame has no response context");
      const run = this.pendingAudio; this.pendingAudio = undefined;
      if (run.stoppedAt !== undefined || run.terminal) { this.droppedAudioBytes += packet.length; return; }
      this.totalAudioBytes += packet.length;
      assert(this.totalAudioBytes <= 24 * 1024 * 1024, "Trial output audio limit reached");
      run.audioBytes += packet.length;
      return;
    }
    const event = typeof packet === "string" || Buffer.isBuffer(packet) ? JSON.parse(packet.toString()) : packet;
    assert(event && typeof event === "object" && typeof event.action === "string", "Invalid speech event");
    const data = event.data ?? {};
    if (event.action === "session_attached") {
      assert.equal(this.state, "attaching", "Unexpected session attachment");
      assert(id(data.session_id) && data.memory_scope === "session" && data.delegation === "none", "Unexpected remote memory or delegation");
      this.state = "configuring";
      this.send({ action: "session.update", session: { instructions: "这是全虚构语音对照。不要访问资料或执行任务；准确复述听到的姓名和最后时刻，不添加背景故事。", tools: [] } });
      this.send({ action: "media.configure", input_audio: { format: "pcm16", sample_rate: 16000 },
        output_audio: { format: "pcm16", sample_rate: 48000 }, playback: "server" });
      this.send({ action: "client_context.update", context: { time_zone: "Asia/Shanghai" } });
      return;
    }
    if (["session.updated", "media.configured", "client_context.updated"].includes(event.action)) {
      assert(this.state === "configuring" || this.state === "ready", "Unexpected configuration acknowledgement");
      assert.equal(data.error, "", "Remote configuration was rejected");
      if (event.action === "session.updated") assert(Array.isArray(data.tools) && data.tools.length === 0, "Unexpected speech tools");
      if (event.action === "media.configured") {
        assert(data.input_audio?.format === "pcm16" && data.input_audio.sample_rate === 16000 && data.input_audio.channels === 1,
          "Unsupported input audio format");
        assert(data.output_audio?.format === "pcm16" && data.output_audio.sample_rate === 48000 && data.output_audio.channels === 1 && data.playback === "server",
          "Unsupported output audio or playback mode");
      }
      if (event.action === "client_context.updated") assert.equal(data.accepted, true, "Timezone was rejected");
      this.acks.add(event.action);
      if (this.acks.size === 3 && this.state !== "ready") {
        this.state = "ready"; this.send({ action: "mic_state", enabled: true }); this.record("ready");
      }
      return;
    }
    if (event.action === "session.closing") { this.record("remote-closing"); this.state = "closed"; return; }
    if (event.action === "error") throw Error("Remote speech service returned an error");
    assert(this.state === "ready", "Speech event arrived before readiness");
    if (event.action === "input.transcript.done" || event.action === "input.transcript.revised") {
      assert(text(data.text), "Invalid input transcript");
      if (event.action.endsWith("revised")) assert(id(data.turn) && this.inputs.has(data.turn), "Transcript revision has no original turn");
      const key = id(data.turn) ? data.turn : "anonymous-" + (++this.anonymousInputs);
      assert(this.inputs.has(key) || this.inputs.size < 16, "Trial transcript limit reached");
      this.inputs.set(key, { turn: key, text: data.text, atMs: Math.round(this.now()), revised: event.action.endsWith("revised") });
      this.record(event.action, { turn: key }); return;
    }
    if (event.action.startsWith("output.transcript.")) {
      assert(text(data.text), "Invalid output transcript");
      if (data.run_id === undefined && data.turn_id === undefined) { this.unboundOutput = data.text; return; }
      const run = this.run(data);
      if (!run.terminal && run.stoppedAt === undefined) run.text = data.text;
      return;
    }
    if (event.action === "input.speech.started" || event.action === "input.speech.stopped") {
      // A VAD notification does not itself stop the model reply.
      this.record(event.action); return;
    }
    if (event.action === "response.audio.started") {
      const run = this.run(data); if (run.audioStartedAt === undefined) run.audioStartedAt = this.now();
      this.record(event.action, { runId: run.runId, turnId: run.turnId }); return;
    }
    if (event.action === "response.audio.context") {
      assert(!this.pendingAudio, "Unpaired prior audio context");
      assert(id(data.chunk_id), "Audio context has no chunk identity");
      this.pendingAudio = this.run(data); return;
    }
    if (event.action === "response.audio.done") { this.run(data).audioDone = true; return; }
    if (event.action === "response.audio.stop") {
      const run = this.run(data); run.stoppedAt ??= this.now();
      this.record(event.action, { runId: run.runId, turnId: run.turnId }); return;
    }
    if (event.action === "response.ended" || event.action === "response.interrupted") {
      if (event.action.endsWith("interrupted") && data.run_id === undefined && data.turn_id === undefined) {
        this.record("unbound-interruption"); return;
      }
      const run = this.run(data), status = event.action.endsWith("interrupted") ? "interrupted" : data.status;
      assert(["completed", "aborted", "failed", "interrupted"].includes(status), "Unknown response terminal state");
      if (status === "interrupted") {
        if (text(data.text)) run.interruptedText = data.text;
        if (typeof data.reason === "string") run.interruptionReason = data.reason.slice(0, 200);
      }
      if (!run.terminal) { run.terminal = status; run.endedAt = this.now(); this.record(event.action, { runId: run.runId, turnId: run.turnId, status }); }
      return;
    }
    if (event.action.startsWith("session.delegation.") || event.action === "response.function_call_arguments.done"
      || event.action === "response.done" && data.response?.output?.some(item => item.type === "function_call")) {
      throw Error("Speech comparison cannot execute tools or delegation");
    }
  }

  appendPcm(bytes) {
    assert.equal(this.state, "ready", "Speech configuration is not ready");
    assert(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 6400 && bytes.length % 2 === 0, "Invalid input PCM frame");
    this.send(bytes);
  }

  close() {
    if (this.state === "ready") this.send({ action: "mic_state", enabled: false });
    this.state = "closed"; this.pendingAudio = undefined;
  }

  snapshot() {
    return structuredClone({ state: this.state, inputs: [...this.inputs.values()], responses: [...this.runs.values()],
      events: [...this.events], unboundOutput: this.unboundOutput, totalAudioBytes: this.totalAudioBytes,
      droppedAudioBytes: this.droppedAudioBytes, playback: "server", physicalPlayback: false, tools: false });
  }
}
