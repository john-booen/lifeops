import { describe, expect, it } from "vitest";
import {
  activeObservations,
  appendObservation,
  createObservation,
  emptyObservationDocument,
  pruneExpiredObservations,
  removeObservationSource
} from "../src/observationStore";

describe("short-lived observations", () => {
  it("never represents raw images as persisted data", () => {
    const observation = createObservation({
      source: "camera",
      kind: "fatigue_signal",
      summary: "可能存在疲劳迹象",
      observedAt: "2026-07-28T10:00:00.000Z",
      ttlMs: 60_000,
      evidence: { eyeClosure: 0.7 }
    });

    expect(observation.rawPersisted).toBe(false);
    expect(observation.expiresAt).toBe("2026-07-28T10:01:00.000Z");
  });

  it("drops expired observations and clears one sensor independently", () => {
    const camera = createObservation({
      source: "camera",
      kind: "presence",
      summary: "present",
      observedAt: "2026-07-28T10:00:00.000Z",
      ttlMs: 60_000
    });
    const desktop = createObservation({
      source: "desktop",
      kind: "work_context",
      summary: "writing",
      observedAt: "2026-07-28T10:02:00.000Z",
      ttlMs: 60_000
    });
    let document = appendObservation(
      emptyObservationDocument(),
      camera,
      new Date("2026-07-28T10:00:00.000Z")
    );
    document = appendObservation(document, desktop, new Date("2026-07-28T10:02:00.000Z"));

    expect(activeObservations(document, new Date("2026-07-28T10:02:30.000Z"))).toEqual([desktop]);
    expect(removeObservationSource(document, "desktop").observations).toEqual([]);
  });

  it("physically prunes expired and invalid observations from the document", () => {
    const expired = createObservation({
      source: "camera",
      kind: "expired",
      summary: "old",
      observedAt: "2026-07-28T10:00:00.000Z",
      ttlMs: 1_000
    });
    const active = createObservation({
      source: "desktop",
      kind: "active",
      summary: "current",
      observedAt: "2026-07-28T10:02:00.000Z",
      ttlMs: 60_000
    });
    const document = {
      version: 1 as const,
      updatedAt: "2026-07-28T10:02:00.000Z",
      observations: [expired, { ...expired, id: "invalid", expiresAt: "invalid" }, active]
    };

    expect(pruneExpiredObservations(document, new Date("2026-07-28T10:02:30.000Z")).observations).toEqual([active]);
  });
  it("keeps an unchanged observation document when the source to clear is absent", () => {
    const document = appendObservation(emptyObservationDocument(), createObservation({
      source: "desktop", kind: "work_context", summary: "fictional report",
      observedAt: "2026-10-22T08:00:00.000Z", ttlMs: 60_000
    }), new Date("2026-10-22T08:00:00.000Z"));
    expect(removeObservationSource(document, "camera", new Date("2026-10-22T08:00:01.000Z"))).toBe(document);
  });
});
