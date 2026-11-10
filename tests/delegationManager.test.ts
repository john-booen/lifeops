import { describe, expect, it, vi } from "vitest";
import { runDelegation } from "../src/delegationManager";

describe("delegation manager", () => {
  it("returns a completed result without exposing progress speech", async () => {
    const result = await runDelegation({
      id: "deep-1",
      userQuery: "分析最近日记",
      context: "grounded context"
    }, async () => "analysis");

    expect(result).toMatchObject({
      id: "deep-1",
      status: "completed",
      value: "analysis"
    });
  });

  it("times out a stuck reasoning request without blocking the caller forever", async () => {
    const result = await runDelegation({
      id: "deep-timeout",
      userQuery: "分析",
      context: "",
      timeoutMs: 10
    }, (signal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));

    expect(result.status).toBe("timed_out");
  });

  it("propagates caller cancellation as cancellation rather than failure", async () => {
    const controller = new AbortController();
    const promise = runDelegation({
      id: "deep-cancel",
      userQuery: "分析",
      context: "",
      signal: controller.signal
    }, (signal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }));
    controller.abort(new Error("user cancelled"));

    expect((await promise).status).toBe("cancelled");
  });

  it("does not invoke an executor for an already cancelled request", async () => {
    const controller = new AbortController(); controller.abort();
    let invoked = false;
    const result = await runDelegation({ id: "pre-cancel", userQuery: "", context: "", signal: controller.signal }, async () => { invoked = true; return "late"; });
    expect(result.status).toBe("cancelled");
    expect(invoked).toBe(false);
  });

  it("retains a caller deadline that expired before delegation without invoking an executor", async () => {
    const controller = new AbortController();
    const reason = new Error("合成页面请求超时"); reason.name = "TimeoutError"; controller.abort(reason);
    const execute = vi.fn(async () => "合成迟到结果");
    const result = await runDelegation({ id: "pre-deadline", userQuery: "", context: "", signal: controller.signal }, execute);
    expect(result.status).toBe("timed_out");
    expect(execute).not.toHaveBeenCalled();
  });

  it("settles a timeout even when the executor ignores its signal", async () => {
    const result = await runDelegation({ id: "ignore-abort", userQuery: "", context: "", timeoutMs: 10 }, async () => {
      await new Promise(resolve => setTimeout(resolve, 35));
      return "late";
    });
    expect(result.status).toBe("timed_out");
    expect(result.value).toBeUndefined();
  });
});
