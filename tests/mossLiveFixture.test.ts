import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
// @ts-expect-error Isolated Node comparison modules do not change runtime settings.
import { readMossTrialFixture, MOSS_TRIAL_ENDPOINT, MOSS_TRIAL_MODEL } from "../scripts/eval/moss-live-fixture.mjs";
// @ts-expect-error Isolated Node comparison entry point.
import { runMossTrial } from "../scripts/eval/moss-live-trial.mjs";
// @ts-expect-error Synthetic fixture preparation only.
import { prepareMossTrial } from "../scripts/eval/prepare-moss-trial.mjs";

let root: string, settingsFile: string;
const pcm = Buffer.alloc(3200), key = "synthetic-moss-credential";
const authorized = { endpoint: MOSS_TRIAL_ENDPOINT, model: MOSS_TRIAL_MODEL, apiKey: key,
  syntheticAudioDisclosureAccepted: true, plaintextCredentialStorageAccepted: true,
  authorizationOrigin: "wss://api.mosi.cn", maxSessionSeconds: 15 };
async function configure(values: object = {}) { await writeFile(settingsFile, JSON.stringify({ mossLiveTrial: { ...authorized, ...values } })); }
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "lifeops-moss-fictional-"))); settingsFile = join(root, ".obsidian/plugins/lifeops-assistant/data.json");
  await mkdir(join(root, ".obsidian/plugins/lifeops-assistant"), { recursive: true });
  await writeFile(join(root, "TEST_VAULT_ONLY.md"), "内容全部为虚构数据；合成语音，非真人录音。"); await configure();
  await writeFile(join(root, "sample.pcm"), pcm);
  await writeFile(join(root, "cases.json"), JSON.stringify({ fictional: true, provenance: "synthetic-speech", format: "pcm16-16000-mono",
    samples: [{ id: "sample", text: "虚构四点。", expectedAny: [["四点"]], replyMustNotInclude: ["三点"], pcmSha256: createHash("sha256").update(pcm).digest("hex") }] }));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

it.each([
  ["apiKey", "", "moss_api_key"],
  ["syntheticAudioDisclosureAccepted", false, "synthetic_audio_disclosure"],
  ["plaintextCredentialStorageAccepted", false, "credential_storage_consent"],
  ["authorizationOrigin", "wss://fiction.invalid", "moss_service_authorization"]
])("cannot create a connection without %s", async (field, value, missing) => {
  await configure({ [field as string]: value }); const createSocket = vi.fn();
  const fixture = await readMossTrialFixture(root, settingsFile);
  expect(fixture.preflight.ready).toBe(false); expect(fixture.preflight.missing).toContain(missing);
  expect(JSON.stringify(fixture.preflight)).not.toContain(key);
  await expect(runMossTrial(root, settingsFile, { createSocket })).rejects.toThrow("authorization"); expect(createSocket).not.toHaveBeenCalled();
});

it("refuses unmarked vaults, changed audio, symbolic links and other provider destinations before connecting", async () => {
  const createSocket = vi.fn();
  await writeFile(join(root, "TEST_VAULT_ONLY.md"), "No fictional-data attestation");
  await expect(runMossTrial(root, settingsFile, { createSocket })).rejects.toThrow("marker");
  await writeFile(join(root, "TEST_VAULT_ONLY.md"), "内容全部为虚构数据");
  await writeFile(join(root, "sample.pcm"), Buffer.alloc(3200, 1));
  await expect(runMossTrial(root, settingsFile, { createSocket })).rejects.toThrow("revision changed");
  await writeFile(join(root, "sample.pcm"), pcm); await configure({ endpoint: "wss://fiction.invalid/v1/realtime" });
  await expect(runMossTrial(root, settingsFile, { createSocket })).rejects.toThrow("official MOSS");
  await configure(); await writeFile(join(root, "other.pcm"), pcm); await rm(join(root, "sample.pcm"));
  await symlink(join(root, "other.pcm"), join(root, "sample.pcm"));
  await expect(runMossTrial(root, settingsFile, { createSocket })).rejects.toThrow("symbolic links");
  expect(createSocket).not.toHaveBeenCalled();
});

it("does not reuse another provider's configured key as a MOSS key", async () => {
  await writeFile(settingsFile, JSON.stringify({ realtimeVoice: { apiKey: key, dataDisclosureAccepted: true }, mossLiveTrial: { ...authorized, apiKey: "" } }));
  const createSocket = vi.fn(); await expect(runMossTrial(root, settingsFile, { createSocket })).rejects.toThrow("authorization");
  expect(createSocket).not.toHaveBeenCalled(); expect((await readMossTrialFixture(root, settingsFile)).preflight.missing).toContain("moss_api_key");
});

it("prepares a separate keyless fixture and refuses to overwrite it", async () => {
  const output = root + "-prepared", sourceSettings = await readFile(settingsFile);
  try {
    const prepared = await prepareMossTrial(root, output, true);
    expect(prepared).toMatchObject({ ready: false, providerRequests: 0, connectionsLimit: 1, sourceAudioUnchanged: true });
    const bytes = await readFile(prepared.configFile);
    expect(JSON.parse(bytes.toString()).mossLiveTrial).toMatchObject({ apiKey: "", syntheticAudioDisclosureAccepted: false, plaintextCredentialStorageAccepted: false });
    expect(bytes.toString()).not.toContain(key); expect(await readFile(settingsFile)).toEqual(sourceSettings);
    await expect(prepareMossTrial(root, output, true)).rejects.toThrow(); expect(await readFile(prepared.configFile)).toEqual(bytes);
    await expect(prepareMossTrial(root, join(root, "lifeops-moss-fictional-nested"), true)).rejects.toThrow("separate");
  } finally { await rm(output, { recursive: true, force: true }); }
});

it.each(["completed", "cancelled", "wrong-reply", "obsolete-reply"])("checks the actual bounded socket path over loopback: %s", async mode => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); if (typeof address === "string" || !address) throw Error("No loopback port");
  const commands: any[] = []; let connections = 0, receivedBinary = 0, credentialInHeader = false, capturedUrl = "";
  server.on("connection", (socket, request) => {
    connections++; credentialInHeader = request.headers.authorization === "Bearer " + key;
    const send = (action: string, data: object) => socket.send(JSON.stringify({ action, data }));
    socket.on("message", (raw, binary) => {
      if (binary) {
        if (++receivedBinary === 1) {
          const ids = { run_id: "fictional-run", turn_id: "fictional-turn" };
          send("input.transcript.done", { turn: "fictional-input", text: "虚构四点。" });
          const reply = mode === "wrong-reply" ? "虚构三点。" : mode === "obsolete-reply" ? "虚构四点、三点。" : "虚构四点。";
          send("output.transcript.done", { ...ids, text: reply + key });
          send("response.audio.context", { ...ids, chunk_id: "fictional-chunk" }); socket.send(Buffer.alloc(4));
          send("response.audio.done", ids); send("response.ended", { ...ids, status: "completed" });
        }
        return;
      }
      const message = JSON.parse(raw.toString()); commands.push(message);
      if (message.action === "attach_session") send("session_attached", { session_id: "fictional-session", memory_scope: "session", delegation: "none" });
      if (message.action === "session.update") send("session.updated", { error: "", tools: [] });
      if (message.action === "client_context.update") send("client_context.updated", { error: "", accepted: true });
      if (message.action === "media.configure") send("media.configured", { error: "", input_audio: { format: "pcm16", sample_rate: 16000, channels: 1 },
        output_audio: { format: "pcm16", sample_rate: 48000, channels: 1 }, playback: "server" });
    });
  });
  const configBefore = await readFile(settingsFile), controller = new AbortController();
  try {
    const observed = await runMossTrial(root, settingsFile, { signal: controller.signal, createSocket: (_url: string, options: any) => {
      capturedUrl = _url;
      const socket = new WebSocket("ws://127.0.0.1:" + address.port, options);
      if (mode === "cancelled") socket.once("open", () => setTimeout(() => controller.abort(), 25));
      return socket;
    } });
    expect(observed).toMatchObject({ passed: mode === "completed", connections: 1, automaticReconnects: 0, transport: "injected-test", modelQualityEvidence: false,
      microphone: false, physicalPlayback: false, toolWrites: false, resources: { socketClosed: true, deadlineTimerCleared: true } });
    expect(connections).toBe(1); expect(credentialInHeader).toBe(true);
    expect(new URL(capturedUrl).origin).toBe("wss://api.mosi.cn"); expect(new URL(capturedUrl).searchParams.get("model")).toBe(MOSS_TRIAL_MODEL);
    expect(capturedUrl).not.toContain(key);
    expect(commands.some(row => row.action?.startsWith("playback."))).toBe(false);
    if (mode !== "cancelled") {
      expect(observed.protocol.totalAudioBytes).toBe(4); expect(receivedBinary).toBe(21);
      expect(commands.filter(row => row.action === "mic_state")).toEqual([{ action: "mic_state", enabled: true }, { action: "mic_state", enabled: false }]);
      if (mode === "completed") expect(observed.protocol.responses[0].text).toBe("虚构四点。[redacted]");
      else { expect(observed.status).toBe("comparison-not-passed"); expect(observed.stages[0].checks[0].present).toBe(true); }
      if (mode === "wrong-reply") expect(observed.stages[0].replyChecks[0].present).toBe(false);
      if (mode === "obsolete-reply") expect(observed.stages[0].obsoleteReplyValues).toEqual(["三点"]);
    } else { expect(observed.status).toBe("incomplete"); expect(receivedBinary).toBeLessThan(21); }
    expect(await readFile(settingsFile)).toEqual(configBefore); expect(JSON.stringify(observed)).not.toContain(key);
  } finally { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 10_000);
