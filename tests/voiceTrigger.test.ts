import { describe, expect, it } from "vitest";
import {
  cleanupVoiceTriggerText,
  findVoiceTrigger,
  parseVoiceTriggerPhrases,
  stripVoiceTriggers,
  voiceTranscriptFragments
} from "../src/voice/voiceTrigger";

describe("voiceTrigger", () => {
  it("parses trigger phrases and removes duplicates", () => {
    expect(parseVoiceTriggerPhrases("CC, Cici，CC\n小管家")).toEqual(["CC", "Cici", "小管家"]);
  });

  it("finds the latest trigger and strips it from a message", () => {
    const phrases = parseVoiceTriggerPhrases("CC, Cici");

    expect(findVoiceTrigger("我先说别的，CC 今天任务是什么", phrases)).toEqual({ start: 6, end: 8 });
    expect(stripVoiceTriggers("CC，今天任务是什么", phrases)).toEqual({
      text: "今天任务是什么",
      matched: true
    });
  });

  it("matches repeated single-character triggers", () => {
    const phrases = parseVoiceTriggerPhrases("CC");

    expect(stripVoiceTriggers("CCCC 今天怎么样", phrases)).toEqual({
      text: "今天怎么样",
      matched: true
    });
  });

  it("cleans trigger punctuation and slices transcript fragments", () => {
    expect(cleanupVoiceTriggerText(" ，。 今天  任务 ？ ")).toBe("今天 任务");
    expect(voiceTranscriptFragments("第一句。第二句很长！短", 3)).toEqual(["第一句。第二句很长！短", "第一句", "第二句很长"]);
  });
});
