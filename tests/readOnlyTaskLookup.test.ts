import { expect, it } from "vitest";
import { simpleReadOnlyTaskLookup } from "../src/agent/readOnlyTaskLookup";

it("accepts a simple named lookup with an explicit independent no-change clause", () => {
  for (const text of ["查一下样品盒相关未完成任务，不限定日期，先不要修改。", "查一下蓝盒任务。", "请查找蓝盒任务，只查不改。", "列出明天蓝盒任务，不做修改。", "帮我找一下蓝盒任务，不修改。", "查蓝盒任务，只读即可。"])
    expect(simpleReadOnlyTaskLookup(text), text).toBe(true);
});
it("does not turn a requested explanation, recommendation or comparison into a bare list", () => {
  for (const text of ["查蓝盒任务，解释为什么未完成，不修改。", "查蓝盒任务并比较差异，先不要修改。", "查蓝盒任务，给出建议，不修改。", "查蓝盒任务，按优先排序，不修改。"])
    expect(simpleReadOnlyTaskLookup(text), text).toBe(false);
});
it("does not hide a requested business change behind a restricted no-change clause", () => {
  for (const text of ["查蓝盒任务，不修改原日期，改时间。", "查蓝盒任务，先不要修改，然后改名。", "查蓝盒任务并新建一条记录，不修改。", "查蓝盒任务，再挪到明天，不修改备注。", "查蓝盒任务，定在明天9点。", "查蓝盒任务并完成。"])
    expect(simpleReadOnlyTaskLookup(text), text).toBe(false);
});
it("does not promote quoted task words or an ordinary conversation into read-only authorization", () => {
  for (const text of ["查名为“不要修改”的任务。", "他说查一下任务，不修改，我想知道原因。", "你好，不修改。", "查一下天气。"])
    expect(simpleReadOnlyTaskLookup(text), text).toBe(false);
});
it("keeps long compound requests on the normal conversation path", () => {
  expect(simpleReadOnlyTaskLookup("查蓝盒任务，" + "详细背景".repeat(60) + "，不修改。")).toBe(false);
});
