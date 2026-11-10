import { beforeEach, describe, expect, it } from "vitest";
import {
  addEchoText,
  charOverlapRatio,
  clearEchoMemories,
  isEchoTranscript
} from "../src/voiceSession";

beforeEach(() => clearEchoMemories());

describe("EchoFilter", () => {
  it("detects exact assistant text as echo", () => {
    addEchoText("今天的任务有三项需要完成");
    expect(isEchoTranscript("今天的任务有三项需要完成")).toBe(true);
  });

  it("detects transcript substrings as echo", () => {
    addEchoText("你今天的任务完成情况不太理想");
    expect(isEchoTranscript("今天任务完成")).toBe(true);
  });

  it("detects assistant text contained inside a longer transcript", () => {
    addEchoText("先别急着创建任务");
    expect(isEchoTranscript("嗯先别急着创建任务好的")).toBe(true);
  });

  it("keeps one-character fragments unless they exactly match echo memory", () => {
    expect(isEchoTranscript("嗯")).toBe(false);
    expect(isEchoTranscript("好")).toBe(false);
    addEchoText("嗯");
    expect(isEchoTranscript("嗯")).toBe(true);
    expect(isEchoTranscript("好")).toBe(false);
    clearEchoMemories();
    addEchoText("你好");
    expect(isEchoTranscript("你")).toBe(false);
  });

  it("does not kill an unrelated new question", () => {
    addEchoText("你今天的状态看起来不错");
    expect(isEchoTranscript("我明天有什么安排")).toBe(false);
  });

  it("expires echo memories by ttl", () => {
    const now = Date.now();
    addEchoText("这句话很快过期", 5);
    expect(isEchoTranscript("这句话很快过期", now)).toBe(true);
    expect(isEchoTranscript("这句话很快过期", now + 6)).toBe(false);
  });

  it("detects high character overlap", () => {
    addEchoText("今天天气不错我们去散步吧");
    expect(isEchoTranscript("今天天气不错")).toBe(true);
  });

  it("computes character overlap on normalized text", () => {
    expect(charOverlapRatio("今天，任务！", "今天任务")).toBe(1);
    expect(charOverlapRatio("abcdef", "xyz")).toBe(0);
  });

  it("clears all memories", () => {
    addEchoText("需要被清空的回复");
    clearEchoMemories();
    expect(isEchoTranscript("需要被清空的回复")).toBe(false);
  });
});
