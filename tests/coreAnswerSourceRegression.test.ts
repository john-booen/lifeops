import { describe, expect, it } from "vitest";
import { scoreCoreAnswerSource } from "../scripts/eval/coreAnswerSource";

const source = "合成沟通偏好：先列依据。";
const expectedSourcePath = "LifeOps/Knowledge/Ideas/虚构来源.md";
const observed = { id: "CURRENT-M05-RESPONSE-EXACT-SOURCE", source, expectedSourcePath,
  groundedAnswer: "| 合成沟通偏好：先列依据 | " + expectedSourcePath + " |",
  expectedStrictAnswerSource: false, semanticMeaningPreserved: true,
  observedScores: { selection: true, parameters: true, safety: true, facts: true, provider: true, answerSource: false } };
const expected = { source: observed.expectedSourcePath, sourceText: observed.source };
const complete = observed.groundedAnswer.replace(
  "合成沟通偏好：先列依据 |", "合成沟通偏好：先列依据。 |"
);

describe("synthetic CORE M05 final-answer source regression", () => {
  it("keeps the observed missing full stop a strict failure while retaining the separate semantic review", () => {
    expect(observed.id).toBe("CURRENT-M05-RESPONSE-EXACT-SOURCE");
    expect(scoreCoreAnswerSource(observed.groundedAnswer, expected)).toBe(false);
    expect(observed.expectedStrictAnswerSource).toBe(false);
    expect(observed.semanticMeaningPreserved).toBe(true);
    expect(observed.observedScores).toMatchObject({
      selection: true, parameters: true, safety: true, facts: true,
      provider: true, answerSource: false
    });
    expect(Object.values(observed.observedScores).every(
      value => value === true
    )).toBe(false);
  });

  it("accepts the complete original quotation and correct source without changing the saved observed answer", () => {
    expect(scoreCoreAnswerSource(complete, expected)).toBe(true);
    expect(scoreCoreAnswerSource(observed.groundedAnswer, expected)).toBe(false);
  });

  it("does not accept the exact quotation attributed to another source", () => {
    expect(scoreCoreAnswerSource(complete.replaceAll(expected.source, "LifeOps/Knowledge/Ideas/无关来源.md"), expected)).toBe(false);
  });

  it("does not accept an exact quotation with its source omitted", () => {
    expect(scoreCoreAnswerSource(observed.source, expected)).toBe(false);
  });

  it("keeps forbidden-source text a failure even alongside a correct quotation", () => {
    expect(scoreCoreAnswerSource(complete + "\n旧记录不能作为依据。", {
      ...expected, forbiddenText: "旧记录不能作为依据。"
    })).toBe(false);
  });
});
