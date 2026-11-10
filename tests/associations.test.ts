import { describe, expect, it } from "vitest";
import { decayAssociations, normalizeAssociationNodes, reinforceAssociation, reinforceCoHits, relatedNodesFor } from "../src/associations";

describe("associations", () => {
  it("normalizes node order and ignores self-links", () => {
    expect(normalizeAssociationNodes("b", "a")).toEqual(["a", "b"]);
    expect(normalizeAssociationNodes("a", "a")).toBeNull();
  });

  it("reinforces existing edges", () => {
    let edges = reinforceAssociation([], "sleep_low", "trade_impulse", "2026-06-10.md", {
      now: "2026-06-11T00:00:00.000Z",
      increment: 0.1
    });
    edges = reinforceAssociation(edges, "trade_impulse", "sleep_low", "2026-06-11.md", {
      now: "2026-06-12T00:00:00.000Z",
      increment: 0.1
    });

    expect(edges).toHaveLength(1);
    expect(edges[0].strength).toBeCloseTo(0.3);
    expect(edges[0].evidenceCount).toBe(2);
    expect(edges[0].examples).toEqual(["2026-06-10.md", "2026-06-11.md"]);
  });

  it("reinforces co-hit pairs and returns related nodes", () => {
    const edges = reinforceCoHits([], ["a", "b", "c"], "note.md", { increment: 0.2 });

    expect(edges).toHaveLength(3);
    expect(relatedNodesFor(edges, "a")).toEqual(["b", "c"]);
  });

  it("decays weak associations", () => {
    const edges = reinforceAssociation([], "a", "b", "", { increment: 0.11 });
    const decayed = decayAssociations(edges, 0.05, 0.2);

    expect(decayed).toHaveLength(0);
  });
});
