import { afterEach, describe, expect, it, vi } from "vitest";
import { LifeOpsAi } from "../src/ai";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { classifyPlaybackInput } from "../src/voice/playbackInput";

vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

const previous = "上周完成了多少项任务？";
const classify = (text: string, signal = new AbortController().signal) =>
  classifyPlaybackInput(DEFAULT_SETTINGS, text, previous, signal);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("speech during assistant playback", () => {
  it.each([
    ["我。", "ignore"],
    ["这个，嗯，那个。", "ignore"],
    ["小李，你把这个纸袋拿过来。", "ignore"],
    ["今晚一起吃什么？", "ignore"],
    ["停电了。", "ignore"],
    ["停。", "accept"],
    ["停一下，我想问明天的任务。", "accept"],
    ["不对，上个月。", "accept"],
    ["上个月。", "accept"],
    ["明天还有哪些待办？", "accept"],
    ["换个话题，明天要做什么？", "accept"],
    ["记一个待办，给样品盒贴标签。", "accept"],
    ["撤销。", "accept"]
  ] as const)("handles %s when the classifier is unavailable", async (text, expected) => {
    vi.spyOn(LifeOpsAi.prototype, "agentTurnStream").mockRejectedValue(new Error("synthetic timeout"));
    await expect(classify(text)).resolves.toBe(expected);
  });

  it("uses a valid online judgment and falls back on invalid output", async () => {
    vi.spyOn(LifeOpsAi.prototype, "agentTurnStream")
      .mockResolvedValueOnce({ content: "accept", toolCalls: [] })
      .mockResolvedValueOnce({ content: "not a decision", toolCalls: [] });
    await expect(classify("今晚一起吃什么？")).resolves.toBe("accept");
    await expect(classify("今晚一起吃什么？")).resolves.toBe("ignore");
  });

  it("uses the model and cancels its request on deadline without AbortSignal.any", async () => {
    vi.stubGlobal("AbortSignal", {});
    vi.useFakeTimers();
    const online = vi.spyOn(LifeOpsAi.prototype, "agentTurnStream")
      .mockResolvedValueOnce({ content: "accept", toolCalls: [] })
      .mockImplementationOnce((_messages, _onText, options) => new Promise((_resolve, reject) => {
        const request = options!.signal!;
        request.addEventListener("abort", () => reject(request.reason), { once: true });
      }));
    await expect(classify("今晚一起吃什么？")).resolves.toBe("accept");
    expect(vi.getTimerCount()).toBe(0);

    const result = classify("今晚一起吃什么？");
    const request = online.mock.calls[1]?.[2]?.signal;
    const deadline = online.mock.calls[1]?.[2]?.timeoutMs;
    expect(deadline).toBe(2200);
    await vi.advanceTimersByTimeAsync(2199);
    expect(request?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(request?.reason).toMatchObject({ name: "TimeoutError" });
    await expect(result).resolves.toBe("ignore");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("discards a result after cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("synthetic cancellation");
    const online = vi.spyOn(LifeOpsAi.prototype, "agentTurnStream").mockImplementation(async () => {
      controller.abort(reason);
      return { content: "accept", toolCalls: [] };
    });
    await expect(classify("停一下。", controller.signal)).resolves.toBeUndefined();
    expect(online.mock.calls[0]?.[2]?.signal?.reason).toBe(reason);
  });
});
