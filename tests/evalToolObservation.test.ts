import { expect, it } from "vitest";
import { evaluationToolObservation } from "./eval/toolObservation";
import { scoreEvaluationCase, type EvalObservation, type EvalQuestion } from "./eval/scoring";

it("retains all alternate statistics outputs with their actual tool name and range", () => {
  const facts = { domain: "tasks", range: { from: "2026-10-01", to: "2026-10-31" }, completedTaskCount: 60 };
  const tool = evaluationToolObservation("get_stats", { success: true, output: JSON.stringify(facts) }, text => text);
  expect(tool).toEqual({ name: "get_stats", ok: true, facts });
  const question: EvalQuestion = { id: "fictional-source", milestone: "M6", domain: "summary", mode: "text", input: "虚构对比", history: [],
    checks: { toolFacts: [{ name: "get_summaries", output: { level: "month" } }] } };
  const observed: EvalObservation = { reply: "虚构完成60项", tools: [tool], writes: {}, createdTasks: [], tasks: [], confirmations: 0, confirmationActions: [], receipts: 0, preludeCreatedTasks: 0 };
  expect(scoreEvaluationCase(question, observed)).toContain("工具读回的范围或统计不符 get_summaries");
});

it("redacts successful structured evidence before retaining it", () => {
  const tool = evaluationToolObservation("fictional_tool", { success: true, output: '{"token":"fictional-private-token","count":3}' }, text => text.replaceAll("fictional-private-token", "[REDACTED]"));
  expect(tool.facts).toEqual({ token: "[REDACTED]", count: 3 });
  expect(JSON.stringify(tool)).not.toContain("fictional-private-token");
});

it("does not turn failed JSON or successful prose into successful numeric evidence", () => {
  expect(evaluationToolObservation("get_stats", { success: false, output: '{"count":0}' }, text => text)).toEqual({ name: "get_stats", ok: false, detail: '{"count":0}' });
  expect(evaluationToolObservation("get_stats", { success: true, output: "未取得完整数字" }, text => text)).toEqual({ name: "get_stats", ok: true });
});
