import { describe, expect, it, vi } from "vitest";
import { createHomeMotion, type HomeMotionGate } from "../src/panel/neuralHomeMotion";

function harness(paint?: () => void) {
  let next = 0;
  const callbacks = new Map<number, (time: number) => void>();
  const request = vi.fn((callback: (time: number) => void) => { callbacks.set(++next, callback); return next; });
  const cancel = vi.fn((id: number) => { callbacks.delete(id); });
  const start = vi.fn(), stop = vi.fn();
  const gate: HomeMotionGate = { active: false, visible: true, focused: true, intersecting: true, reduced: false, paused: false };
  const motion = createHomeMotion({ request, cancel, start, stop, paint: paint ?? vi.fn() }, gate);
  return { motion, callbacks, request, cancel, start, stop,
    fire() { const [id, callback] = callbacks.entries().next().value!; callbacks.delete(id); callback(100); } };
}

describe("home decorative loop ownership", () => {
  it("starts only when all gates permit, and refreshes keep one loop", () => {
    const h = harness();
    expect(h.callbacks.size).toBe(0);
    h.motion.setGate({ active: true });
    h.motion.setGate({ active: true }); h.motion.setGate({ visible: true });
    expect(h.start).toHaveBeenCalledTimes(1); expect(h.callbacks.size).toBe(1);
    h.fire(); expect(h.callbacks.size).toBe(1);
    h.motion.dispose(); expect(h.callbacks.size).toBe(0); expect(h.stop).toHaveBeenCalledTimes(1);
  });
  it.each(["active", "visible", "focused", "intersecting"] as const)("stops and releases media when %s becomes false", key => {
    const h = harness(); h.motion.setGate({ active: true });
    h.motion.setGate({ [key]: false });
    expect(h.motion.snapshot().running).toBe(false); expect(h.callbacks.size).toBe(0);
    expect(h.stop).toHaveBeenCalledTimes(1);
    h.motion.setGate({ [key]: true }); expect(h.callbacks.size).toBe(1);
    h.motion.dispose();
  });
  it.each(["reduced", "paused"] as const)("honors %s before start and while running", key => {
    const h = harness(); h.motion.setGate({ active: true, [key]: true });
    expect(h.start).not.toHaveBeenCalled();
    h.motion.setGate({ [key]: false }); expect(h.callbacks.size).toBe(1);
    h.motion.setGate({ [key]: true }); expect(h.callbacks.size).toBe(0);
    h.motion.dispose();
  });
  it("late cancelled callbacks cannot clear or extend a newer loop", () => {
    const h = harness(); h.motion.setGate({ active: true });
    const late = h.callbacks.values().next().value!;
    h.motion.setGate({ focused: false }); h.motion.setGate({ focused: true });
    const pending = [...h.callbacks.keys()]; late(10);
    expect([...h.callbacks.keys()]).toEqual(pending); expect(h.request).toHaveBeenCalledTimes(2);
    h.fire(); expect(h.callbacks.size).toBe(1); h.motion.dispose();
  });
  it("a stop inside paint never reschedules", () => {
    const h = harness(() => h.motion.setGate({ active: false }));
    h.motion.setGate({ active: true }); h.fire();
    expect(h.callbacks.size).toBe(0); expect(h.motion.snapshot().running).toBe(false);
    h.motion.dispose(); expect(h.stop).toHaveBeenCalledTimes(1);
  });
  it("a paint error releases media and remains a static fallback", () => {
    const h = harness(() => { throw Error("paint failed"); });
    h.motion.setGate({ active: true }); h.fire(); h.motion.setGate({ active: true });
    expect(h.callbacks.size).toBe(0); expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.motion.snapshot().error).toBeTruthy(); h.motion.dispose();
  });
  it("partial start failure still invokes owned cleanup", () => {
    const stop = vi.fn();
    const motion = createHomeMotion({ request: vi.fn(), cancel: vi.fn(), paint: vi.fn(), stop,
      start() { throw Error("decoder failed"); } }, { active: false, visible: true, focused: true, intersecting: true, reduced: false, paused: false });
    motion.setGate({ active: true });
    expect(stop).toHaveBeenCalledOnce(); expect(motion.snapshot().pendingFrame).toBe(false);
    expect(motion.snapshot().error).toBeTruthy(); motion.dispose();
  });
  it("dispose is idempotent and no later gate can restart it", () => {
    const h = harness(); h.motion.setGate({ active: true });
    const late = h.callbacks.values().next().value!;
    h.motion.dispose(); h.motion.dispose(); h.motion.setGate({ active: true }); late(200);
    expect(h.start).toHaveBeenCalledOnce(); expect(h.stop).toHaveBeenCalledOnce();
    expect(h.callbacks.size).toBe(0); expect(h.motion.snapshot().disposed).toBe(true);
  });
  it("reports incomplete cleanup and retries the owned cleanup during disposal", () => {
    const stop = vi.fn().mockImplementationOnce(() => { throw Error("pause failed"); });
    const motion = createHomeMotion({ request: () => 1, cancel: vi.fn(), paint: vi.fn(), start: vi.fn(), stop },
      { active: false, visible: true, focused: true, intersecting: true, reduced: false, paused: false });
    motion.setGate({ active: true }); motion.setGate({ active: false });
    expect(motion.snapshot()).toMatchObject({ cleanupNeeded: true, running: false });
    expect(motion.snapshot().error).toBeTruthy();
    motion.dispose(); expect(stop).toHaveBeenCalledTimes(2); expect(motion.snapshot().cleanupNeeded).toBe(false);
  });
});
