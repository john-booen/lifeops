import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeInstructionsBoundary, RealtimeInstructionsBoundaryError,
  type RealtimeInstructionsBoundaryOptions, type RealtimeInstructionsSnapshot } from "../src/voice/realtimeInstructionsBoundary";

interface Update { type: string; event_id: string; session: { instructions: string } }
class FakeSocket {
  readonly sent: Update[] = [];
  readonly close = vi.fn();
  readonly stopPlayback = vi.fn();
  readonly send = vi.fn((payload: Record<string, unknown>) => { this.sent.push(payload as unknown as Update); });
  echo(boundary: RealtimeInstructionsBoundary, index = this.sent.length - 1): boolean {
    return boundary.acceptSessionEvent({ type: "session.updated", session: { instructions: this.sent[index].session.instructions } });
  }
}
function snapshot(instructions = "固定规则\n合成视觉摘要", expiresAt?: number) {
  return { instructions, baseInstructions: "固定规则", expiresAt, assertCurrent: vi.fn(), dispose: vi.fn() };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const boundaries: RealtimeInstructionsBoundary[] = [];
function harness(source: RealtimeInstructionsSnapshot[] = [], extra: Partial<RealtimeInstructionsBoundaryOptions> = {}) {
  const socket = new FakeSocket();
  const prepare = vi.fn(async () => {
    const next = source.shift();
    if (!next) throw new Error("Missing synthetic snapshot");
    return next;
  });
  const boundary = new RealtimeInstructionsBoundary({ prepare, send: socket.send, isCurrent: () => true, ...extra });
  boundaries.push(boundary);
  return { boundary, socket, prepare };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => { for (const boundary of boundaries.splice(0)) boundary.cancel(); vi.useRealTimers(); });

describe("Realtime instructions response boundary", () => {
  it("requires the exact echoed nonce-bearing instructions and returns a disposable original-content token", async () => {
    const source = snapshot(); const audit = vi.fn(async (_bytes: number) => undefined);
    const { boundary, socket } = harness([source], { audit });
    const settled = vi.fn(); const pending = boundary.prepareForResponse(() => true);
    void pending.then(settled);
    await flush();
    expect(socket.sent).toHaveLength(1);
    const update = socket.sent[0];
    expect(Object.keys(update).sort()).toEqual(["event_id", "session", "type"]);
    expect(Object.keys(update.session)).toEqual(["instructions"]);
    expect(update.type).toBe("session.update");
    expect(update.session.instructions).toContain(source.instructions);
    expect(update.session.instructions).toContain(update.event_id);
    expect(update.session.instructions).toContain("不得朗读");
    expect(audit).toHaveBeenCalledExactlyOnceWith(Buffer.byteLength(JSON.stringify(update), "utf8"));
    for (const event of [
      { type: "session.created", session: update.session },
      { type: "session.updated", event_id: update.event_id },
      { type: "session.updated", session: { instructions: source.instructions } },
      { type: "session.updated", session: { instructions: `${update.session.instructions} ` } }
    ]) expect(boundary.acceptSessionEvent(event)).toBe(false);
    await flush(); expect(settled).not.toHaveBeenCalled();
    expect(socket.echo(boundary)).toBe(true);
    const token = await pending;
    expect(token.instructions).toBe(source.instructions); expect(token.baseInstructions).toBe(source.baseInstructions);
    expect(token.assertCurrent()).toBeUndefined(); expect(Object.isFrozen(token)).toBe(true);
    token.dispose(); token.dispose(); expect(source.dispose).toHaveBeenCalledOnce();
    expect(() => token.assertCurrent()).toThrow(RealtimeInstructionsBoundaryError);
    expect(socket.echo(boundary)).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts a synchronous fake socket echo", async () => {
    const source = snapshot(); let boundary!: RealtimeInstructionsBoundary;
    const send = vi.fn((payload: Record<string, unknown>) => {
      expect(boundary.acceptSessionEvent({ type: "session.updated", session: payload.session })).toBe(true);
    });
    ({ boundary } = harness([source], { send }));
    const token = await boundary.prepareForResponse(() => true);
    token.assertCurrent(); token.dispose(); expect(send).toHaveBeenCalledOnce();
  });

  it("a send exception still rejects when a synchronous fake echo arrived first", async () => {
    const source = snapshot(); let boundary!: RealtimeInstructionsBoundary;
    ({ boundary } = harness([source], { send: payload => {
      boundary.acceptSessionEvent({ type: "session.updated", session: payload.session });
      throw new Error("private transport body");
    } }));
    await expect(boundary.prepareForResponse(() => true)).rejects.toMatchObject({ code: "failed", message: "Realtime instructions failed." });
    expect(source.dispose).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it("settles an asynchronously failed update and leaves the next update available", async () => {
    const old = snapshot("虚构旧资料"), next = snapshot("虚构新资料");
    const updates: Record<string, unknown>[] = [], failSends: (() => void)[] = [];
    const { boundary } = harness([old, next], { send: (payload, onFailure?: () => void) => {
      updates.push(payload);
      if (onFailure) failSends.push(onFailure);
    } });
    const first = boundary.prepareForResponse(() => true).catch(error => error);
    await flush();
    expect(failSends).toHaveLength(1);
    failSends[0]();
    expect(await first).toMatchObject({ code: "failed", message: "Realtime instructions failed." });
    expect(old.dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    const second = boundary.prepareForResponse(() => true);
    await flush();
    expect(updates).toHaveLength(2);
    failSends[0]();
    expect(boundary.acceptSessionEvent({ type: "session.updated", session: updates[1].session })).toBe(true);
    failSends[1]();
    const token = await second;
    expect(token.instructions).toBe(next.instructions);
    token.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["connection", "response"])("denies a stale %s before preparing any source", async kind => {
    const { boundary, socket, prepare } = harness([snapshot()], { isCurrent: () => kind !== "connection" });
    await expect(boundary.prepareForResponse(() => kind !== "response")).rejects.toMatchObject({ code: "stale" });
    expect(prepare).not.toHaveBeenCalled(); expect(socket.sent).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["connection", "response", "source", "expiry"])("rechecks %s after the disclosure audit", async kind => {
    let current = true; const gate = deferred<void>(); const source = snapshot(undefined, Date.now() + 100);
    const { boundary, socket } = harness([source], {
      isCurrent: () => kind !== "connection" || current, audit: async () => gate.promise
    });
    const pending = boundary.prepareForResponse(() => kind !== "response" || current).catch(error => error);
    await flush(); expect(source.assertCurrent).toHaveBeenCalledOnce();
    if (kind === "source") source.assertCurrent.mockImplementation(() => { throw new Error("synthetic private source text"); });
    else if (kind === "expiry") vi.setSystemTime(Date.now() + 100);
    else current = false;
    gate.resolve();
    expect(await pending).toMatchObject({ code: "stale" }); expect(socket.sent).toEqual([]);
    expect(source.dispose).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("denies an expired or invalid deadline %s", async deadline => {
    const source = snapshot(undefined, deadline); const { boundary, socket } = harness([source]);
    await expect(boundary.prepareForResponse(() => true)).rejects.toMatchObject({ code: "stale" });
    expect(socket.sent).toEqual([]); expect(source.dispose).toHaveBeenCalledOnce();
  });

  it("denies a source rejected before the audit, without exposing its reason", async () => {
    const source = snapshot(); source.assertCurrent.mockImplementation(() => { throw new Error("private camera text"); });
    const audit = vi.fn(async () => undefined); const { boundary, socket } = harness([source], { audit });
    const error = await boundary.prepareForResponse(() => true).catch(error => error);
    expect(error).toMatchObject({ code: "stale", message: "Realtime instructions stale." });
    expect(audit).not.toHaveBeenCalled(); expect(socket.sent).toEqual([]); expect(source.dispose).toHaveBeenCalledOnce();
  });

  it("rejects an echo after TTL expiry and a token that expires between ACK and response.create", async () => {
    const first = snapshot(undefined, Date.now() + 10); const second = snapshot(undefined, Date.now() + 20);
    const { boundary, socket } = harness([first, second]);
    const rejected = boundary.prepareForResponse(() => true).catch(error => error);
    await flush(); vi.setSystemTime(Date.now() + 10); expect(socket.echo(boundary)).toBe(true);
    expect(await rejected).toMatchObject({ code: "stale" }); expect(first.dispose).toHaveBeenCalledOnce();
    const pending = boundary.prepareForResponse(() => true); await flush(); socket.echo(boundary);
    const token = await pending; vi.setSystemTime(Date.now() + 10);
    expect(() => token.assertCurrent()).toThrow(RealtimeInstructionsBoundaryError); token.dispose();
    expect(socket.sent.every(event => event.type === "session.update")).toBe(true);
  });

  it.each(["connection", "response", "source"])("rechecks %s while the ACK is pending and again in the returned token", async kind => {
    let current = true; const source = snapshot();
    const { boundary, socket } = harness([source], { isCurrent: () => kind !== "connection" || current });
    const pending = boundary.prepareForResponse(() => kind !== "response" || current);
    await flush(); socket.echo(boundary); const token = await pending;
    if (kind === "source") source.assertCurrent.mockImplementation(() => { throw new Error("private policy change"); });
    else current = false;
    expect(() => token.assertCurrent()).toThrow(RealtimeInstructionsBoundaryError); token.dispose();
    const next = snapshot(); const other = harness([next], { isCurrent: () => kind !== "connection" || current });
    current = true;
    const rejected = other.boundary.prepareForResponse(() => kind !== "response" || current).catch(error => error);
    await flush();
    if (kind === "source") next.assertCurrent.mockImplementation(() => { throw new Error("private policy change"); });
    else current = false;
    other.socket.echo(other.boundary); expect(await rejected).toMatchObject({ code: "stale" });
    expect(next.dispose).toHaveBeenCalledOnce();
  });

  it("serializes fresh preparations, makes same-content ACKs unique and invalidates older handed-out tokens", async () => {
    const first = snapshot(); const second = snapshot(); const { boundary, socket, prepare } = harness([first, second]);
    const one = boundary.prepareForResponse(() => true); const two = boundary.prepareForResponse(() => true);
    await flush(); expect(prepare).toHaveBeenCalledOnce(); expect(socket.sent).toHaveLength(1);
    socket.echo(boundary, 0); const firstToken = await one; await flush();
    expect(prepare).toHaveBeenCalledTimes(2); expect(socket.sent).toHaveLength(2);
    expect(socket.sent[0].event_id).not.toBe(socket.sent[1].event_id);
    expect(socket.echo(boundary, 0)).toBe(false);
    expect(() => firstToken.assertCurrent()).toThrow(RealtimeInstructionsBoundaryError);
    socket.echo(boundary, 1); const secondToken = await two; secondToken.assertCurrent();
    firstToken.dispose(); secondToken.dispose();
    expect(first.dispose).toHaveBeenCalledOnce(); expect(second.dispose).toHaveBeenCalledOnce();
  });

  it("times out at the default five seconds, ignores late ACK and permits a fresh retry", async () => {
    const first = snapshot(); const second = snapshot(); const { boundary, socket } = harness([first, second]);
    const pending = boundary.prepareForResponse(() => true).catch(error => error); await flush();
    await vi.advanceTimersByTimeAsync(4_999); expect(first.dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(await pending).toMatchObject({ code: "timeout" });
    expect(first.dispose).toHaveBeenCalledOnce(); expect(socket.echo(boundary)).toBe(false); expect(vi.getTimerCount()).toBe(0);
    const retry = boundary.prepareForResponse(() => true); await flush(); socket.echo(boundary);
    (await retry).dispose(); expect(second.dispose).toHaveBeenCalledOnce();
  });

  it("uses a bounded custom timeout and disposes a prepare result that arrives after timeout", async () => {
    const source = snapshot(); const gate = deferred<RealtimeInstructionsSnapshot>(); const prepare = vi.fn(() => gate.promise);
    const { boundary, socket } = harness([], { prepare, timeoutMs: 40 });
    const pending = boundary.prepareForResponse(() => true).catch(error => error); await flush();
    await vi.advanceTimersByTimeAsync(40); expect(await pending).toMatchObject({ code: "timeout" });
    gate.resolve(source); await flush(); expect(source.dispose).toHaveBeenCalledOnce();
    expect(socket.sent).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["send", "audit", "prepare"])("normalizes %s failures without leaking prompt or provider error bodies", async failure => {
    const source = snapshot(); const reject = () => { throw new Error("private screenshot and provider body"); };
    const extra: Partial<RealtimeInstructionsBoundaryOptions> = failure === "send" ? { send: reject }
      : failure === "audit" ? { audit: async () => reject() } : { prepare: async () => reject() };
    const { boundary } = harness([source], extra);
    await expect(boundary.prepareForResponse(() => true)).rejects.toMatchObject({ code: "failed", message: "Realtime instructions failed." });
    expect(source.dispose).toHaveBeenCalledTimes(failure === "prepare" ? 0 : 1); expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores unrelated response/old update errors and rejects its own update error with a fixed code", async () => {
    const source = snapshot(); const { boundary, socket } = harness([source]);
    const pending = boundary.prepareForResponse(() => true).catch(error => error); await flush();
    expect(boundary.acceptSessionEvent({ type: "error", response_id: "another-response", error: { message: "private text" } })).toBe(false);
    expect(boundary.acceptSessionEvent({ type: "error", response: { id: "another-response" } })).toBe(false);
    expect(boundary.acceptSessionEvent({ type: "error", error: { event_id: "old-update", message: "private text" } })).toBe(false);
    expect(boundary.acceptSessionEvent({ type: "error", error: { event_id: socket.sent[0].event_id, message: "private text" } })).toBe(true);
    expect(await pending).toMatchObject({ code: "failed", message: "Realtime instructions failed." });
    expect(source.dispose).toHaveBeenCalledOnce(); expect(socket.echo(boundary)).toBe(false);
  });

  it("cancel rejects pending and queued work, disposes late prepare, and never sends", async () => {
    const source = snapshot(); const gate = deferred<RealtimeInstructionsSnapshot>(); const prepare = vi.fn(() => gate.promise);
    const { boundary, socket } = harness([], { prepare });
    const one = boundary.prepareForResponse(() => true).catch(error => error);
    const two = boundary.prepareForResponse(() => true).catch(error => error);
    await flush(); boundary.cancel(); boundary.cancel(); expect(vi.getTimerCount()).toBe(0);
    expect(await one).toMatchObject({ code: "cancelled" }); expect(await two).toMatchObject({ code: "cancelled" });
    gate.resolve(source); await flush();
    expect(source.dispose).toHaveBeenCalledOnce(); expect(prepare).toHaveBeenCalledOnce(); expect(socket.sent).toEqual([]);
  });

  it("cancel during audit disposes the prepared source and blocks a late audit completion", async () => {
    const source = snapshot(); const gate = deferred<void>(); const { boundary, socket } = harness([source], { audit: () => gate.promise });
    const pending = boundary.prepareForResponse(() => true).catch(error => error); await flush(); boundary.cancel();
    expect(await pending).toMatchObject({ code: "cancelled" }); expect(source.dispose).toHaveBeenCalledOnce();
    gate.resolve(); await flush(); expect(socket.sent).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });

  it("cancel clears handshake, expiry and handed-out tokens, even when source disposal throws", async () => {
    const source = snapshot(undefined, Date.now() + 100); source.dispose.mockImplementation(() => { throw new Error("private cleanup"); });
    const next = snapshot(); const { boundary, socket } = harness([source, next]);
    const one = boundary.prepareForResponse(() => true); await flush(); socket.echo(boundary); const token = await one;
    const two = boundary.prepareForResponse(() => true).catch(error => error); await flush(); boundary.cancel();
    expect(await two).toMatchObject({ code: "cancelled" }); expect(vi.getTimerCount()).toBe(0);
    token.dispose(); expect(source.dispose).toHaveBeenCalledOnce(); expect(next.dispose).toHaveBeenCalledOnce();
    expect(socket.echo(boundary)).toBe(false); expect(() => token.assertCurrent()).toThrow(RealtimeInstructionsBoundaryError);
  });
});

describe("Realtime instructions expiry withdrawal", () => {
  it("keeps the confirmed slot expiry timer when TTL crosses between ACK and returning a response token", async () => {
    const deadline = Date.now() + 10; const first = snapshot(undefined, deadline); const expiry = snapshot();
    const { boundary, socket, prepare } = harness([first, expiry]);
    const response = boundary.prepareForResponse(() => true).catch(error => error); await flush();
    socket.echo(boundary);
    // The ACK continuation sees current data; the following microtask sees TTL
    // expiry before the caller could obtain a token and issue response.create.
    void Promise.resolve().then(() => vi.setSystemTime(deadline));
    expect(await response).toMatchObject({ code: "stale" }); expect(first.dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1); await vi.advanceTimersByTimeAsync(10);
    expect(prepare).toHaveBeenCalledTimes(2); expect(socket.sent).toHaveLength(2);
    expect(socket.sent[1].session.instructions).not.toContain("合成视觉摘要");
    socket.echo(boundary); await flush(); expect(expiry.dispose).toHaveBeenCalledOnce();
  });

  it("withdraws only to current base instructions at TTL even after the caller disposed its response token", async () => {
    const first = snapshot(undefined, Date.now() + 100); const fresh = snapshot("固定规则\n新的合成视觉", Date.now() + 1_000);
    fresh.baseInstructions = "最新固定规则";
    const { boundary, socket, prepare } = harness([first, fresh]);
    const response = boundary.prepareForResponse(() => true); await flush(); socket.echo(boundary); (await response).dispose();
    expect(vi.getTimerCount()).toBe(1); await vi.advanceTimersByTimeAsync(100);
    expect(prepare).toHaveBeenCalledTimes(2); expect(socket.sent).toHaveLength(2);
    expect(socket.sent[1].session.instructions).toContain(fresh.baseInstructions);
    expect(socket.sent[1].session.instructions).not.toContain("新的合成视觉");
    expect(Object.keys(socket.sent[1].session)).toEqual(["instructions"]);
    socket.echo(boundary); await flush(); expect(fresh.dispose).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    expect(socket.sent.map(event => event.type)).toEqual(["session.update", "session.update"]);
    expect(socket.close).not.toHaveBeenCalled(); expect(socket.stopPlayback).not.toHaveBeenCalled();
  });

  it("expiry failure is contained and a later response must prepare/confirm a fresh snapshot", async () => {
    const first = snapshot(undefined, Date.now() + 10); const expiry = snapshot(); const retry = snapshot("固定规则\n后续视觉");
    const { boundary, socket, prepare } = harness([first, expiry, retry], { timeoutMs: 50 });
    const initial = boundary.prepareForResponse(() => true); await flush(); socket.echo(boundary); (await initial).dispose();
    await vi.advanceTimersByTimeAsync(10); expect(socket.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(50); expect(expiry.dispose).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    expect(socket.echo(boundary)).toBe(false); expect(socket.close).not.toHaveBeenCalled(); expect(socket.stopPlayback).not.toHaveBeenCalled();
    const subsequent = boundary.prepareForResponse(() => true); await flush(); expect(prepare).toHaveBeenCalledTimes(3);
    expect(socket.sent).toHaveLength(3); expect(socket.echo(boundary, 1)).toBe(false); socket.echo(boundary, 2);
    const token = await subsequent; token.assertCurrent(); token.dispose();
  });

  it("serializes a TTL withdrawal ahead of a new response, and the response uses its own fresh echo", async () => {
    const first = snapshot(undefined, Date.now() + 10); const expiry = snapshot(); const next = snapshot("固定规则\n下一回应视觉");
    const { boundary, socket, prepare } = harness([first, expiry, next]);
    const initial = boundary.prepareForResponse(() => true); await flush(); socket.echo(boundary); (await initial).dispose();
    await vi.advanceTimersByTimeAsync(10); const response = boundary.prepareForResponse(() => true); await flush();
    expect(prepare).toHaveBeenCalledTimes(2); expect(socket.sent).toHaveLength(2);
    socket.echo(boundary, 1); await flush(); expect(prepare).toHaveBeenCalledTimes(3); expect(socket.sent).toHaveLength(3);
    expect(socket.echo(boundary, 1)).toBe(false); socket.echo(boundary, 2); (await response).dispose();
    expect(socket.sent[2].session.instructions).toContain("下一回应视觉");
  });

  it("does not let an old timer queued during a new handshake overwrite the newer confirmed snapshot", async () => {
    const first = snapshot(undefined, Date.now() + 10); const next = snapshot("固定规则\n较新视觉", Date.now() + 100); const expiry = snapshot();
    const { boundary, socket, prepare } = harness([first, next, expiry]);
    const initial = boundary.prepareForResponse(() => true); await flush(); socket.echo(boundary); (await initial).dispose();
    const response = boundary.prepareForResponse(() => true); await flush(); await vi.advanceTimersByTimeAsync(10);
    expect(prepare).toHaveBeenCalledTimes(2); socket.echo(boundary, 1); (await response).dispose(); await flush();
    expect(prepare).toHaveBeenCalledTimes(2); expect(socket.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(89); expect(socket.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); expect(prepare).toHaveBeenCalledTimes(3); expect(socket.sent).toHaveLength(3);
    socket.echo(boundary, 2); await flush(); expect(expiry.dispose).toHaveBeenCalledOnce();
  });

  it("still withdraws the old confirmed context when a newer response update fails", async () => {
    const first = snapshot(undefined, Date.now() + 10); const failed = snapshot(); const expiry = snapshot();
    const { boundary, socket } = harness([first, failed, expiry], { timeoutMs: 20 });
    const initial = boundary.prepareForResponse(() => true); await flush(); socket.echo(boundary); (await initial).dispose();
    const pending = boundary.prepareForResponse(() => true).catch(error => error); await flush();
    await vi.advanceTimersByTimeAsync(10); await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toMatchObject({ code: "timeout" }); expect(socket.sent).toHaveLength(3);
    expect(socket.sent[2].session.instructions).not.toContain("合成视觉摘要"); socket.echo(boundary, 2); await flush();
    expect(expiry.dispose).toHaveBeenCalledOnce();
  });
});
