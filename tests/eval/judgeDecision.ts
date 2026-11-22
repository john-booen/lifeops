/** A missing measurement may be retried once; a valid rejection is final. */
export async function readJudgeDecision(request: (attempt: number) => Promise<string>): Promise<{ passed: boolean; reason: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const content = await request(attempt);
      const decision = /^([01])\s*\n([\s\S]+)$/.exec(content.trim().replace(/^\x60{3}(?:text)?\s*|\s*\x60{3}$/gi, ""));
      if (decision?.[2].trim()) return { passed: decision[1] === "1", reason: decision[2].trim() };
    } catch (error) {
      const code = error && typeof error === "object" ? error as { code?: string; name?: string } : {};
      if (code.name === "AbortError" || code.code && !["response_incomplete", "network", "timeout", "rate_limit"].includes(code.code)) break;
    }
  }
  return { passed: false, reason: "未收到可读取的裁判结果" };
}
