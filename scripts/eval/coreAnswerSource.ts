/** Exact-source metric from the registered core tool evaluation.
 * This checks quotation fidelity, not semantic quality or permission to write.
 * A semantically faithful reply can still fail this stricter metric.
 */
export interface CoreAnswerSourceExpectation {
  source?: string;
  sourceText?: string;
  absent?: boolean;
  forbiddenText?: string;
}

export function scoreCoreAnswerSource(
  reply: string,
  expected: CoreAnswerSourceExpectation
): boolean | "not_applicable" {
  if (expected.forbiddenText && reply.includes(expected.forbiddenText)) return false;
  if (expected.source) {
    return typeof expected.sourceText === "string" && expected.sourceText.length > 0
      && reply.includes(expected.source) && reply.includes(expected.sourceText);
  }
  if (expected.absent) return /(没有找到|不存在|未找到)/.test(reply);
  return "not_applicable";
}
