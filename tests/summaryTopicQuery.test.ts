import { expect, it } from "vitest";
import { requestedSummaryTopics } from "../src/agent/summaryTopicQuery";
it.each([
  ["纸样 归档 虚纸 裁剪 纸样归档", "回顾两周虚构纸样归档", "纸样 归档 纸样归档"],
  ["Blue BOX unrelated", "Review the blue box", "Blue BOX"],
  ["ＡＢ 额外", "请回顾AB", "ＡＢ"],
  ["纸样 归档", "回顾纸样归档", "纸样 归档"],
  ["纸样 归档", "继续回顾刚才的主题", "纸样 归档"],
  ["裁剪", "回顾纸样归档", "裁剪"],
  [" ", "回顾纸样归档", " "],
  ["纸样 " + "x".repeat(120), "回顾纸样归档", "纸样 " + "x".repeat(120)]
])("preserves the requested topic and parameter validation: %s", (query, message, expected) => {
  const args = { query, level: "week", range: { from: "2026-10-26", to: "2026-11-08" }, includeOriginals: true };
  const call = { id: "fictional", name: "get_summaries", arguments: args };
  const [result] = requestedSummaryTopics([call], message);
  expect(result.arguments).toEqual({ ...args, query: expected }); expect(call.arguments.query).toBe(query);
  expect(requestedSummaryTopics([{ ...call, name: "query_vault" }], message)[0].arguments).toBe(args);
});
