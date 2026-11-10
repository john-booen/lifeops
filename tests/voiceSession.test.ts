import { describe, expect, it } from "vitest";
import {
  appendTurnText,
  beginNewTurn,
  canTransition,
  createVoiceSession,
  dequeueInput,
  enqueueInput,
  finalizeTurn,
  isAlreadySent,
  isStaleCallback,
  transition,
  VALID_TRANSITIONS
} from "../src/voiceSession";

describe("VoiceSession state machine", () => {
  it("defines the expected legal transitions", () => {
    expect(VALID_TRANSITIONS.idle).toEqual(["warming"]);
    expect(canTransition("warming", "listening")).toBe(true);
    expect(canTransition("listening", "processing")).toBe(true);
    expect(canTransition("processing", "speaking")).toBe(true);
    expect(canTransition("speaking", "listening")).toBe(true);
    expect(canTransition("speaking", "stopping")).toBe(true);
    expect(canTransition("stopping", "idle")).toBe(true);
  });

  it("rejects illegal transitions", () => {
    const session = createVoiceSession();
    expect(() => transition(session, "listening")).toThrow("Illegal transition");
    expect(() => transition(session, "processing")).toThrow("Illegal transition");
    expect(() => transition(session, "speaking")).toThrow("Illegal transition");
  });

  it("moves through the normal voice turn phases", () => {
    let session = createVoiceSession();
    session = transition(session, "warming");
    session = transition(session, "listening");
    session = transition(session, "processing");
    session = transition(session, "speaking");
    session = transition(session, "listening");
    expect(session.phase).toBe("listening");
  });

  it("increments generation and assigns a turn id for a new turn", () => {
    let session = createVoiceSession();
    session = beginNewTurn(session, { turnId: "turn-a" });
    expect(session.generation).toBe(1);
    expect(session.currentTurnId).toBe("turn-a");
    expect(session.turnText).toBe("");

    session = beginNewTurn(session, { turnId: "turn-b" });
    expect(session.generation).toBe(2);
    expect(session.currentTurnId).toBe("turn-b");
  });

  it("detects stale callbacks by generation and turn id", () => {
    let session = createVoiceSession();
    session = beginNewTurn(session, { turnId: "turn-current" });

    expect(isStaleCallback(session, 0, "turn-current")).toBe(true);
    expect(isStaleCallback(session, 1, "turn-old")).toBe(true);
    expect(isStaleCallback(session, 1, "turn-current")).toBe(false);
    expect(isStaleCallback(session, 1)).toBe(false);
  });

  it("merges cumulative transcript text without duplicating partials", () => {
    let session = createVoiceSession();
    session = appendTurnText(session, "我先说第一点");
    session = appendTurnText(session, "我先说第一点然后还有第二点");
    expect(session.turnText).toBe("我先说第一点然后还有第二点");

    session = appendTurnText(session, "第一点然后还有第二点");
    expect(session.turnText).toBe("我先说第一点然后还有第二点");
  });

  it("queues and consumes inputs in arrival order", () => {
    let session = createVoiceSession();
    session = enqueueInput(session, {
      text: "第一句",
      source: "voice",
      turnId: "turn-a",
      priority: "normal"
    });
    session = enqueueInput(session, {
      text: "第二句",
      source: "voice",
      turnId: "turn-a",
      priority: "interrupt"
    });

    expect(session.inputQueue).toHaveLength(2);
    const first = dequeueInput(session);
    expect(first.next?.text).toBe("第一句");
    expect(first.session.inputQueue).toHaveLength(1);

    const second = dequeueInput(first.session);
    expect(second.next?.text).toBe("第二句");
    expect(second.session.inputQueue).toHaveLength(0);

    const empty = dequeueInput(second.session);
    expect(empty.next).toBeNull();
  });

  it("preserves queued input when a new turn starts unless explicitly reset", () => {
    let session = createVoiceSession();
    session = enqueueInput(session, {
      text: "排队输入",
      source: "voice",
      turnId: "turn-a",
      priority: "normal"
    });

    const nextTurn = beginNewTurn(session, { turnId: "turn-b" });
    expect(nextTurn.inputQueue).toHaveLength(1);

    const resetTurn = beginNewTurn(nextTurn, { turnId: "turn-c", resetQueue: true });
    expect(resetTurn.inputQueue).toHaveLength(0);
  });

  it("tracks sent turn text and detects duplicate sends", () => {
    let session = createVoiceSession();
    session = appendTurnText(session, "今天的任务完成情况不太理想");
    session = finalizeTurn(session);

    expect(isAlreadySent(session, "今天的任务完成情况不太理想")).toBe(true);
    expect(isAlreadySent(session, "今天的任务完成情况不太")).toBe(true);
    expect(isAlreadySent(session, "任务完成情况")).toBe(false);
    expect(isAlreadySent(session, "完全不同的话")).toBe(false);
  });

  it("clears active turn text when returning to idle", () => {
    let session = createVoiceSession();
    session = transition(session, "warming");
    session = transition(session, "listening");
    session = beginNewTurn(session, { turnId: "turn-a" });
    session = appendTurnText(session, "你好");
    session = transition(session, "idle");

    expect(session.currentTurnId).toBeNull();
    expect(session.turnText).toBe("");
    expect(session.lastError).toBeNull();
  });
});
