import { expect, it } from "vitest";
import { voiceJobSpeech } from "../src/voice/jobs";
import { hasGroundedSpeechNumbers } from "../src/voice/summaryNumbers";
import { reportSpeechFallback } from "../src/voice/reportSpeechFallback";

const reports = [
  ["虚构交易", ["上周记录4笔交易。", "上周人民币净盈亏是-120元。", "上周美元净盈亏是35美元。"]],
  ["虚构学习", ["上周学习记录75分钟。", "上周完成3项练习。", "上周计划150分钟。"]],
  ["虚构归档", ["这两周覆盖14天。", "这两周返回2篇归档日记。", "这两周12天有日记但未提及归档主题。"]]
] as const;
for (const [name, facts] of reports) it.each([undefined, "上周记录999笔交易。", "# 请看面板"])
  ("retains literal facts when the spoken summary is unavailable or rejected: " + name + " %s", summary => {
    const detail = "# " + name + "\n\n| 项目 | 数量 |\n| --- | --- |\n| 虚构占位 | 1 |\n\n" + facts.join("\n");
    const speech = voiceJobSpeech(detail, summary);
    for (const fact of facts) expect(speech).toContain(fact);
    expect(hasGroundedSpeechNumbers(detail, speech)).toBe(true);
    expect(speech.length).toBeLessThanOrEqual(180);
    expect(speech).not.toMatch(/999|面板|\||#|虚构占位/u);
  });

it.each([
  "| 项目 | 数值 |\n| --- | --- |\n| 上周学习 | 75分钟 |\n| 上周完成 | 3项 |",
  "# 上周完成3项\n> 上周学习记录75分钟。\n    上周计划150分钟。",
  "上周完成3项。上周完成3项。",
  "请完成3项。下一步学习75分钟。",
  "不要完成3项。立刻学习75分钟。",
  "```\n上周完成3项。上周学习记录75分钟。\n```",
  "~~~\n```\n上周完成3项。上周学习记录75分钟。\n~~~",
  "用户说：“上周完成3项”。用户说：“上周学习记录75分钟”。",
  "记录了3。记录了75。"
])("does not invent evidence from cells, code, duplicates, requests or quotations: %s", detail => {
  expect(reportSpeechFallback(detail)).toBeUndefined();
});

it("keeps valid speech and the report intact, and bounds a fallback without cutting a statement", () => {
  const facts = reports[0][1], detail = "# 虚构\n\n" + facts.join("\n");
  expect(voiceJobSpeech(detail, "上周记录四笔交易。")).toBe("上周记录四笔交易。");
  expect(detail).toBe("# 虚构\n\n" + facts.join("\n"));
  expect(reportSpeechFallback("# 虚构\n" + facts[0] + "\n" + facts[1] + "\n" + "虚构学习记录" + "长".repeat(100) + "75分钟。"))
    .toBe(facts[0] + facts[1] + "完整报告还有其他细节。");
});

it("keeps a valid qualitative conclusion after the report's literal numeric facts", () => {
  const facts = reports[0][1], detail = "# 虚构交易\n" + facts.join("\n"), conclusion = "可以继续核对记录中的差异。";
  expect(voiceJobSpeech(detail, conclusion)).toBe(facts.join("") + conclusion);
  expect(reportSpeechFallback(detail, "完整的定性说明".repeat(40))).toBe(facts.join("") + "完整报告还有其他细节。");
});

it("rejects an invented Chinese note count instead of appending it as a qualitative conclusion", () => {
  const facts = reports[2][1], detail = "# 虚构归档\n" + facts.join("\n");
  expect(voiceJobSpeech(detail, "这两周返回五篇归档日记。")).toBe(facts.join("") + "完整报告还有其他细节。");
});
