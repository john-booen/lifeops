export type DelegationStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out";

export interface DelegationRequest {
  id: string;
  userQuery: string;
  context: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DelegationResult<T> {
  id: string;
  status: DelegationStatus;
  startedAt: string;
  finishedAt: string;
  value?: T;
  error?: string;
}

export async function runDelegation<T>(
  request: DelegationRequest,
  execute: (signal: AbortSignal) => Promise<T>,
  now: () => Date = () => new Date()
): Promise<DelegationResult<T>> {
  const startedAt = now().toISOString();
  const controller = new AbortController();
  const timeoutMs = Math.max(10, request.timeoutMs ?? 60_000);
  const onAbort = (): void => controller.abort(request.signal?.reason);
  request.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    const error = new Error("delegation timeout"); error.name = "TimeoutError";
    controller.abort(error);
  }, timeoutMs);
  let rejectOnAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () => reject(controller.signal.reason ?? new Error("delegation cancelled"));
    controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
  });
  try {
    if (request.signal?.aborted) controller.abort(request.signal.reason);
    // Attach the race before checking cancellation so even an already rejected
    // abort promise is observed, without ever invoking a cancelled executor.
    const work = controller.signal.aborted ? aborted : execute(controller.signal);
    const value = await Promise.race([work, aborted]);
    if (controller.signal.aborted) throw controller.signal.reason;
    return {
      id: request.id,
      status: "completed",
      startedAt,
      finishedAt: now().toISOString(),
      value
    };
  } catch (error) {
    const timedOut = controller.signal.aborted && controller.signal.reason instanceof Error && controller.signal.reason.name === "TimeoutError";
    const cancelled = controller.signal.aborted && !timedOut;
    return {
      id: request.id,
      status: timedOut ? "timed_out" : cancelled ? "cancelled" : "failed",
      startedAt,
      finishedAt: now().toISOString(),
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", rejectOnAbort);
    request.signal?.removeEventListener("abort", onAbort);
  }
}
