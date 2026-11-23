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
it("finishes a factual period and deadline lookup without offering another edit", () => {
  expect(simpleReadOnlyTaskLookup("查一下虚构水杉卡片归档的安排。这是这段日期内分次完成的任务，请告诉我是期间任务还是明天必须全部做完、计划哪天结束，有没有另设必须截止日期。不要修改或新建任何记录。")).toBe(true);
  for (const text of ["查蓝纸任务安排并给一条建议。不要修改或新建任何记录。", "查蓝纸任务安排，帮我完成这条任务。不要修改或新建任何记录。", "查蓝纸任务安排。不要修改或新建任何记录。然后改时间。"])
    expect(simpleReadOnlyTaskLookup(text)).toBe(false);
});
