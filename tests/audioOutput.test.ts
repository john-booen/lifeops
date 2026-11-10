import { describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import {
  AudioOutputActor,
  lifeOpsPcmOutputWorkletSource,
  resamplePcm16ToFloat32,
  type AudioOutputCommand,
  type AudioOutputContextLike,
  type AudioOutputEvent,
  type AudioOutputNodeLike,
  type AudioOutputWorkletMessage
} from "../src/voice/audioOutput";

class FakePort {
  onmessage: ((event: MessageEvent<AudioOutputWorkletMessage>) => void) | null = null;
  readonly sent: AudioOutputCommand[] = [];

  postMessage(message: AudioOutputCommand): void {
    this.sent.push(message);
  }

  get workletPlaybackId(): string {
    const start = this.sent.slice().reverse().find((command: AudioOutputCommand) => command.type === "start");
    if (!start) throw Error("No worklet playback has started");
    return start.playbackId;
  }

  emit(message: AudioOutputWorkletMessage): void {
    this.onmessage?.({ data: message } as MessageEvent<AudioOutputWorkletMessage>);
  }
}

class FakeNode implements AudioOutputNodeLike {
  readonly port = new FakePort();
  connected = false;
  disconnected = false;

  connect(): void {
    this.connected = true;
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeContext implements AudioOutputContextLike {
  readonly sampleRate = 48_000;
  state: AudioContextState = "running";
  readonly destination = {} as AudioDestinationNode;
  readonly audioWorklet = {
    addModule: vi.fn(async (): Promise<void> => undefined)
  };
  readonly resume = vi.fn(async () => {
    this.state = "running";
  });
  readonly close = vi.fn(async () => {
    this.state = "closed";
  });
}

function createHarness(options: {
  firstAudioTimeoutMs?: number;
  drainTimeoutMs?: number;
  suspended?: boolean;
  createContext?: () => AudioOutputContextLike;
} = {}) {
  let now = 1_000;
  let nextTimer = 1;
  const timers = new Map<number, () => void>();
  const timerDelays = new Map<number, number>();
  const events: AudioOutputEvent[] = [];
  const context = new FakeContext();
  if (options.suspended) context.state = "suspended";
  const node = new FakeNode();
  const revoke = vi.fn();
  const actor = new AudioOutputActor({
    createContext: options.createContext ?? (() => context),
    createNode: () => node,
    createModuleUrl: () => "blob:audio-worklet",
    revokeModuleUrl: revoke,
    now: () => now,
    setTimer: (callback, delayMs) => {
      const id = nextTimer++;
      timers.set(id, callback);
      timerDelays.set(id, delayMs);
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id);
      timerDelays.delete(id);
    },
    firstAudioTimeoutMs: options.firstAudioTimeoutMs ?? 500,
    drainTimeoutMs: options.drainTimeoutMs ?? 900,
    onEvent: (event) => events.push(event)
  });
  return {
    actor,
    context,
    node,
    events,
    revoke,
    timerDelays: () => Array.from(timerDelays.values()),
    timerCallbacks: () => Array.from(timers.values()),
    advance: (ms: number) => {
      now += ms;
    },
    fireTimers: () => {
      const pending = Array.from(timers.values());
      timers.clear();
      timerDelays.clear();
      pending.forEach((callback) => callback());
    }
  };
}

describe("AudioOutputActor", () => {
  it("cannot reconnect a worklet whose initialization completes after close", async () => {
    const harness = createHarness();
    let release!: () => void;
    harness.context.audioWorklet.addModule.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const pending = harness.actor.start("old-playback", "native-e2e");
    const rejected = expect(pending).rejects.toThrow("closed_while_preparing");
    await harness.actor.close();
    release(); await rejected;
    expect(harness.node.connected).toBe(false);
    expect(harness.node.port.sent.filter(command => command.type === "start")).toEqual([]);
    expect(harness.actor.snapshot()?.status).toBe("cancelled");
    expect(harness.timerDelays()).toEqual([]);
  });

  it("does not revive a cancelled playback when shared preparation later finishes", async () => {
    const harness = createHarness();
    let release!: () => void;
    harness.context.audioWorklet.addModule.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const pending = harness.actor.start("cancelled-playback", "native-e2e");
    const rejected = expect(pending).rejects.toThrow("stopped or replaced");
    harness.actor.cancel("cancelled-playback", "user stopped");
    release(); await rejected;
    expect(harness.node.port.sent.filter(command => command.type === "start")).toEqual([]);
    expect(harness.actor.snapshot()?.status).toBe("cancelled");
    await harness.actor.start("explicit-new-playback", "fallback-tts");
    expect(harness.actor.snapshot()?.status).toBe("ready");
  });

  it("keeps a same-ID fallback playable when cancelled native preparation later resolves", async () => {
    const harness = createHarness();
    let release!: () => void;
    harness.context.audioWorklet.addModule.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const native = harness.actor.start("shared-playback", "native-e2e");
    const rejectedNative = expect(native).rejects.toThrow("stopped or replaced");
    harness.actor.cancel("shared-playback", "host proposal rejected");
    const fallback = harness.actor.start("shared-playback", "fallback-tts");
    release();
    await rejectedNative;
    await fallback;

    expect(harness.actor.snapshot()).toMatchObject({ playbackId: "shared-playback", owner: "fallback-tts", status: "ready" });
    expect(harness.events.filter(event => event.type === "failed")).toEqual([]);
    expect(harness.node.port.sent.filter(command => command.type === "start")).toEqual([
      { type: "start", playbackId: harness.node.port.workletPlaybackId }
    ]);
    expect(harness.actor.appendPcm16("shared-playback", new Int16Array([1000, -1000]), 24_000)).toBe(true);
    harness.node.port.emit({ type: "started", playbackId: harness.node.port.workletPlaybackId });
    expect(harness.actor.snapshot()).toMatchObject({ owner: "fallback-tts", status: "playing" });
  });

  it("keeps a same-ID fallback playable when old native initialization rejects after replacement", async () => {
    const oldContext = new FakeContext(), replacementContext = new FakeContext();
    const contexts = [oldContext, replacementContext];
    const harness = createHarness({ createContext: () => contexts.shift()! });
    let rejectOld!: (error: Error) => void;
    oldContext.audioWorklet.addModule.mockImplementation(() => new Promise<void>((_resolve, reject) => { rejectOld = reject; }));
    const native = harness.actor.start("shared-playback", "native-e2e");
    const rejectedNative = expect(native).rejects.toThrow("old native initialization failed");
    harness.actor.cancel("shared-playback", "host proposal rejected");
    await harness.actor.close();
    await harness.actor.start("shared-playback", "fallback-tts");
    const replacement = harness.actor.snapshot();

    rejectOld(new Error("old native initialization failed"));
    await rejectedNative;
    expect(harness.actor.snapshot()).toEqual(replacement);
    expect(harness.events.filter(event => event.owner === "fallback-tts" && ["failed", "cancelled"].includes(event.type))).toEqual([]);
    expect(harness.actor.appendPcm16("shared-playback", new Int16Array([1000, -1000]), 24_000)).toBe(true);
    harness.node.port.emit({ type: "started", playbackId: harness.node.port.workletPlaybackId });
    expect(harness.actor.snapshot()).toMatchObject({ owner: "fallback-tts", status: "playing" });
  });

  it.each(["resolves", "rejects"])("keeps a same-ID fallback playable when a retired native resume later %s", async kind => {
    const harness = createHarness();
    await harness.actor.start("initial-playback", "native-e2e");
    harness.actor.cancel("initial-playback");
    harness.context.state = "suspended";
    let release!: () => void, rejectOld!: (error: Error) => void;
    harness.context.resume.mockImplementationOnce(() => new Promise<void>((resolve, reject) => { release = resolve; rejectOld = reject; }));
    const native = harness.actor.start("shared-playback", "native-e2e");
    const rejectedNative = expect(native).rejects.toThrow(/stopped or replaced|audio_context_suspended/);
    harness.actor.cancel("shared-playback", "host proposal rejected");
    await harness.actor.start("shared-playback", "fallback-tts");
    const replacement = harness.actor.snapshot(), events = harness.events.slice(), timers = harness.timerDelays();

    if (kind === "rejects") rejectOld(new Error("retired native resume failed"));
    else release();
    await rejectedNative;
    expect(harness.actor.snapshot()).toEqual(replacement);
    expect(harness.events).toEqual(events);
    expect(harness.timerDelays()).toEqual(timers);
    expect(harness.actor.appendPcm16("shared-playback", new Int16Array([1000, -1000]), 24_000)).toBe(true);
    harness.node.port.emit({ type: "started", playbackId: harness.node.port.workletPlaybackId });
    expect(harness.actor.snapshot()).toMatchObject({ playbackId: "shared-playback", owner: "fallback-tts", status: "playing" });
  });

  it("still fails the current playback when its own context resume rejects", async () => {
    const harness = createHarness();
    await harness.actor.start("initial-playback", "native-e2e");
    harness.actor.cancel("initial-playback");
    harness.context.state = "suspended";
    harness.context.resume.mockRejectedValueOnce(Error("current context resume failed"));
    await expect(harness.actor.start("shared-playback", "native-e2e")).rejects.toThrow("audio_context_suspended");
    expect(harness.actor.snapshot()).toMatchObject({ playbackId: "shared-playback", owner: "native-e2e", status: "failed" });
    expect(harness.events.at(-1)).toMatchObject({ type: "failed", playbackId: "shared-playback", owner: "native-e2e", errorCode: "audio_context_resume_failed" });
  });

  it.each(["ready", "playing"].flatMap(state =>
    ["started", "drained", "cancelled", "failed"].map(type => ({ state, type }))
  ))("ignores old native $type after same-ID fallback is $state", async ({ state, type }) => {
    const harness = createHarness();
    await harness.actor.start("shared-playback", "native-e2e");
    const nativeWorkletId = harness.node.port.workletPlaybackId;
    harness.actor.cancel("shared-playback", "host proposal rejected");
    await harness.actor.start("shared-playback", "fallback-tts");
    const fallbackWorkletId = harness.node.port.workletPlaybackId;
    expect(harness.actor.appendPcm16("shared-playback", new Int16Array([1000, -1000]), 24_000)).toBe(true);
    if (state === "playing") harness.node.port.emit({ type: "started", playbackId: fallbackWorkletId });
    const replacement = harness.actor.snapshot(), events = harness.events.slice(), commands = harness.node.port.sent.slice();
    const timers = harness.timerDelays();

    harness.node.port.emit({ type, playbackId: nativeWorkletId, errorCode: "late native failure" } as AudioOutputWorkletMessage);
    expect(harness.actor.snapshot()).toEqual(replacement);
    expect(harness.events).toEqual(events);
    expect(harness.node.port.sent).toEqual(commands);
    expect(harness.timerDelays()).toEqual(timers);
    expect(fallbackWorkletId).not.toBe(nativeWorkletId);

    harness.node.port.emit({ type: "started", playbackId: fallbackWorkletId });
    expect(harness.actor.snapshot()).toMatchObject({ playbackId: "shared-playback", owner: "fallback-tts", status: "playing" });
    expect(harness.actor.finish("shared-playback")).toBe(true);
    harness.node.port.emit({ type: "drained", playbackId: fallbackWorkletId });
    expect(harness.actor.snapshot()).toMatchObject({ playbackId: "shared-playback", owner: "fallback-tts", status: "completed" });
    expect(harness.events.at(-1)).toMatchObject({ type: "drained", playbackId: "shared-playback", owner: "fallback-tts" });
  });

  it("sends every command with the current worklet identity while keeping the public playback ID", async () => {
    const harness = createHarness();
    for (const owner of ["native-e2e", "fallback-tts"] as const) {
      const before = harness.node.port.sent.length;
      await harness.actor.start("shared-playback", owner);
      const workletId = harness.node.port.workletPlaybackId;
      harness.actor.appendPcm16("shared-playback", new Int16Array([1000, -1000]), 24_000);
      harness.actor.duck("shared-playback");
      harness.actor.restore("shared-playback");
      harness.actor.finish("shared-playback");
      harness.actor.cancel("shared-playback");
      const commands = harness.node.port.sent.slice(before);
      expect(commands.map(command => command.type)).toEqual(["start", "chunk", "gain", "gain", "finish", "cancel"]);
      expect(commands.every(command => command.playbackId === workletId)).toBe(true);
      expect(workletId).not.toBe("shared-playback");
      expect(harness.actor.snapshot()).toMatchObject({ playbackId: "shared-playback", owner, status: "cancelled" });
      expect(harness.events.at(-1)).toMatchObject({ type: "cancelled", playbackId: "shared-playback", owner });
    }
  });

  it("ignores old worklet callbacks after close and supports a new explicit playback", async () => {
    const harness = createHarness();
    await harness.actor.start("old-playback", "native-e2e");
    const oldWorkletId = harness.node.port.workletPlaybackId;
    const lateEvent = harness.node.port.onmessage!;
    await harness.actor.close();
    const before = harness.events.length;
    lateEvent({ data: { type: "started", playbackId: oldWorkletId } } as MessageEvent<AudioOutputWorkletMessage>);
    expect(harness.events).toHaveLength(before);
    await harness.actor.start("new-playback", "native-e2e");
    expect(harness.actor.snapshot()).toMatchObject({ playbackId: "new-playback", status: "ready" });
  });

  it("creates one persistent worklet context across playbacks", async () => {
    const harness = createHarness();
    await harness.actor.start("playback-a", "native-e2e");
    harness.node.port.emit({ type: "started", playbackId: harness.node.port.workletPlaybackId });
    harness.actor.finish("playback-a");
    harness.node.port.emit({ type: "drained", playbackId: harness.node.port.workletPlaybackId });

    await harness.actor.start("playback-b", "fallback-tts");
    expect(harness.context.audioWorklet.addModule).toHaveBeenCalledTimes(1);
    expect(harness.node.connected).toBe(true);
  });

  it("resumes a suspended context before preparing playback", async () => {
    const harness = createHarness({ suspended: true });
    await harness.actor.start("playback-a", "native-e2e");
    expect(harness.context.resume).toHaveBeenCalledTimes(1);
    expect(harness.actor.snapshot()?.status).toBe("ready");
  });

  it("tracks first audible output separately from queued chunks", async () => {
    const harness = createHarness();
    await harness.actor.start("playback-a", "native-e2e");
    const appended = harness.actor.appendPcm16(
      "playback-a",
      new Int16Array([0, 1000, -1000]),
      24_000
    );
    expect(appended).toBe(true);
    expect(harness.actor.snapshot()?.status).toBe("ready");
    expect(harness.actor.snapshot()?.chunksQueued).toBe(1);

    harness.advance(140);
    harness.node.port.emit({ type: "started", playbackId: harness.node.port.workletPlaybackId });
    expect(harness.actor.snapshot()?.status).toBe("playing");
    expect(harness.events.at(-1)).toMatchObject({
      type: "started",
      playbackId: "playback-a",
      latencyMs: 140
    });
  });

  it("does not complete until the worklet reports a drained buffer", async () => {
    const harness = createHarness();
    await harness.actor.start("playback-a", "native-e2e");
    harness.node.port.emit({ type: "started", playbackId: harness.node.port.workletPlaybackId });
    expect(harness.actor.finish("playback-a")).toBe(true);
    expect(harness.actor.snapshot()?.status).toBe("draining");

    harness.advance(300);
    harness.node.port.emit({ type: "drained", playbackId: harness.node.port.workletPlaybackId });
    expect(harness.actor.snapshot()?.status).toBe("completed");
    expect(harness.events.at(-1)?.type).toBe("drained");
  });

  it("emits a drain timeout without falsely completing the playback", async () => {
    const harness = createHarness({ drainTimeoutMs: 900 });
    await harness.actor.start("playback-a", "native-e2e");
    harness.node.port.emit({ type: "started", playbackId: harness.node.port.workletPlaybackId });
    harness.actor.finish("playback-a");
    harness.advance(900);
    harness.fireTimers();

    expect(harness.events.at(-1)).toMatchObject({
      type: "drain-timeout",
      playbackId: "playback-a",
      errorCode: "audio_drain_timeout"
    });
    expect(harness.actor.snapshot()?.status).toBe("draining");
  });

  it("extends the drain watchdog for queued audio longer than the fixed timeout", async () => {
    const harness = createHarness({ drainTimeoutMs: 30_000 });
    await harness.actor.start("playback-a", "native-e2e");
    harness.node.port.emit({ type: "started", playbackId: harness.node.port.workletPlaybackId });
    expect(harness.actor.appendPcm16(
      "playback-a",
      new Int16Array(960_000),
      24_000
    )).toBe(true);

    harness.advance(2_000);
    harness.actor.finish("playback-a");

    expect(harness.timerDelays()).toEqual([43_000]);
  });

  it("emits a first-audio timeout without falsely completing the playback", async () => {
    const harness = createHarness({ firstAudioTimeoutMs: 500 });
    await harness.actor.start("playback-a", "native-e2e");
    harness.advance(500);
    harness.fireTimers();

    expect(harness.events.at(-1)).toMatchObject({
      type: "first-audio-timeout",
      playbackId: "playback-a",
      errorCode: "audio_first_frame_timeout"
    });
    expect(harness.actor.snapshot()?.status).toBe("ready");
  });

  it("ignores stale audio and worklet events from old playbacks", async () => {
    const harness = createHarness();
    await harness.actor.start("playback-a", "native-e2e");
    const oldWorkletId = harness.node.port.workletPlaybackId;
    await harness.actor.start("playback-b", "fallback-tts");

    expect(harness.actor.appendPcm16("playback-a", new Int16Array([1]), 24_000)).toBe(false);
    harness.node.port.emit({ type: "started", playbackId: oldWorkletId });
    expect(harness.actor.snapshot()?.playbackId).toBe("playback-b");
    expect(harness.actor.snapshot()?.status).toBe("ready");
  });

  it("cancels the old playback before a replacement becomes active", async () => {
    const harness = createHarness();
    await harness.actor.start("playback-a", "native-e2e");
    await harness.actor.start("playback-b", "fallback-tts");

    expect(harness.events.some((event) => (
      event.type === "cancelled"
      && event.playbackId === "playback-a"
      && event.errorCode === "replaced_by_new_playback"
    ))).toBe(true);
  });

  it("ducks suspected interruptions and restores false alarms without cancelling", async () => {
    const harness = createHarness();
    await harness.actor.start("playback-a", "native-e2e");

    expect(harness.actor.duck("playback-a", 0.18, 50)).toBe(true);
    expect(harness.actor.snapshot()).toMatchObject({
      playbackId: "playback-a",
      gain: 0.18,
      status: "ready"
    });
    expect(harness.node.port.sent.at(-1)).toEqual({
      type: "gain",
      playbackId: harness.node.port.workletPlaybackId,
      gain: 0.18,
      rampFrames: 2400
    });
    expect(harness.events.at(-1)?.type).toBe("ducked");

    expect(harness.actor.restore("playback-a", 120)).toBe(true);
    expect(harness.actor.snapshot()?.gain).toBe(1);
    expect(harness.node.port.sent.at(-1)).toEqual({
      type: "gain",
      playbackId: harness.node.port.workletPlaybackId,
      gain: 1,
      rampFrames: 5760
    });
    expect(harness.events.at(-1)?.type).toBe("restored");
    expect(harness.actor.snapshot()?.status).toBe("ready");
  });

  it("settles cancellation once", async () => {
    const harness = createHarness();
    await harness.actor.start("playback-a", "native-e2e");
    expect(harness.actor.cancel("playback-a", "barge_in")).toBe(true);
    expect(harness.actor.cancel("playback-a", "duplicate")).toBe(false);
    expect(harness.actor.snapshot()?.status).toBe("cancelled");
  });

  it("settles a worklet failure with an explicit error code", async () => {
    const harness = createHarness();
    await harness.actor.start("playback-a", "native-e2e");
    harness.node.port.emit({
      type: "failed",
      playbackId: harness.node.port.workletPlaybackId,
      errorCode: "processor_crashed"
    });
    expect(harness.actor.snapshot()?.status).toBe("failed");
    expect(harness.events.at(-1)).toMatchObject({
      type: "failed",
      errorCode: "processor_crashed"
    });
  });

  it("closes the persistent context and revokes the worklet URL", async () => {
    const harness = createHarness();
    await harness.actor.start("playback-a", "native-e2e");
    await harness.actor.close();

    expect(harness.context.close).toHaveBeenCalledTimes(1);
    expect(harness.node.disconnected).toBe(true);
    expect(harness.revoke).toHaveBeenCalledWith("blob:audio-worklet");
  });
});

describe("AudioOutputActor idle output context", () => {
  it.each(["completed", "cancelled", "failed"] as const)("waits for the reported device tail before parking a %s output", async terminal => {
    const h = createHarness(), suspend = vi.fn(async () => { h.context.state = "suspended"; });
    Object.assign(h.context, { suspend, baseLatency: 0.2, outputLatency: 0.3 });
    await h.actor.start("idle-playback", "native-e2e");
    h.actor.appendPcm16("idle-playback", new Int16Array(64), 16_000);
    h.node.port.emit({ type: "started", playbackId: h.node.port.workletPlaybackId });
    if (terminal === "completed") {
      h.actor.finish("idle-playback");
      h.node.port.emit({ type: "drained", playbackId: h.node.port.workletPlaybackId });
    } else if (terminal === "cancelled") h.actor.cancel("idle-playback");
    else h.actor.fail("idle-playback", "synthetic-failure");
    expect(h.actor.snapshot()?.status).toBe(terminal);
    expect(h.timerDelays()).toEqual([550]);
    expect(suspend).not.toHaveBeenCalled(); expect(h.context.state).toBe("running");
    h.fireTimers(); await Promise.resolve();
    expect(suspend).toHaveBeenCalledOnce(); expect(h.context.state).toBe("suspended");
    expect(h.actor.snapshot()?.status).toBe(terminal);
    await h.actor.close(); expect(h.timerDelays()).toEqual([]);
  });

  it("uses a conservative default tail and ignores a cleared timer and late drain after same-ID replacement", async () => {
    const h = createHarness(), suspend = vi.fn(async () => { h.context.state = "suspended"; });
    Object.assign(h.context, { suspend, baseLatency: NaN, outputLatency: -1 });
    await h.actor.start("same-id", "native-e2e"); const oldId = h.node.port.workletPlaybackId;
    h.actor.cancel("same-id"); expect(h.timerDelays()).toEqual([250]);
    const oldIdle = h.timerCallbacks()[0];
    await h.actor.start("same-id", "fallback-tts");
    oldIdle(); h.node.port.emit({ type: "drained", playbackId: oldId }); await Promise.resolve();
    expect(suspend).not.toHaveBeenCalled(); expect(h.actor.snapshot()).toMatchObject({ status: "ready", owner: "fallback-tts" });
    expect(h.timerDelays()).toEqual([500]);
    await h.actor.close(); expect(h.timerDelays()).toEqual([]);
  });

  it("waits for an already requested suspend before resuming even while context still says running", async () => {
    const h = createHarness(); let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const suspend = vi.fn(() => pending.then(() => { h.context.state = "suspended"; }));
    Object.assign(h.context, { suspend });
    await h.actor.start("same-id", "native-e2e"); h.actor.cancel("same-id"); h.fireTimers(); await Promise.resolve();
    expect(suspend).toHaveBeenCalledOnce(); expect(h.context.state).toBe("running");
    let settled = false; const next = h.actor.start("same-id", "fallback-tts").then(value => { settled = true; return value; });
    await Promise.resolve(); expect(settled).toBe(false); expect(h.context.resume).not.toHaveBeenCalled();
    release(); await next;
    expect(h.context.resume).toHaveBeenCalledOnce(); expect(h.context.state).toBe("running");
    expect(h.actor.snapshot()).toMatchObject({ owner: "fallback-tts", status: "ready" });
    await h.actor.close(); expect(h.timerDelays()).toEqual([]);
  });

  it.each(["resolve", "reject"] as const)("keeps a new context's pending suspend owned when a closed generation later %s", async outcome => {
    const oldContext = new FakeContext(), newContext = new FakeContext(), contexts = [oldContext, newContext];
    let resolveOld!: () => void, rejectOld!: (error: Error) => void, resolveNew!: () => void;
    const oldPending = new Promise<void>((resolve, reject) => { resolveOld = resolve; rejectOld = reject; });
    const newPending = new Promise<void>(resolve => { resolveNew = resolve; });
    const oldSuspend = vi.fn(() => oldPending), newSuspend = vi.fn(() => newPending.then(() => { newContext.state = "suspended"; }));
    Object.assign(oldContext, { suspend: oldSuspend }); Object.assign(newContext, { suspend: newSuspend });
    const h = createHarness({ createContext: () => contexts.shift()! });
    await h.actor.start("same-id", "native-e2e"); h.actor.cancel("same-id"); h.fireTimers(); await Promise.resolve();
    expect(oldSuspend).toHaveBeenCalledOnce(); await h.actor.close(); expect(oldContext.close).toHaveBeenCalledOnce();
    await h.actor.start("same-id", "fallback-tts"); h.actor.cancel("same-id"); h.fireTimers(); await Promise.resolve();
    expect(newSuspend).toHaveBeenCalledOnce();
    if (outcome === "resolve") resolveOld(); else rejectOld(Error("retired suspend rejected"));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    let settled = false; const next = h.actor.start("same-id", "native-e2e").then(value => { settled = true; return value; });
    await Promise.resolve(); expect(settled).toBe(false); expect(newContext.resume).not.toHaveBeenCalled();
    resolveNew(); await next;
    expect(newContext.resume).toHaveBeenCalledOnce(); expect(newContext.state).toBe("running");
    expect(h.actor.snapshot()).toMatchObject({ status: "ready", owner: "native-e2e" });
    await h.actor.close(); expect(h.timerDelays()).toEqual([]);
  });

  it("keeps playback usable after idle suspend rejects without changing terminal events", async () => {
    const h = createHarness(), suspend = vi.fn(() => Promise.reject(Error("suspend unavailable")));
    Object.assign(h.context, { suspend });
    await h.actor.start("old", "native-e2e"); h.actor.cancel("old"); h.fireTimers(); await Promise.resolve();
    expect(suspend).toHaveBeenCalledOnce(); await h.actor.start("new", "native-e2e");
    expect(h.actor.snapshot()).toMatchObject({ playbackId: "new", status: "ready" });
    expect(h.events.filter(x => x.type === "failed")).toEqual([]);
    expect(h.context.state).toBe("running"); await h.actor.close();
  });

  it("keeps custom contexts without suspend on the original path", async () => {
    const h = createHarness();
    await h.actor.start("old", "native-e2e"); h.actor.cancel("old");
    expect(h.timerDelays()).toEqual([]); expect(h.context.state).toBe("running");
    await h.actor.start("new", "native-e2e"); expect(h.context.resume).not.toHaveBeenCalled(); await h.actor.close();
  });

  it.each(["start", "close"] as const)("does not leave an old idle timer after drained event synchronously reenters %s", async action => {
    const h = createHarness(), suspend = vi.fn(async () => { h.context.state = "suspended"; });
    Object.assign(h.context, { suspend });
    let reentry: Promise<unknown> | undefined;
    const actor = h.actor as unknown as { onEvent: (event: AudioOutputEvent) => void }, original = actor.onEvent;
    actor.onEvent = event => { original(event); if (event.type === "drained") reentry = action === "start" ? h.actor.start("same-id", "fallback-tts") : h.actor.close(); };
    await h.actor.start("same-id", "native-e2e"); h.actor.finish("same-id");
    h.node.port.emit({ type: "drained", playbackId: h.node.port.workletPlaybackId }); await reentry;
    expect(suspend).not.toHaveBeenCalled();
    if (action === "start") { expect(h.actor.snapshot()).toMatchObject({ status: "ready", owner: "fallback-tts" }); expect(h.timerDelays()).toEqual([500]); await h.actor.close(); }
    else expect(h.context.state).toBe("closed");
    expect(h.timerDelays()).toEqual([]);
  });
});

describe("PCM output helpers", () => {
  function attachProcessor(harness: ReturnType<typeof createHarness>) {
    const replies: AudioOutputWorkletMessage[] = [];
    let Processor!: new () => {
      queue: Float32Array[];
      current: Float32Array | null;
      handleCommand(command: AudioOutputCommand): void;
      process(inputs: unknown[], outputs: Float32Array[][]): boolean;
    };
    runInNewContext(lifeOpsPcmOutputWorkletSource(), {
      AudioWorkletProcessor: class { port = { onmessage: null, postMessage: (message: AudioOutputWorkletMessage) => replies.push(message) }; },
      registerProcessor: (_name: string, type: typeof Processor) => { Processor = type; }
    });
    const processor = new Processor();
    let commandIndex = 0;
    const pump = () => {
      while (commandIndex < harness.node.port.sent.length) processor.handleCommand(harness.node.port.sent[commandIndex++]);
      while (replies.length) harness.node.port.emit(replies.shift()!);
    };
    return { processor, pump, render() {
      pump();
      const output = new Float32Array(128);
      processor.process([], [[output]]);
      pump();
      return output;
    } };
  }

  it("announces only cues that are actually rendered and drops queued cues when cancelled", async () => {
    const harness = createHarness(), worklet = attachProcessor(harness);
    await harness.actor.start("speaker-phrases", "fallback-tts");
    harness.actor.appendPcm16("speaker-phrases", new Int16Array(128).fill(8192), 48_000, "first");
    harness.actor.appendPcm16("speaker-phrases", new Int16Array(128).fill(8192), 48_000, "second");
    expect(harness.events.some(event => event.type === "cue")).toBe(false);
    worklet.render();
    expect(harness.events.filter(event => event.type === "cue")).toMatchObject([{ cue: "first" }]);
    harness.actor.cancel("speaker-phrases");
    worklet.render();
    expect(harness.events.filter(event => event.type === "cue")).toHaveLength(1);
  });

  it("fires an end cue only after the last sample ahead of it is rendered", async () => {
    const harness = createHarness(), worklet = attachProcessor(harness);
    await harness.actor.start("speaker-end", "fallback-tts");
    harness.actor.appendPcm16("speaker-end", new Int16Array(128).fill(8192), 48_000, "first-start");
    harness.actor.appendCue("speaker-end", "first-end");
    worklet.render();
    expect(harness.events.filter(event => event.type === "cue").map(event => event.cue)).toEqual(["first-start"]);
    worklet.render();
    expect(harness.events.filter(event => event.type === "cue").map(event => event.cue)).toEqual(["first-start", "first-end"]);
  });

  it.each([false, true])("silences queued real-worklet samples when failure becomes terminal (host cancel=%s)", async hostCancel => {
    const harness = createHarness(), worklet = attachProcessor(harness);
    let hostCancelResult: boolean | undefined;
    const actor = harness.actor as unknown as { onEvent: (event: AudioOutputEvent) => void };
    const originalEvent = actor.onEvent;
    actor.onEvent = event => {
      originalEvent(event);
      if (event.type === "failed" && hostCancel) hostCancelResult = harness.actor.cancel(event.playbackId, "host failure cleanup");
    };
    await harness.actor.start("failed-playback", "native-e2e");
    harness.actor.appendPcm16("failed-playback", new Int16Array(2048).fill(8192), 48_000);
    expect(Array.from(worklet.render()).every(sample => sample === 0.25)).toBe(true);
    expect(harness.actor.fail("failed-playback", "audio_chunk_enqueue_failed")).toBe(true);
    expect(Array.from(worklet.render()).every(sample => sample === 0)).toBe(true);
    expect(worklet.processor.queue).toHaveLength(0);
    expect(worklet.processor.current).toBeNull();
    expect(harness.actor.cancel("failed-playback", "late cleanup")).toBe(false);
    expect(Array.from(worklet.render()).every(sample => sample === 0)).toBe(true);
    expect(harness.actor.snapshot()?.status).toBe("failed");
    expect(harness.events.filter(event => event.type === "failed")).toHaveLength(1);
    expect(harness.events.filter(event => event.type === "cancelled")).toHaveLength(0);
    if (hostCancel) expect(hostCancelResult).toBe(false);
    expect(harness.timerDelays()).toHaveLength(0);
  });

  it("keeps same-ID replacement audio audible while retired failure commands and replies remain ignored", async () => {
    const harness = createHarness(), worklet = attachProcessor(harness);
    await harness.actor.start("same-playback", "native-e2e");
    harness.actor.appendPcm16("same-playback", new Int16Array(2048).fill(8192), 48_000);
    worklet.render();
    const oldId = harness.node.port.workletPlaybackId;
    harness.actor.fail("same-playback", "audio_chunk_enqueue_failed");
    expect(Array.from(worklet.render()).every(sample => sample === 0)).toBe(true);
    const retiredCommands = harness.node.port.sent.filter(command => command.type !== "start");
    await harness.actor.start("same-playback", "fallback-tts");
    worklet.pump();
    for (const command of retiredCommands) worklet.processor.handleCommand(command);
    for (const type of ["cancelled", "failed", "drained"] as const) harness.node.port.emit({ type, playbackId: oldId });
    harness.actor.appendPcm16("same-playback", new Int16Array(128).fill(4096), 48_000);
    harness.actor.finish("same-playback");
    expect(Array.from(worklet.render()).every(sample => sample === 0.125)).toBe(true);
    worklet.render();
    expect(harness.actor.snapshot()).toMatchObject({ owner: "fallback-tts", status: "completed" });
    expect(harness.events.filter(event => event.type === "failed")).toHaveLength(1);
    expect(harness.events.filter(event => event.type === "drained" && event.owner === "fallback-tts")).toHaveLength(1);
  });

  it("round-trips current private IDs through the real worklet while ignoring retired commands and replies", async () => {
    const harness = createHarness(), replies: AudioOutputWorkletMessage[] = [];
    let Processor!: new () => {
      handleCommand(command: AudioOutputCommand): void;
      process(inputs: unknown[], outputs: Float32Array[][]): boolean;
    };
    runInNewContext(lifeOpsPcmOutputWorkletSource(), {
      AudioWorkletProcessor: class { port = { onmessage: null, postMessage: (message: AudioOutputWorkletMessage) => replies.push(message) }; },
      registerProcessor: (_name: string, type: typeof Processor) => { Processor = type; }
    });
    const processor = new Processor();
    await harness.actor.start("shared-playback", "native-e2e");
    harness.actor.appendPcm16("shared-playback", new Int16Array([-32768, -32768, -32768, -32768]), 48_000);
    harness.actor.duck("shared-playback", 0.1, 0);
    harness.actor.finish("shared-playback");
    for (const command of harness.node.port.sent) processor.handleCommand(command);
    processor.process([], [[new Float32Array(8)]]);
    harness.actor.cancel("shared-playback", "host proposal rejected");
    processor.handleCommand(harness.node.port.sent.at(-1)!);
    const retiredCommands = harness.node.port.sent.filter(command => command.type !== "start");
    const retiredReplies = replies.splice(0);
    expect(retiredReplies.map(reply => reply.type)).toEqual(["started", "drained", "cancelled"]);

    await harness.actor.start("shared-playback", "fallback-tts");
    processor.handleCommand(harness.node.port.sent.at(-1)!);
    const replacement = harness.actor.snapshot(), events = harness.events.slice();
    for (const command of retiredCommands) processor.handleCommand(command);
    for (const reply of retiredReplies) harness.node.port.emit(reply);
    expect(harness.actor.snapshot()).toEqual(replacement);
    expect(harness.events).toEqual(events);
    harness.actor.appendPcm16("shared-playback", new Int16Array([8192, 8192, 8192, 8192]), 48_000);
    processor.handleCommand(harness.node.port.sent.at(-1)!);
    harness.actor.finish("shared-playback");
    processor.handleCommand(harness.node.port.sent.at(-1)!);
    const output = new Float32Array(8);
    processor.process([], [[output]]);
    expect(Array.from(output)).toEqual([0.25, 0.25, 0.25, 0.25, 0, 0, 0, 0]);
    expect(replies.map(reply => reply.type)).toEqual(["started", "drained"]);
    for (const reply of replies) harness.node.port.emit(reply);
    expect(harness.actor.snapshot()).toMatchObject({ playbackId: "shared-playback", owner: "fallback-tts", status: "completed" });
    expect(harness.events.at(-1)).toMatchObject({ type: "drained", playbackId: "shared-playback", owner: "fallback-tts" });
  });

  it("converts PCM16 to normalized Float32 at the same sample rate", () => {
    const output = resamplePcm16ToFloat32(
      new Int16Array([-32768, 0, 32767]),
      24_000,
      24_000
    );
    expect(Array.from(output)).toEqual([-1, 0, 32767 / 32768]);
  });

  it("resamples PCM to the audio context sample rate", () => {
    const output = resamplePcm16ToFloat32(
      new Int16Array([0, 32767, 0, -32768]),
      24_000,
      48_000
    );
    expect(output).toHaveLength(8);
    expect(output[0]).toBe(0);
    expect(output[2]).toBeCloseTo(32767 / 32768, 5);
  });

  it("defines a worklet that uses a queue and explicit drain events", () => {
    const source = lifeOpsPcmOutputWorkletSource();
    expect(source).toContain('registerProcessor("lifeops-pcm-output"');
    expect(source).toContain("this.queue");
    expect(source).toContain('type: "started"');
    expect(source).toContain('type: "drained"');
    expect(source).toContain('type: "cancelled"');
  });
});
