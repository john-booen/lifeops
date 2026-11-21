import { expect, it } from "vitest";
// @ts-expect-error An isolated Node protocol client, not part of the plugin.
import { MossTrialProtocol } from "../scripts/eval/moss-live-protocol.mjs";

function setup() {
  const sent: any[] = []; let clock = 0;
  const client = new MossTrialProtocol((value: unknown) => sent.push(value), () => ++clock);
  return { client, sent };
}
function event(client: any, action: string, data: object = {}) { client.receive({ action, data }); }
function attached(client: any) { client.opened(); event(client, "session_attached", { session_id: "fictional-session", memory_scope: "session", delegation: "none" }); }
function ready(client: any) {
  attached(client);
  event(client, "media.configured", { error: "", input_audio: { format: "pcm16", sample_rate: 16000, channels: 1 },
    output_audio: { format: "pcm16", sample_rate: 48000, channels: 1 }, playback: "server" });
  event(client, "session.updated", { error: "", tools: [] });
  event(client, "client_context.updated", { error: "", accepted: true });
}
const ids = { run_id: "fictional-reply", turn_id: "fictional-turn" };

it("waits for actual session, audio and timezone acknowledgements before sending PCM", () => {
  const { client, sent } = setup(); attached(client);
  expect(sent[0]).toEqual({ action: "attach_session", memory_scope: "session", delegation: { type: "none" } });
  expect(sent.some(x => x.action === "mic_state")).toBe(false);
  expect(() => client.appendPcm(Buffer.alloc(3200))).toThrow("not ready");
  event(client, "session.updated", { error: "", tools: [] });
  event(client, "client_context.updated", { error: "", accepted: true });
  expect(sent.some(x => x.action === "mic_state")).toBe(false);
  event(client, "media.configured", { error: "", input_audio: { format: "pcm16", sample_rate: 16000, channels: 1 }, output_audio: { format: "pcm16", sample_rate: 48000, channels: 1 }, playback: "server" });
  client.appendPcm(Buffer.alloc(3200)); expect(Buffer.isBuffer(sent.at(-1))).toBe(true);
  event(client, "session.updated", { error: "", tools: [] });
  expect(sent.filter(x => x.action === "mic_state")).toEqual([{ action: "mic_state", enabled: true }]);
});

it.each(["user", "server"])("rejects unrequested remote memory or delegation: %s", value => {
  const { client } = setup(); client.opened();
  expect(() => event(client, "session_attached", { session_id: "fictional-session", memory_scope: value === "user" ? value : "session", delegation: value === "server" ? value : "none" })).toThrow("memory or delegation");
});

it.each(["session.updated", "media.configured", "client_context.updated"])("does not enable input after rejected %s", action => {
  const { client, sent } = setup(); attached(client);
  expect(() => event(client, action, { error: "fictional-rejection" })).toThrow("configuration");
  expect(sent.some(x => x.action === "mic_state")).toBe(false);
});

it("revises a confirmed input in place and keeps full transcript snapshots separate", () => {
  const { client } = setup(); ready(client);
  event(client, "input.transcript.done", { turn: "one", text: "虚构四点。" });
  const original = client.snapshot();
  event(client, "input.transcript.revised", { turn: "one", previous: "虚构四点。", text: "虚构四点十五。" });
  event(client, "output.transcript.updated", { ...ids, text: "虚构四点" });
  event(client, "output.transcript.done", { ...ids, text: "虚构四点十五。" });
  expect(client.snapshot().inputs).toHaveLength(1); expect(client.snapshot().inputs[0].text).toBe("虚构四点十五。");
  expect(client.snapshot().responses[0].text).toBe("虚构四点十五。");
  expect(original.inputs[0].text).toBe("虚构四点。");
  expect(() => event(client, "input.transcript.revised", { turn: "missing", text: "虚构另一次" })).toThrow("no original turn");
});

it("does not treat speech activity or wire audio completion as an interruption or actual playback", () => {
  const { client, sent } = setup(); ready(client);
  event(client, "response.audio.started", ids); event(client, "input.speech.started");
  event(client, "response.audio.context", { ...ids, chunk_id: "one" }); client.receive(Buffer.alloc(9600), true);
  event(client, "response.audio.done", ids);
  expect(client.snapshot().responses[0]).toMatchObject({ audioDone: true, audioBytes: 9600 });
  expect(client.snapshot().responses[0].terminal).toBeUndefined(); expect(client.snapshot().responses[0].stoppedAt).toBeUndefined();
  expect(sent.some(x => x.action?.startsWith("playback."))).toBe(false);
});

it("uses response identities to discard late stopped audio while allowing another response", () => {
  const { client } = setup(); ready(client);
  event(client, "response.audio.context", { ...ids, chunk_id: "late" });
  event(client, "response.audio.stop", { ...ids, reason: "future-unknown-reason" });
  client.receive(Buffer.alloc(100), true);
  event(client, "response.interrupted", { ...ids, text: "虚构旧回复", reason: "fictional-semantic-stop" });
  event(client, "output.transcript.updated", { ...ids, text: "虚构迟到旧回复" });
  const next = { run_id: "fictional-next", turn_id: "fictional-next-turn" };
  event(client, "response.audio.context", { ...next, chunk_id: "new" }); client.receive(Buffer.alloc(200), true);
  event(client, "output.transcript.done", { ...next, text: "虚构新回复。" }); event(client, "response.ended", { ...next, status: "completed" });
  expect(client.snapshot()).toMatchObject({ droppedAudioBytes: 100, totalAudioBytes: 200 });
  expect(client.snapshot().responses[0]).toMatchObject({ terminal: "interrupted", audioBytes: 0, text: "", interruptedText: "虚构旧回复", interruptionReason: "fictional-semantic-stop" });
  expect(client.snapshot().responses[1]).toMatchObject({ terminal: "completed", text: "虚构新回复。" });
});

it("refuses unpaired audio and tool or hosted-task execution in a speech-only comparison", () => {
  for (const action of ["response.function_call_arguments.done", "session.delegation.created"]) {
    const { client } = setup(); ready(client); expect(() => event(client, action, { name: "delete_task" })).toThrow("cannot execute");
  }
  const { client } = setup(); ready(client); expect(() => client.receive(Buffer.alloc(2), true)).toThrow("no response context");
  expect(() => event(client, "response.done", { response: { output: [{ type: "function_call" }] } })).toThrow("cannot execute");
});

it("closes once without reconnecting and ignores late packets", () => {
  const { client, sent } = setup(); ready(client); client.close(); client.close();
  event(client, "input.transcript.done", { text: "虚构迟到" }); client.receive(Buffer.alloc(2), true);
  expect(client.snapshot().inputs).toEqual([]);
  expect(sent.filter(x => x.action === "attach_session")).toHaveLength(1);
  expect(sent.filter(x => x.action === "mic_state" && !x.enabled)).toHaveLength(1);
});
