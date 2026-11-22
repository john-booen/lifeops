import { expect, it } from "vitest";
import { readJudgeDecision } from "./eval/judgeDecision";

it("retries one interrupted judge measurement but keeps the same answer outside this reader", async () => {
  const attempts: number[] = [];
  const result = await readJudgeDecision(async attempt => { attempts.push(attempt); if (!attempt) throw Object.assign(Error("incomplete"), { code: "response_incomplete" }); return "1\n依据齐全。"; });
  expect(result).toEqual({ passed: true, reason: "依据齐全。" }); expect(attempts).toEqual([0, 1]);
});
it("never retries or overrides a valid judge rejection", async () => {
  let calls = 0; const result = await readJudgeDecision(async () => { calls++; return "0\n缺少原文依据。"; });
  expect(result.passed).toBe(false); expect(calls).toBe(1);
});
it("keeps two invalid measurements failed and stops on authorization or cancellation", async () => {
  let calls = 0; expect((await readJudgeDecision(async () => { calls++; return "不能读成通过"; })).passed).toBe(false); expect(calls).toBe(2);
  calls = 0; expect((await readJudgeDecision(async () => { calls++; throw Object.assign(Error("denied"), { code: "configuration" }); })).passed).toBe(false); expect(calls).toBe(1);
});
