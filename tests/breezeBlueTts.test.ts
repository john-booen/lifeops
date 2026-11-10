import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BreezeBlueTtsClient } from "../src/breezeBlueTts";
import type { BailianRealtimeTtsClient } from "../src/bailianTtsRealtime";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { setProviderEgressSink } from "../src/privacy";

const { execFile, request } = vi.hoisted(() => ({ execFile: vi.fn(), request: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile }));
vi.mock("node:https", () => ({ request }));

const fakeKey = "brz_" + "A".repeat(24);
const fixture = "虚构的回复，今天的实验完成了。";
function network(status = 200, mime = "audio/pcm", complete = true) {
  const res = Object.assign(new PassThrough(), { statusCode: status, complete, headers: { "content-type": mime } });
  const req = Object.assign(new EventEmitter(), { end: vi.fn(() => callback(res)) });
  let signal!: AbortSignal;
  let callback!: (response: typeof res) => void;
  request.mockImplementationOnce((_url, options, onResponse) => {
    signal = options.signal; callback = onResponse;
    signal.addEventListener("abort", () => {
      res.destroy();
      req.emit("error", signal.reason);
    }, { once: true });
    return req;
  });
  return { res, req, signal: () => signal };
}
function client() {
  const local = { speak: vi.fn(async () => {}) };
  const callbacks = { onOpen: vi.fn(), onAudioDelta: vi.fn(), onResponseDone: vi.fn(), onProviderRun: vi.fn() };
  const engine = new BreezeBlueTtsClient(DEFAULT_SETTINGS.realtimeVoice, callbacks, undefined, local as unknown as BailianRealtimeTtsClient);
  return { engine, local, ...callbacks };
}
beforeEach(() => {
  vi.clearAllMocks();
  execFile.mockImplementation((_path, _args, _options, done) => done(null, fakeKey + ":fixture_voice"));
  setProviderEgressSink(null);
});

describe("BreezeBlue playback", () => {
  it("sends only the reply to the fixed endpoint and emits aligned PCM before completion", async () => {
    const audit = vi.fn();
    setProviderEgressSink(audit);
    const { res, req } = network();
    const c = client();
    try {
      const work = c.engine.speak(fixture);
      await vi.waitFor(() => expect(req.end).toHaveBeenCalledOnce());
      res.write(Buffer.from([1]));
      expect(c.onAudioDelta).not.toHaveBeenCalled();
      res.write(Buffer.from([2, 3]));
      await vi.waitFor(() => expect(c.onAudioDelta).toHaveBeenCalledExactlyOnceWith("AQI=", 24_000));
      expect(c.onResponseDone).not.toHaveBeenCalled();
      res.end(Buffer.from([4]));
      await work;
      const [url, opts] = request.mock.calls[0];
      expect(String(url)).toBe("https://api.breeze.blue/v1/text-to-speech/fixture_voice/stream?output_format=pcm&enable_logging=false");
      expect(opts.headers["xi-api-key"]).toBe(fakeKey);
      expect(JSON.parse(String(req.end.mock.calls[0]))).toMatchObject({ text: fixture, model_id: "breeze-tts-2", language_code: "zh" });
      expect(c.onAudioDelta).toHaveBeenLastCalledWith("AwQ=", 24_000);
      expect(c.onResponseDone).toHaveBeenCalledOnce();
      expect(c.local.speak).not.toHaveBeenCalled();
      expect(audit).toHaveBeenCalledWith(expect.objectContaining({ provider: "breeze-blue", sourceCount: 0, contentLogged: false }));
      expect(JSON.stringify([audit.mock.calls, c.onProviderRun.mock.calls])).not.toContain(fakeKey);
      expect(JSON.stringify([audit.mock.calls, c.onProviderRun.mock.calls])).not.toContain(fixture);
      expect(c.onProviderRun).toHaveBeenCalledWith(expect.objectContaining({ run: expect.objectContaining({ status: "success", actualProvider: "breeze-blue" }) }));
    } finally { setProviderEgressSink(null); }
  });

  it("rejects redirects and falls back locally before emitting any online audio", async () => {
    const { res } = network(302);
    const c = client();
    await c.engine.speak(fixture);
    expect(request).toHaveBeenCalledOnce();
    expect(res.destroyed).toBe(true);
    expect(c.local.speak).toHaveBeenCalledExactlyOnceWith(fixture, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(c.onAudioDelta).not.toHaveBeenCalled();
  });

  it("does not replay a reply when the stream ends mid-sample after starting", async () => {
    const { res, req } = network();
    const c = client();
    const work = expect(c.engine.speak(fixture)).rejects.toMatchObject({ code: "invalid_response" });
    await vi.waitFor(() => expect(req.end).toHaveBeenCalledOnce());
    res.end(Buffer.from([1, 2, 3]));
    await work;
    expect(c.onAudioDelta).toHaveBeenCalledOnce();
    expect(c.onResponseDone).not.toHaveBeenCalled();
    expect(c.local.speak).not.toHaveBeenCalled();
  });

  it("closes the request on interruption, drops late audio and allows the next reply to finish", async () => {
    const first = network(), c = client();
    const cancelled = expect(c.engine.speak(fixture)).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(first.req.end).toHaveBeenCalledOnce());
    first.res.write(Buffer.from([1, 2]));
    await vi.waitFor(() => expect(c.onAudioDelta).toHaveBeenCalledOnce());
    c.engine.cancel();
    first.res.end(Buffer.from([3, 4]));
    await cancelled;
    expect(first.signal().aborted).toBe(true);
    expect(c.local.speak).not.toHaveBeenCalled();
    const second = network(), next = c.engine.speak("下一句虚构回复");
    await vi.waitFor(() => expect(second.req.end).toHaveBeenCalledOnce());
    second.res.end(Buffer.from([5, 6]));
    await next;
    expect(c.onAudioDelta.mock.calls).toEqual([["AQI=", 24_000], ["BQY=", 24_000]]);
    expect(c.onResponseDone).toHaveBeenCalledOnce();
  });

  it("does not touch the keychain or network for oversized or already cancelled input", async () => {
    const c = client();
    await expect(c.engine.speak("虚".repeat(121))).rejects.toMatchObject({ code: "configuration" });
    await expect(c.engine.speak(fixture, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(execFile).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(c.local.speak).not.toHaveBeenCalled();
  });
});
