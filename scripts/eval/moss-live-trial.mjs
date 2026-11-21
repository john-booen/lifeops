import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import WebSocket from "ws";
import { MossTrialProtocol } from "./moss-live-protocol.mjs";
import { readMossTrialFixture } from "./moss-live-fixture.mjs";
const officialSocket = (url, options) => new WebSocket(url, options);

function protect(value, secret) {
  if (typeof value === "string") return secret ? value.split(secret).join("[redacted]") : value;
  if (Array.isArray(value)) return value.map(item => protect(item, secret));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, protect(item, secret)]));
  return value;
}

function recognized(sample, inputs) {
  const observed = inputs.map(row => row.text).join(" ").normalize("NFKC").replace(/\s/gu, "");
  return sample.expectedAny.map(alternatives => ({ alternatives, present: alternatives.some(value => observed.includes(value.normalize("NFKC").replace(/\s/gu, ""))) }));
}

/** One bounded connection. All credentials, provenance and PCM hashes are checked before creation. */
export async function runMossTrial(fixture, configFile, {
  createSocket = officialSocket, sleep = pause, signal
} = {}) {
  const prepared = await readMossTrialFixture(fixture, configFile), { config, samples } = prepared;
  assert(prepared.preflight.ready, "Dedicated MOSS credentials and authorization are required");
  const started = performance.now(), now = () => performance.now() - started;
  const result = { ...prepared.preflight, startedAt: new Date().toISOString(), connections: 0, stages: [],
    serviceAttachedAtMs: null, passed: false, microphone: false, physicalPlayback: false,
    privateRecordsRead: false, toolWrites: false, automaticReconnects: 0, semanticBargeInVerified: false, lifeOpsToolExecutionVerified: false,
    transport: createSocket === officialSocket ? "official-provider" : "injected-test",
    limitation: "Synthetic recognition and server-playback event comparison; not a real room, speaker, microphone or LifeOps task execution acceptance." };
  let socket, fatal, shuttingDown = false;
  const protocol = new MossTrialProtocol(value => {
    assert.equal(socket.readyState, WebSocket.OPEN, "Speech connection is not open");
    socket.send(Buffer.isBuffer(value) ? value : JSON.stringify(value));
  }, now);
  const interrupt = () => { fatal ??= Error("Trial cancelled"); socket?.terminate(); };
  if (signal?.aborted) throw Error("Trial cancelled before connection");
  signal?.addEventListener("abort", interrupt, { once: true });
  const timer = setTimeout(() => { fatal ??= Error("Trial session time limit reached"); socket?.terminate(); }, config.maxSessionSeconds * 1000);
  async function waitFor(predicate, timeoutMs, message) {
    const until = performance.now() + timeoutMs;
    for (;;) {
      if (fatal) throw fatal;
      if (signal?.aborted) throw Error("Trial cancelled");
      if (predicate()) return;
      if (performance.now() >= until) throw Error(message);
      await sleep(25);
    }
  }
  try {
    const url = new URL(config.endpoint); url.searchParams.set("model", config.model);
    socket = createSocket(url.toString(), { headers: { Authorization: "Bearer " + config.apiKey }, handshakeTimeout: 10_000, maxPayload: 2 * 1024 * 1024 });
    result.connections++;
    socket.on("open", () => { try { protocol.opened(); } catch (error) { fatal ??= error; } });
    socket.on("message", (packet, binary) => {
      try {
        protocol.receive(packet, binary);
        if (result.serviceAttachedAtMs === null && protocol.state !== "new" && protocol.state !== "attaching") result.serviceAttachedAtMs = Math.round(now());
        if (protocol.state === "closed" && !shuttingDown) fatal ??= Error("Remote speech session is closing");
      } catch (error) { fatal ??= error; }
    });
    socket.on("error", () => { if (!shuttingDown) fatal ??= Error("Speech connection failed"); });
    socket.on("close", () => { if (!shuttingDown) fatal ??= Error("Speech connection closed before the comparison completed"); });
    await waitFor(() => protocol.state === "ready", 10_000, "Speech configuration timed out");
    for (const [index, sample] of samples.entries()) {
      const priorReplies = [...protocol.runs.values()];
      let overlapped;
      if (sample.after === "reply_audio") {
        await waitFor(() => priorReplies.some(row => row.audioStartedAt !== undefined && !row.terminal && row.stoppedAt === undefined),
          15_000, "No active reply audio was available for the interruption sample");
        overlapped = priorReplies.find(row => row.audioStartedAt !== undefined && !row.terminal && row.stoppedAt === undefined);
      }
      const began = now(), eventIndex = protocol.events.length, oldRunKeys = new Set(protocol.runs.keys());
      const stage = { id: sample.id, after: sample.after ?? "previous_reply", beganAtMs: Math.round(began),
        pcmSha256: sample.pcmSha256, inputSeconds: sample.seconds, checks: [], priorReply: overlapped ? { runId: overlapped.runId, turnId: overlapped.turnId } : undefined };
      result.stages.push(stage);
      for (let offset = 0; offset < sample.pcm.length; offset += 3200) {
        if (fatal) throw fatal;
        if (signal?.aborted) throw Error("Trial cancelled");
        const frame = sample.pcm.subarray(offset, offset + 3200); protocol.appendPcm(frame);
        await sleep(frame.length / 32);
      }
      // Continue silence through the same input path, rather than inventing an undocumented commit message.
      for (let i = 0; i < 20; i++) { if (fatal) throw fatal; if (signal?.aborted) throw Error("Trial cancelled"); protocol.appendPcm(Buffer.alloc(3200)); await sleep(100); }
      await waitFor(() => protocol.events.slice(eventIndex).some(row => row.kind === "input.transcript.done" || row.kind === "input.transcript.revised"),
        15_000, "No final input transcription was returned");
      const willOverlapNext = samples[index + 1]?.after === "reply_audio";
      if (!willOverlapNext) await waitFor(() => [...protocol.runs].some(([key, row]) => !oldRunKeys.has(key) && row.terminal),
        15_000, "No final response state was returned");
      const snapshot = protocol.snapshot(), inputs = snapshot.inputs.filter(row => row.atMs >= began);
      stage.transcripts = inputs;
      stage.checks = recognized(sample, inputs);
      const replies = [...protocol.runs].filter(([key]) => !oldRunKeys.has(key)).map(([, row]) => ({ ...row }));
      stage.replies = replies;
      stage.replyChecks = willOverlapNext ? [] : recognized({ expectedAny: sample.replyExpectedAny }, replies);
      stage.obsoleteReplyValues = sample.replyMustNotInclude.filter(value => replies.some(row => row.text.includes(value)));
      stage.awaitsInterruption = willOverlapNext;
      stage.endedAtMs = Math.round(now());
      if (overlapped) stage.priorReplyStopped = overlapped.stoppedAt !== undefined && overlapped.terminal === "interrupted";
    }
    if (fatal) throw fatal;
    const observed = protocol.snapshot();
    result.passed = result.stages.every(row => row.checks.length > 0 && row.checks.every(check => check.present)
      && (row.awaitsInterruption || row.replyChecks.length > 0 && row.replyChecks.every(check => check.present)) && row.obsoleteReplyValues.length === 0
      && (row.after !== "reply_audio" || row.priorReplyStopped === true))
      && observed.responses.length > 0 && observed.responses.every(row => ["completed", "interrupted"].includes(row.terminal));
    result.status = result.passed ? "comparison-passed" : "comparison-not-passed";
  } catch (error) {
    result.status = "incomplete"; result.error = error instanceof Error ? error.message : "Speech comparison failed";
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", interrupt); shuttingDown = true;
    try { protocol.close(); } catch { /* The transport may already have closed. */ }
    if (socket) await new Promise(resolve => {
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(forced); resolve(); } };
      const forced = setTimeout(() => { socket.terminate(); finish(); }, 1000);
      socket.once("close", finish);
      if (socket.readyState === WebSocket.CLOSED) finish();
      else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else socket.close(1000, "Bounded fictional comparison complete");
    });
    result.resources = { socketClosed: !socket || socket.readyState === WebSocket.CLOSED, deadlineTimerCleared: true, noMicrophoneOrPlayerCreated: true };
    result.protocol = protocol.snapshot(); result.totalMs = Math.round(now()); result.completedAt = new Date().toISOString();
    if (!result.resources.socketClosed) { result.passed = false; result.status = "incomplete"; }
  }
  result.modelQualityEvidence = result.transport === "official-provider" && result.status === "comparison-passed";
  return protect(result, config.apiKey);
}

async function main() {
  const args = process.argv.slice(2), mode = args[0];
  assert(args.length === 5 && ["--preflight", "--run"].includes(mode) && args[1] === "--fixture" && args[3] === "--config",
    "Use --preflight|--run --fixture <absolute fictional vault> --config <absolute plugin data.json>");
  if (mode === "--preflight") {
    const { preflight } = await readMossTrialFixture(args[2], args[4]);
    console.log(JSON.stringify(preflight)); process.exitCode = preflight.ready ? 0 : 2; return;
  }
  const controller = new AbortController(), stop = () => controller.abort(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    const result = await runMossTrial(args[2], args[4], { signal: controller.signal });
    const name = "moss-trial-" + new Date().toISOString().replace(/[:.]/gu, "-") + ".json";
    await writeFile(join(args[2], name), JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ status: result.status, passed: result.passed, connections: result.connections, totalMs: result.totalMs,
      resultFile: name, microphone: false, physicalPlayback: false, toolWrites: false })); process.exitCode = result.passed ? 0 : 1;
  } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(() => {
  console.error("MOSS fictional comparison did not start or finish. Check the fictional fixture, dedicated configuration and authorization; no configuration content was printed.");
  process.exitCode = 1;
});
