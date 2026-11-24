import { expect, it } from "vitest";
import { requestedSummaryTopics, requestedTaskTopics } from "../src/agent/summaryTopicQuery";
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
it.each([
  ["虚构跨日期样品盒编号", "查一下虚构跨日期样品盒相关的未完成任务", "虚构跨日期样品盒"],
  ["虚构跨日期样品盒编号", "查一下虚构跨日期样品盒编号", "虚构跨日期样品盒编号"],
  ["虚构跨日期样品盒编号", "继续查刚才的任务", "虚构跨日期样品盒编号"],
  ["明天的编号", "查一下明天的任务", "明天的编号"],
  ["Blue box serial", "Find Blue box", "Blue box serial"]
])("keeps literal task scope without guessing contextual or short queries: %s", (query, message, expected) => {
  const args = { query, status: "pending", answerMode: "facts" };
  const call = { id: "fictional-topic", name: "list_tasks", arguments: args };
  expect(requestedTaskTopics([call], message)[0].arguments).toEqual({ ...args, query: expected });
  expect(call.arguments).toBe(args);
  expect(requestedTaskTopics([{ ...call, name: "query_vault" }], message)[0].arguments).toBe(args);
});
