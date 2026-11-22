import { expect, it } from "vitest";
import type { AiToolCall } from "../src/ai";
import { preferJournalOriginalReads } from "../src/agent/journalOriginalRouting";
const now = new Date("2026-11-12T12:00:00+08:00"), call: AiToolCall = { id: "original-call", name: "query_vault", arguments: { domain: "journal", operation: "list", range: "week", date: "2026-11-02", limit: 40 } };
const question = "请只查2026年11月2日至11月8日的原始日记，按事件发生日列出原话，不修改任务。";
it("reads the literal year and date range through the bounded original reader", () => {
  expect(preferJournalOriginalReads([call], question, now)).toEqual([{ id: call.id, name: "get_summaries", arguments: { level: "day", range: { from: "2026-11-02", to: "2026-11-08" }, includeOriginals: true } }]);
  expect(preferJournalOriginalReads([call], "查11月2日至11月8日的原始日记", now)[0].arguments.range).toEqual({ from: "2026-11-02", to: "2026-11-08" });
  for (const sort of ["newest", "oldest"]) expect(preferJournalOriginalReads([{ ...call, arguments: { ...call.arguments, date: "2026-11-12", sort } }], question, now)[0].arguments.range).toEqual({ from: "2026-11-02", to: "2026-11-08" });
});
it("supports unambiguous ISO and explicit cross-year ranges without changing caller objects", () => {
  const before = JSON.stringify(call);
  for (const [question, from, to] of [["核对2026-11-02至2026-11-08的日记原文", "2026-11-02", "2026-11-08"], ["回顾2025年12月28日至2026年1月3日的原始日记", "2025-12-28", "2026-01-03"]])
    expect(preferJournalOriginalReads([call], question, now)[0].arguments.range).toEqual({ from, to });
  expect(JSON.stringify(call)).toBe(before);
});
it("does not infer an ambiguous year, invalid date, extra range or a wider read window", () => {
  for (const q of ["查原始日记", "查2026年11月2日至11月8日和11月9日至11月15日的原始日记", "查2026年11月2日至11月2日的原始日记", "查去年11月2日至11月8日的原始日记", "查2026年2月30日至3月2日的原始日记", "查2026年11月8日至11月2日的原始日记", "查2026年10月1日至11月8日的原始日记", "查2026年11月2日至11月8日和11月10日的原始日记", "查2025年12月28日至1月3日的原始日记"])
    expect(preferJournalOriginalReads([call], q, now)[0]).toBe(call);
  expect(preferJournalOriginalReads([call], "查11月2日至11月8日的原始日记", now, [{ role: "user", content: "先看2025年的记录" }])[0]).toBe(call);
});
it("retains file discovery, quoted instructions and limited-note requests as their actual queries", () => {
  for (const q of ["列出2026年11月2日至11月8日的原始日记文件名", "解释这句话：查2026年11月2日至11月8日的原始日记", "查2026年11月2日至11月8日的3篇原始日记", "查2026年11月2日至11月8日的任务"])
    expect(preferJournalOriginalReads([call], q, now)[0]).toBe(call);
});
it("does not discard specific paths, topic filters, pagination or another domain", () => {
  for (const a of [{ path: "journal.md" }, { query: "蓝盒" }, { offset: 8 }, { domain: "note" }, { operation: "get" }, { limit: 0 }, { limit: 101 }, { limit: "40" }, { sort: "unknown" }, { range: "year" }, { unknown: true }, { range: { from: "2026-11-02", to: "2026-11-08" } }]) {
    const specific = { ...call, arguments: { ...call.arguments, ...a } };
    expect(preferJournalOriginalReads([specific], question, now)[0]).toBe(specific);
  }
  const other = { ...call, name: "list_tasks" }; expect(preferJournalOriginalReads([other], question, now)[0]).toBe(other);
});
it("retains the literal window and topic when an original-reading request is routed as a journal search", () => {
  const search = { ...call, arguments: { domain: "journal", operation: "search", query: "纸样", limit: 10 } };
  const before = JSON.stringify(search);
  expect(preferJournalOriginalReads([search], "核对2026年10月26日至11月8日的纸样归档原始日记，给一条下周建议，不修改任务。", now))
    .toEqual([{ ...search, name: "get_summaries", arguments: { level: "day", range: { from: "2026-10-26", to: "2026-11-08" }, includeOriginals: true, query: "纸样" } }]);
  expect(JSON.stringify(search)).toBe(before);
});
it.each([{ query: "" }, { query: "x".repeat(121) }, { path: "selected.md" }, { offset: 8 }, { domain: "note" }, { range: "year" }])("preserves a constrained topic read %j", extra => {
  const search = { ...call, arguments: { domain: "journal", operation: "search", query: "纸样", ...extra } };
  expect(preferJournalOriginalReads([search], question, now)[0]).toBe(search);
});
