import { describe, expect, it } from "vitest";
import { LifeOpsEventBus } from "../src/lifeOpsEventBus";

describe("LifeOps event bus", () => {
  it("delivers typed events without allowing one observer to block another", async () => {
    const bus = new LifeOpsEventBus();
    const received: string[] = [];
    bus.subscribe(() => {
      throw new Error("observer failed");
    });
    bus.subscribe((event) => {
      received.push(event.type);
    });

    const event = bus.publish({
      type: "vault.modified",
      source: "vault",
      occurredAt: "2026-07-28T10:00:00.000Z",
      payload: { path: "日记.md" }
    });
    await Promise.resolve();

    expect(event.id).toMatch(/^event_/);
    expect(received).toEqual(["vault.modified"]);
  });

  it("absorbs asynchronous observer rejection", async () => {
    const bus = new LifeOpsEventBus();
    const received: string[] = [];
    bus.subscribe(async () => {
      throw new Error("async observer failed");
    });
    bus.subscribe((event) => {
      received.push(event.type);
    });

    bus.publish({
      type: "task.changed",
      source: "runtime",
      payload: { taskId: "task-1" }
    });
    await Promise.resolve();

    expect(received).toEqual(["task.changed"]);
  });

  it("supports unsubscribe and shutdown", async () => {
    const bus = new LifeOpsEventBus();
    let calls = 0;
    const unsubscribe = bus.subscribe(() => {
      calls += 1;
    });
    unsubscribe();
    bus.publish({ type: "task.changed", source: "runtime", payload: {} });
    bus.clear();
    await Promise.resolve();

    expect(calls).toBe(0);
  });
});
