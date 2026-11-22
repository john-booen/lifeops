import type { ToolExecutionResult } from "../toolRegistry";

const refreshErrors = new Set([
  "查询范围已变化，请重新读取后再操作。",
  "查询原文已变化，请重新读取后再操作。"
]);

/** Only an unpublished read may be prepared again, once. No model or write replay. */
export async function retrySummaryRead(
  failed: ToolExecutionResult,
  reread: () => Promise<ToolExecutionResult>,
  assertSameRequest: () => Promise<void>
): Promise<ToolExecutionResult> {
  if (failed.success || !refreshErrors.has(failed.output)) return failed;
  try {
    await assertSameRequest();
    const fresh = await reread();
    await assertSameRequest();
    return fresh;
  } catch { return failed; }
}
