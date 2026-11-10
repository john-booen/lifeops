import { expect, it, vi } from "vitest";
import { newSourceAnalysisState, runReadonlySourceAnalysis } from "../src/readonlySourceAnalysis";
import type { AiToolCall } from "../src/ai";
const call = (id: string) => ({ id, name: "query_vault", arguments: { domain: "note", operation: "get", path: "虚构.md" } });
const execute = vi.fn(async (calls: AiToolCall[]) => calls.map(item => ({ callId: item.id!, success: true, output: "纯虚构实际回执" })));
it("closes tools for the final request after four batches and keeps all actual receipts", async () => {
  execute.mockClear(); const state = newSourceAnalysisState(), request = vi.fn(async (turns, canRead) => {
    if (turns.length < 4) { expect(canRead).toBe(true); return { content: "规划不发布", toolCalls: [call(`page-${turns.length}`)] }; }
    expect(canRead).toBe(false); expect(turns.flatMap((turn: any) => turn.results)).toHaveLength(4);
    return { content: "资料范围有限的虚构回答", toolCalls: [] };
  });
  const result = await runReadonlySourceAnalysis({ state, bootstrap: [], assertCurrent: async () => {}, request, execute });
  expect(execute).toHaveBeenCalledTimes(4); expect(request).toHaveBeenCalledTimes(5); expect(result.toolCalls).toEqual([]);
});
it("rejects cross-round duplicate IDs before the second dispatch", async () => {
  execute.mockClear(); const result = await runReadonlySourceAnalysis({ state: newSourceAnalysisState(), bootstrap: [call("same")], assertCurrent: async () => {}, request: async () => ({ content: "", toolCalls: [call("same")] }), execute });
  expect(execute).toHaveBeenCalledOnce(); expect(result.content).toContain("编号重复");
});
it("counts every receipt character and never supplies an oversized batch to the model", async () => {
  const request = vi.fn(), large = vi.fn(async () => [{ callId: "large", success: true, output: "甲".repeat(72_001) }]), state = newSourceAnalysisState();
  const result = await runReadonlySourceAnalysis({ state, bootstrap: [call("large")], assertCurrent: async () => {}, request, execute: large });
  expect(request).not.toHaveBeenCalled(); expect(state.turns).toEqual([]); expect(result.content).toContain("未将截短");
});
it("refuses more than twelve calls as one batch without dispatching any", async () => {
  execute.mockClear(); const result = await runReadonlySourceAnalysis({ state: newSourceAnalysisState(), bootstrap: [], assertCurrent: async () => {}, request: async () => ({ content: "", toolCalls: Array.from({ length: 13 }, (_, index) => call(`many-${index}`)) }), execute });
  expect(execute).not.toHaveBeenCalled(); expect(result.content).toContain("范围上限");
});
it("does not re-request a model after a failed source receipt", async () => {
  const request = vi.fn(), result = await runReadonlySourceAnalysis({ state: newSourceAnalysisState(), bootstrap: [call("failed")], assertCurrent: async () => {}, request, execute: async () => [{ callId: "failed", success: false, output: "来源不可核对" }] });
  expect(request).not.toHaveBeenCalled(); expect(result.content).toContain("未用其它记录");
});
it("does not resume a partially started bootstrap in a second executor", async () => {
  const state = newSourceAnalysisState(); state.bootstrapStarted = true; state.reading = true;
  const request = vi.fn(), execute = vi.fn();
  const result = await runReadonlySourceAnalysis({ state, bootstrap: [call("unfinished")], assertCurrent: async () => {}, request, execute });
  expect(request).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(result.content).toContain("未用旧检索片段");
});
it("does not read a required page after successful receipts have exhausted the character budget", async () => {
  const state = newSourceAnalysisState(); state.bootstrapStarted = true; state.bootstrapCompleted = true;
  state.readRounds = 1; state.calls = 1; state.chars = 72_000;
  state.turns = [{ calls: [call("head")], results: [{ callId: "head", success: true, output: "甲".repeat(72_000) }] }];
  const request = vi.fn(), execute = vi.fn();
  const result = await runReadonlySourceAnalysis({ state, bootstrap: [], assertCurrent: async () => {}, request, execute, requiredReads: () => [call("required-tail")] });
  expect(execute).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled(); expect(state.readRounds).toBe(1); expect(state.calls).toBe(1); expect(state.chars).toBe(72_000); expect(result.content).toContain("范围上限");
});
