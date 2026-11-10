import { extractKnowledgeKeywords, graphId } from "../store/settingsSlice";
import type {
  KnowledgeChunk,
  KnowledgeGraph,
  KnowledgeGraphEdge,
  KnowledgeGraphNode,
  VaultIndexEntry
} from "../store/settingsSlice";

export interface KnowledgeGraphContribution {
  nodes: readonly KnowledgeGraphNode[];
  edges: readonly KnowledgeGraphEdge[];
}

const edgeWeights: Record<KnowledgeGraphEdge["type"], number> = {
  contains: 1,
  mentions: 1,
  related: 0.5
};
const compareText = (left: string, right: string): number =>
  left.localeCompare(right, "zh-CN") || (left < right ? -1 : left > right ? 1 : 0);

/** One note contributes each relation once, regardless of its chunk count. */
export function createKnowledgeGraphSource(
  entry: Pick<VaultIndexEntry, "path" | "title" | "category" | "summary">,
  content: string,
  chunks: readonly Pick<KnowledgeChunk, "keywords">[]
): KnowledgeGraphContribution {
  const noteId = graphId("note", entry.path);
  const categoryId = graphId("category", entry.category);
  const nodes = new Map<string, KnowledgeGraphNode>([
    [noteId, { id: noteId, label: entry.title, type: "note", path: entry.path, category: entry.category, weight: 1 }],
    [categoryId, { id: categoryId, label: entry.category, type: "category", category: entry.category, weight: 1 }]
  ]);
  const edges: KnowledgeGraphEdge[] = [
    { source: categoryId, target: noteId, type: "contains", weight: 1 }
  ];
  const addConcept = (keyword: string, type: "mentions" | "related"): void => {
    const id = graphId("concept", keyword);
    nodes.set(id, { id, label: keyword, type: "concept", weight: 1 });
    edges.push({ source: noteId, target: id, type, weight: edgeWeights[type] });
  };
  for (const keyword of extractKnowledgeKeywords(`${entry.title}\n${entry.summary}\n${content}`).slice(0, 16)) {
    addConcept(keyword, "mentions");
  }
  const related = new Set<string>();
  for (const chunk of chunks) for (const keyword of chunk.keywords.slice(0, 8)) related.add(keyword);
  for (const keyword of related) addConcept(keyword, "related");
  return { nodes: [...nodes.values()], edges };
}

/** Merge once for a full rebuild; incremental updates merge only the in-memory graph. */
export function mergeKnowledgeGraphSources(sources: Iterable<KnowledgeGraphContribution>): KnowledgeGraph {
  const nodes = new Map<string, KnowledgeGraphNode>();
  const edges = new Map<string, KnowledgeGraphEdge>();
  for (const source of sources) {
    for (const node of source.nodes) nodes.set(node.id, { ...node, weight: 1 });
    for (const edge of source.edges) {
      edges.set(JSON.stringify([edge.source, edge.target, edge.type]), { ...edge, weight: edgeWeights[edge.type] });
    }
  }
  // Older full rebuilds could leave a related concept edge without its node.
  // Its canonical id contains the label, so this repair needs no source reread.
  for (const edge of edges.values()) {
    const id = edge.target;
    if (edge.type !== "related" || nodes.get(edge.source)?.type !== "note"
      || nodes.has(id) || !id.startsWith("concept:")) continue;
    try {
      const label = decodeURIComponent(id.slice("concept:".length));
      if (label && graphId("concept", label) === id) nodes.set(id, { id, label, type: "concept", weight: 1 });
    } catch { /* A malformed legacy id cannot supply a valid endpoint. */ }
  }
  const validEdges = [...edges.values()].filter(edge => nodes.has(edge.source) && nodes.has(edge.target));
  const referenced = new Set(validEdges.flatMap(edge => [edge.source, edge.target]));
  return {
    generatedAt: new Date().toISOString(),
    nodes: [...nodes.values()]
      .filter(node => node.type === "note" || referenced.has(node.id))
      .sort((left, right) => compareText(left.label, right.label) || compareText(left.id, right.id)),
    edges: validEdges.sort((left, right) => right.weight - left.weight
      || compareText(left.source, right.source) || compareText(left.target, right.target)
      || compareText(left.type, right.type))
  };
}

function withoutSource(graph: KnowledgeGraph, path: string): KnowledgeGraphContribution {
  const noteId = graphId("note", path);
  return {
    nodes: graph.nodes.filter(node => node.id !== noteId),
    edges: graph.edges.filter(edge => edge.source !== noteId && edge.target !== noteId)
  };
}

export function upsertKnowledgeGraphSource(
  graph: KnowledgeGraph,
  entry: Pick<VaultIndexEntry, "path" | "title" | "category" | "summary">,
  content: string,
  chunks: readonly Pick<KnowledgeChunk, "keywords">[]
): KnowledgeGraph {
  return mergeKnowledgeGraphSources([withoutSource(graph, entry.path), createKnowledgeGraphSource(entry, content, chunks)]);
}

export function removeKnowledgeGraphSource(graph: KnowledgeGraph, path: string): KnowledgeGraph {
  return mergeKnowledgeGraphSources([withoutSource(graph, path)]);
}
