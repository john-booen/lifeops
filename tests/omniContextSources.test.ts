import { expect, it, vi } from "vitest";
import { withdrawOmniContext } from "../src/voice/omniE2e/contextSources";
import { VoiceSessionController } from "../src/voice/voiceRuntime";

function setup() {
  const steps: string[] = [];
  const close = vi.fn(() => { steps.push("close"); });
  const runtime = new VoiceSessionController();
  runtime.connect();
  runtime.connected();
  runtime.beginTurn({ route: "e2e", transcript: "虚构资料查询" });
  runtime.bindPlayback("old-playback");
  const view = {
    agentRealtimeClient: { close },
    agentVoiceRuntime: runtime,
    agentRealtimeStartGeneration: 3,
    agentTextRequestGeneration: 1,
    agentAudioOutput: { cancel: vi.fn(() => { steps.push("cancel"); }) },
    transitionVoiceSession: vi.fn(),
    clearVoiceWarmupTimer: vi.fn(),
    currentVoiceMessageText: () => "",
    refreshAgentSurfaceState: vi.fn(),
    viewClosed: false,
    agentReply: ""
  };
  const withdraw = vi.fn(() => { steps.push("withdraw"); });
  const fail = vi.fn(() => { steps.push("fail"); });
  const stop = vi.fn(async () => {
    steps.push("stop");
    view.agentRealtimeStartGeneration++;
    close();
  });
  const invalidate = () => withdrawOmniContext(view, "旧资料已撤回。", withdraw, fail, stop);
  return { view, steps, close, withdraw, fail, stop, invalidate };
}

it("withdraws source-derived text, retires playback and closes through silent stop", async () => {
  const { view, steps, close, stop, invalidate } = setup();
  invalidate();
  expect(steps).toEqual(["withdraw", "fail", "cancel", "stop", "close"]);
  expect(close).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledExactlyOnceWith(view, true);
  await Promise.resolve();
  expect(view.agentReply).toBe("旧资料已撤回。");
  expect(view.refreshAgentSurfaceState).toHaveBeenCalledOnce();
});

it("does not stop a replacement connection started by a playback callback", () => {
  const { view, close, stop, invalidate } = setup();
  const replacement = { close: vi.fn() };
  view.agentAudioOutput.cancel.mockImplementation(() => { view.agentRealtimeClient = replacement; });
  invalidate();
  expect(stop).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(replacement.close).not.toHaveBeenCalled();
});

it("preserves a newer text turn when the stop settles", async () => {
  const { view, invalidate } = setup();
  invalidate();
  view.agentTextRequestGeneration++;
  view.agentReply = "新对话已开始。";
  await Promise.resolve();
  expect(view.agentReply).toBe("新对话已开始。");
  expect(view.refreshAgentSurfaceState).not.toHaveBeenCalled();
});
