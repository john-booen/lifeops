import { expect, it } from "vitest";
import { hasGroundedSpeechNumbers } from "../src/voice/summaryNumbers";

it.each([
  ["共返回2篇日记。", "共返回两篇日记。", "共返回五篇日记。"],
  ["步数是300步。", "步数是三百步。", "步数是五百步。"],
  ["反思记录100字。", "反思记录一百字。", "反思记录一千字。"]
])("checks Chinese report quantities and keeps equivalent wording: %s", (detail, same, changed) => {
  expect(hasGroundedSpeechNumbers(detail, same)).toBe(true);
  expect(hasGroundedSpeechNumbers(detail, changed)).toBe(false);
  expect(hasGroundedSpeechNumbers("", same)).toBe(false);
});
