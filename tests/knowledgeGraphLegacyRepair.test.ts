import { expect, it, vi } from "vitest";
import type { KnowledgeGraph, VaultIndexEntry } from "../src/store/settingsSlice";

vi.mock("obsidian", () => ({
  App: class {}, Notice: class {}, TFile: class {}, TFolder: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/")
}));
const { createKnowledgeGraphSource, mergeKnowledgeGraphSources, upsertKnowledgeGraphSource } =
  await import("../src/dataFoundation/knowledgeGraph");

const entry = (path: string, title: string): VaultIndexEntry => ({
  path, title, category: "ideas", tags: [], frontmatter: {}, mtime: 1, size: 1, summary: title
});
const published = (graph: KnowledgeGraph) => ({ nodes: graph.nodes, edges: graph.edges });

it("repairs the known legacy related target without materializing unrelated malformed cache edges or mutating its input", () => {
  const legacy: KnowledgeGraph = {
    generatedAt: "2026-10-27T00:00:00Z",
    nodes: [
      { id: "note:legacy.md", label: "Legacy", type: "note", path: "legacy.md", category: "ideas", weight: 1 },
      { id: "category:ideas", label: "ideas", type: "category", category: "ideas", weight: 4 }
    ],
    edges: [
      { source: "category:ideas", target: "note:legacy.md", type: "contains", weight: 1 },
      { source: "note:legacy.md", target: "concept:lateorchid", type: "related", weight: 3 },
      { source: "note:legacy.md", target: "concept:wrongkind", type: "contains", weight: 1 },
      { source: "concept:reversed", target: "note:legacy.md", type: "related", weight: 0.5 },
      { source: "note:absent.md", target: "concept:noowner", type: "related", weight: 0.5 },
      { source: "note:legacy.md", target: "concept:%broken", type: "related", weight: 0.5 }
    ]
  };
  const original = structuredClone(legacy);
  const result = upsertKnowledgeGraphSource(legacy, entry("fresh.md", "Fresh"), "Fresh field notes", []);
  expect(legacy).toEqual(original);
  expect(result.nodes.find(node => node.id === "concept:lateorchid")).toMatchObject({ label: "lateorchid", type: "concept", weight: 1 });
  expect(result.edges.find(edge => edge.target === "concept:lateorchid")).toMatchObject({ type: "related", weight: 0.5 });
  for (const id of ["concept:wrongkind", "concept:reversed", "concept:noowner", "concept:%broken"]) {
    expect(result.nodes.some(node => node.id === id)).toBe(false);
    expect(result.edges.some(edge => edge.source === id || edge.target === id)).toBe(false);
  }
  const ids = new Set(result.nodes.map(node => node.id));
  expect(result.edges.every(edge => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
  expect(result.nodes.every(node => node.weight === 1)).toBe(true);
});

it("publishes the same array order for reversed source batches and incremental replacement", () => {
  const alpha = entry("alpha.md", "Alpha"), beta = entry("beta.md", "Beta");
  const a = createKnowledgeGraphSource(alpha, "Shared orchid alpha", [{ keywords: ["orchid", "shared"] }]);
  const b = createKnowledgeGraphSource(beta, "Shared orchid beta", [{ keywords: ["shared", "orchid", "orchid"] }]);
  const inputs = structuredClone([a, b]);
  const forward = mergeKnowledgeGraphSources([a, b]);
  const backward = mergeKnowledgeGraphSources([b, a]);
  const incremental = upsertKnowledgeGraphSource(mergeKnowledgeGraphSources([b]), alpha, "Shared orchid alpha", [{ keywords: ["orchid", "shared"] }]);
  expect(published(forward)).toEqual(published(backward));
  expect(published(incremental)).toEqual(published(forward));
  expect([a, b]).toEqual(inputs);
});
