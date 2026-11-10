import { describe, expect, it, vi } from "vitest";
import {
  VoiceRuntimeJournal,
  VoiceSessionController,
  voiceRuntimeInvariantFailures,
  type VoiceRuntimeEvent,
  type VoiceRuntimeTurnPhase
} from "../src/voice/voiceRuntime";

function createHarness(): {
  controller: VoiceSessionController;
  journal: VoiceRuntimeJournal;
  advance: (ms: number) => void;
} {
  let now = 1_000;
  let id = 0;
  const journal = new VoiceRuntimeJournal();
  const controller = new VoiceSessionController({
    now: () => now,
    createId: (prefix) => `${prefix}-${++id}`,
    journal,
    provider: "qwen-test"
  });
  return {
    controller,
    journal,
    advance: (ms) => {
      now += ms;
    }
  };
}

function connect(controller: VoiceSessionController): void {
  controller.connect();
  controller.connected();
}

describe("VoiceSessionController runtime", () => {
  it("owns a strict session lifecycle", () => {
    const { controller } = createHarness();
    expect(controller.snapshot().sessionPhase).toBe("stopped");
    controller.connect();
    expect(controller.snapshot().sessionPhase).toBe("connecting");
    controller.connected();
    expect(controller.snapshot().sessionPhase).toBe("listening");
    controller.stop();
    expect(controller.snapshot().sessionPhase).toBe("stopped");
  });

  it("rejects illegal session transitions", () => {
    const { controller } = createHarness();
    expect(() => controller.connected()).toThrow("Illegal session transition");
    expect(() => controller.beginTurn()).toThrow("Cannot begin a turn");
  });

  it("creates one isolated abort controller per generation", () => {
    const { controller } = createHarness();
    connect(controller);
    const first = controller.beginTurn({ turnId: "turn-a" });
    expect(first.generation).toBe(1);
    expect(first.abortController.signal.aborted).toBe(false);

    controller.complete();
    expect(first.abortController.signal.aborted).toBe(true);
    const second = controller.beginTurn({ turnId: "turn-b" });
    expect(second.generation).toBe(2);
    expect(second.abortController).not.toBe(first.abortController);
    expect(second.abortController.signal.aborted).toBe(false);
  });

  it("does not allow two active turns", () => {
    const { controller } = createHarness();
    connect(controller);
    controller.beginTurn({ turnId: "turn-a" });
    expect(() => controller.beginTurn({ turnId: "turn-b" })).toThrow("still active");
  });

  it("enforces legal turn transitions", () => {
    const { controller } = createHarness();
    connect(controller);
    controller.beginTurn();
    controller.transitionTurn("endpointing");
    controller.transitionTurn("routing");
    controller.transitionTurn("generating");
    controller.transitionTurn("playing");
    expect(controller.complete()).toBe(true);
    expect(controller.snapshot().currentTurn?.phase).toBe("completed");
  });

  it("rejects illegal turn transitions", () => {
    const { controller } = createHarness();
    connect(controller);
    controller.beginTurn();
    expect(() => controller.transitionTurn("playing")).toThrow("Illegal turn transition");
  });

  it("settles a completed turn exactly once", () => {
    const { controller } = createHarness();
    connect(controller);
    controller.beginTurn();
    controller.transitionTurn("routing");
    expect(controller.complete("response_done")).toBe(true);
    expect(controller.complete("duplicate_done")).toBe(false);
    expect(controller.snapshot().currentTurn?.terminalReason).toBe("response_done");
    expect(controller.snapshot().currentTurn?.abortController.signal.reason).toBe("response_done");
  });

  it("settles an interruption without waiting for provider completion", () => {
    const { controller } = createHarness();
    connect(controller);
    controller.beginTurn();
    controller.transitionTurn("routing");
    controller.transitionTurn("generating");
    expect(controller.interrupt("barge_in_confirmed")).toBe(true);
    expect(controller.snapshot().currentTurn?.phase).toBe("interrupted");
    expect(controller.snapshot().sessionPhase).toBe("listening");
  });

  it("settles the current turn before entering recovery", () => {
    const { controller } = createHarness();
    connect(controller);
    controller.beginTurn();
    controller.transitionTurn("routing");
    controller.transitionTurn("generating");
    controller.reconnect("socket_closed");

    const snapshot = controller.snapshot();
    expect(snapshot.currentTurn?.phase).toBe("failed");
    expect(snapshot.currentTurn?.abortController.signal.aborted).toBe(true);
    expect(snapshot.sessionPhase).toBe("recovering");
    expect(snapshot.lastErrorCode).toBe("socket_closed");

    controller.recovered();
    expect(controller.snapshot().sessionPhase).toBe("listening");
  });

  it("binds provider and playback identities once", () => {
    const { controller } = createHarness();
    connect(controller);
    controller.beginTurn({ turnId: "turn-a" });
    controller.transitionTurn("routing");
    controller.bindInputItem("item-a");
    controller.bindResponse("response-a");
    controller.bindPlayback("playback-a");

    const current = controller.snapshot().currentTurn;
    expect(current?.inputItemId).toBe("item-a");
    expect(current?.responseId).toBe("response-a");
    expect(current?.playbackId).toBe("playback-a");
    expect(() => controller.bindResponse("response-b")).toThrow("already bound");
  });

  it("hands off a tool response within one turn while retiring its old response identity", () => {
    const { controller } = createHarness();
    connect(controller);
    const original = controller.beginTurn({ turnId: "tool-turn" });
    controller.transitionTurn("routing");
    controller.transitionTurn("generating");
    controller.bindResponse("tool-response");
    controller.markNativeAudioDone();
    const next = controller.continueToolResponse("tool-response", "tool-answer", ["query-call"]);
    expect(next).toMatchObject({
      turnId: original.turnId, generation: original.generation, responseId: "tool-answer",
      nativeAudioDone: false, modelDone: false, phase: "generating"
    });
    expect(next.abortController).toBe(original.abortController);
    expect(controller.accepts({ ...next, responseId: "tool-response" })).toBe(false);
    expect(controller.accepts({ ...next, responseId: "tool-answer" })).toBe(true);
    expect(() => controller.continueToolResponse("tool-answer", "tool-response", ["other-call"])).toThrow("Invalid tool");
    expect(() => controller.continueToolResponse("unrelated-response", "new-answer", ["other-call"])).toThrow("Invalid tool");
    expect(() => controller.continueToolResponse("tool-answer", "new-answer", [])).toThrow("Invalid tool");
    expect(() => controller.bindResponse("unrelated-response")).toThrow("already bound");
    controller.interrupt();
    expect(() => controller.continueToolResponse("tool-answer", "new-answer", ["query-call"])).toThrow("already interrupted");
  });

  it("tracks model, native audio, and playback completion independently", () => {
    const { controller } = createHarness();
    connect(controller);
    controller.beginTurn({ turnId: "turn-a" });
    controller.transitionTurn("routing");
    controller.transitionTurn("generating");
    controller.bindResponse("response-a");
    controller.bindPlayback("playback-a");
    controller.selectOutputOwner("native-e2e");

    controller.markNativeAudioStarted();
    controller.markNativeAudioDone();
    let current = controller.snapshot().currentTurn;
    expect(current).toMatchObject({
      nativeAudioStarted: true,
      nativeAudioDone: true,
      modelDone: false,
      playbackDrained: false,
      outputOwner: "native-e2e",
      phase: "generating"
    });

    controller.markModelDone();
    controller.transitionTurn("playing");
    controller.markPlaybackDrained();
    current = controller.snapshot().currentTurn;
    expect(current).toMatchObject({
      nativeAudioDone: true,
      modelDone: true,
      playbackDrained: true,
      phase: "playing"
    });
    expect(controller.complete("model_and_playback_done")).toBe(true);
  });

  it("resets playback completion when output falls back to a new owner", () => {
    const { controller } = createHarness();
    connect(controller);
    controller.beginTurn({ transcript: "你好" });
    controller.transitionTurn("routing");
    controller.transitionTurn("generating");
    controller.bindPlayback("playback-a");
    controller.selectOutputOwner("native-e2e");
    controller.markPlaybackDrained();

    controller.selectOutputOwner("fallback-tts");

    expect(controller.snapshot().currentTurn).toMatchObject({
      playbackId: "playback-a",
      outputOwner: "fallback-tts",
      playbackDrained: false
    });
  });

  it("accepts only callbacks belonging to the current turn identities", () => {
    const { controller } = createHarness();
    connect(controller);
    const turn = controller.beginTurn({ turnId: "turn-a" });
    controller.transitionTurn("routing");
    controller.bindResponse("response-a");
    controller.bindPlayback("playback-a");

    expect(controller.accepts({
      generation: turn.generation,
      turnId: turn.turnId,
      responseId: "response-a",
      playbackId: "playback-a"
    })).toBe(true);
    expect(controller.accepts({
      generation: turn.generation - 1,
      turnId: turn.turnId
    })).toBe(false);
    expect(controller.accepts({
      generation: turn.generation,
      turnId: turn.turnId,
      responseId: "response-old"
    })).toBe(false);

    controller.interrupt();
    expect(controller.accepts({
      generation: turn.generation,
      turnId: turn.turnId
    })).toBe(false);
  });

  it("rejects provider and playback callbacks until their identities are bound", () => {
    const { controller } = createHarness();
    connect(controller);
    const turn = controller.beginTurn({ turnId: "turn-a" });
    controller.transitionTurn("routing");

    expect(controller.accepts({
      generation: turn.generation,
      turnId: turn.turnId,
      responseId: "response-a"
    })).toBe(false);
    expect(controller.accepts({
      generation: turn.generation,
      turnId: turn.turnId,
      playbackId: "playback-a"
    })).toBe(false);
  });

  it("filters late callbacks after a new turn begins", () => {
    const { controller } = createHarness();
    connect(controller);
    const first = controller.beginTurn({ turnId: "turn-a" });
    controller.interrupt();
    const second = controller.beginTurn({ turnId: "turn-b" });

    expect(controller.accepts({ generation: first.generation, turnId: first.turnId })).toBe(false);
    expect(controller.accepts({ generation: second.generation, turnId: second.turnId })).toBe(true);
  });

  it("prioritizes interrupt input while preserving arrival order", () => {
    const { controller } = createHarness();
    connect(controller);
    controller.queueInput("普通一", { id: "normal-1" });
    controller.queueInput("普通二", { id: "normal-2" });
    controller.queueInput("打断一", { id: "interrupt-1", priority: "interrupt" });
    controller.queueInput("打断二", { id: "interrupt-2", priority: "interrupt" });

    expect(controller.dequeueInput()?.id).toBe("interrupt-1");
    expect(controller.dequeueInput()?.id).toBe("interrupt-2");
    expect(controller.dequeueInput()?.id).toBe("normal-1");
    expect(controller.dequeueInput()?.id).toBe("normal-2");
    expect(controller.dequeueInput()).toBeNull();
  });

  it("does not dequeue while a turn is active", () => {
    const { controller } = createHarness();
    connect(controller);
    controller.queueInput("稍后处理");
    controller.beginTurn();
    expect(controller.dequeueInput()).toBeNull();
    controller.fail();
    expect(controller.dequeueInput()?.text).toBe("稍后处理");
  });

  it("records only text length rather than transcript content", () => {
    const { controller, journal } = createHarness();
    connect(controller);
    controller.beginTurn({ transcript: "这是一段不应写入事件日志的私密日记" });
    controller.updateAssistantText("这也是不能写入事件日志的回复");
    const serialized = JSON.stringify(journal.snapshot());
    expect(serialized).not.toContain("私密日记");
    expect(serialized).not.toContain("不能写入事件日志");
    expect(journal.snapshot().some((event) => event.textLength && event.textLength > 0)).toBe(true);
  });

  it("caps and sanitizes journal entries before using an external sink", () => {
    const sink = vi.fn<(event: VoiceRuntimeEvent) => void>();
    const journal = new VoiceRuntimeJournal(2, sink);
    journal.record({
      timestamp: Number.NaN,
      sessionId: "session secret value",
      generation: -3,
      eventType: "event with spaces",
      stateBefore: "a state",
      stateAfter: "b state",
      errorCode: "socket failed: private message"
    });
    journal.record({
      timestamp: 2,
      sessionId: "session-2",
      generation: 2,
      eventType: "two",
      stateBefore: "a",
      stateAfter: "b"
    });
    journal.record({
      timestamp: 3,
      sessionId: "session-3",
      generation: 3,
      eventType: "three",
      stateBefore: "a",
      stateAfter: "b"
    });

    expect(journal.snapshot()).toHaveLength(2);
    expect(sink).toHaveBeenCalledTimes(3);
    const first = sink.mock.calls[0][0];
    expect(first.timestamp).toBe(0);
    expect(first.generation).toBe(0);
    expect(first.eventType).toBe("event_with_spaces");
    expect(first.errorCode).toBe("socket_failed:_private_message");
  });

  it("marks first native audio once and records its latency", () => {
    const { controller, journal, advance } = createHarness();
    connect(controller);
    controller.beginTurn();
    controller.transitionTurn("routing");
    controller.transitionTurn("generating");
    advance(320);
    controller.markNativeAudioStarted();
    controller.markNativeAudioStarted();

    const audioEvents = journal.snapshot().filter((event) => event.eventType === "turn.native_audio.started");
    expect(audioEvents).toHaveLength(1);
    expect(audioEvents[0].latencyMs).toBe(320);
  });

  it("clears queued input and aborts an active turn when stopped", () => {
    const { controller } = createHarness();
    connect(controller);
    controller.queueInput("排队内容");
    const turn = controller.beginTurn();
    controller.stop();

    expect(turn.abortController.signal.aborted).toBe(true);
    expect(controller.snapshot().sessionPhase).toBe("stopped");
    expect(controller.snapshot().inputQueue).toHaveLength(0);
  });

  it("preserves runtime invariants across 1000 seeded mixed event sequences", () => {
    let seed = 0x5eed1234;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };

    for (let sequence = 0; sequence < 1_000; sequence += 1) {
      const { controller } = createHarness();
      connect(controller);

      for (let step = 0; step < 24; step += 1) {
        const snapshot = controller.snapshot();
        const turn = snapshot.currentTurn;
        const active = Boolean(turn && !["completed", "interrupted", "failed"].includes(turn.phase));
        const operation = Math.floor(random() * 10);

        if (!active) {
          if (snapshot.sessionPhase === "recovering") controller.recovered();
          if (controller.snapshot().sessionPhase === "listening" && operation < 7) {
            controller.beginTurn({
              turnId: `sequence-${sequence}-step-${step}`,
              transcript: `text-${sequence}-${step}`
            });
          } else {
            controller.queueInput(`queued-${sequence}-${step}`, {
              priority: operation % 2 ? "normal" : "interrupt"
            });
            controller.dequeueInput();
          }
        } else if (turn) {
          if (operation === 0) {
            controller.interrupt("seeded_interrupt");
          } else if (operation === 1) {
            controller.fail("seeded_failure");
          } else if (operation === 2) {
            controller.complete("seeded_complete");
          } else if (operation === 3) {
            controller.reconnect("seeded_disconnect");
          } else if (operation === 4) {
            controller.updateAssistantText(`reply-${sequence}-${step}`);
          } else if (operation === 5) {
            controller.markModelDone();
          } else if (operation === 6) {
            controller.markPlaybackDrained();
          } else if (operation === 7) {
            expect(controller.accepts({
              generation: Math.max(0, turn.generation - 1),
              turnId: `stale-${turn.turnId}`
            })).toBe(false);
          } else {
            const legalNext = ({
              capturing: "endpointing",
              endpointing: "routing",
              routing: "generating",
              generating: "synthesizing",
              synthesizing: "playing",
              playing: "completed"
            } as Partial<Record<VoiceRuntimeTurnPhase, VoiceRuntimeTurnPhase>>)[turn.phase] as
              | "endpointing"
              | "routing"
              | "generating"
              | "synthesizing"
              | "playing"
              | "completed"
              | undefined;
            if (legalNext === "completed") controller.complete("seeded_playback_complete");
            else if (legalNext) controller.transitionTurn(legalNext);
          }
        }

        expect(voiceRuntimeInvariantFailures(controller.snapshot())).toEqual([]);
      }

      const final = controller.snapshot();
      if (final.currentTurn && !["completed", "interrupted", "failed"].includes(final.currentTurn.phase)) {
        controller.interrupt("seeded_cleanup");
      }
      if (controller.snapshot().sessionPhase === "recovering") controller.recovered();
      controller.stop();
      expect(controller.snapshot().sessionPhase).toBe("stopped");
      expect(voiceRuntimeInvariantFailures(controller.snapshot())).toEqual([]);
    }
  });

  it("reports no invariant failures for every terminal outcome", () => {
    for (const outcome of ["completed", "interrupted", "failed"] as const) {
      const { controller } = createHarness();
      connect(controller);
      controller.beginTurn();
      controller.transitionTurn("routing");
      if (outcome === "completed") controller.complete();
      if (outcome === "interrupted") controller.interrupt();
      if (outcome === "failed") controller.fail();
      expect(voiceRuntimeInvariantFailures(controller.snapshot())).toEqual([]);
    }
  });
});
