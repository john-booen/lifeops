import { expect, it } from "vitest";
import { appendEveningEntry, journalDraftContent, journalOriginalText } from "../src/features/journal/entry";

it.each(["## 原话\n", "原话\n------\n"])("uses the actual original section: %s", heading => {
  const source = "## 整理\n助手推测：虚构偏好甲。\n\n" + heading + "用户原话：虚构偏好乙。\n\n## 后续\n其他内容。";
  expect(journalOriginalText(source)).toBe("用户原话：虚构偏好乙。");
});
it("reads unsectioned legacy author text without interpreting frontmatter as a user preference", () => {
  expect(journalOriginalText("---\nassistant_note: 虚构偏好甲\n---\n\n我偏好虚构方案乙。\n")).toBe("我偏好虚构方案乙。");
});
it("does not use generated-only diaries or nested original headings inside a draft", () => {
  expect(journalOriginalText("## 整理\n模型猜测。\n### 原话\n也是模型的内容。\n")).toBe("");
  expect(journalOriginalText("## AI整理稿\n模型猜测。\n")).toBe("");
});
it("preserves real original text containing headings and fences without upgrading draft examples", () => {
  const original = "我偏好虚构蓝纸。\n## 原话\n这也是我这次发言的一部分。\n~~~\n虚构代码片段。\n~~~";
  const source = appendEveningEntry("", "日记", journalDraftContent("## 原话\n模型写的假标题。"), original);
  const actual = journalOriginalText(source);
  expect(actual).toContain(original); expect(actual).not.toContain("模型写的假标题");
});
it("does not assert authorship from an incomplete Markdown section", () => {
  expect(journalOriginalText("## 原话\n~~~\n未闭合的虚构片段。\n")).toBe("");
});
