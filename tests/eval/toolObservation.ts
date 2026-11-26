import type { EvalObservation } from "./scoring";

/** Record the tool actually used, independently of the expected scoring route. */
export function evaluationToolObservation(
  name: string,
  result: { success: boolean; output: string },
  redact: (text: string) => string
): EvalObservation["tools"][number] {
  let facts: unknown;
  const output = redact(result.output);
  if (result.success) {
    try { facts = JSON.parse(output); } catch { /* Prose is not structured tool evidence. */ }
  }
  return { name, ok: result.success,
    ...(facts === undefined ? {} : { facts }),
    ...(result.success ? {} : { detail: output.slice(0, 180) }) };
}
