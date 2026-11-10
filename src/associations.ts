export interface AssociationEdge {
  nodes: [string, string];
  strength: number;
  lastReinforcedAt: string;
  evidenceCount: number;
  examples: string[];
}

export interface AssociationOptions {
  now?: string;
  increment?: number;
  maxExamples?: number;
}

export function reinforceAssociation(
  edges: AssociationEdge[],
  nodeA: string,
  nodeB: string,
  example = "",
  options: AssociationOptions = {}
): AssociationEdge[] {
  const nodes = normalizeAssociationNodes(nodeA, nodeB);
  if (!nodes) return edges;

  const now = options.now ?? new Date().toISOString();
  const increment = options.increment ?? 0.08;
  const maxExamples = options.maxExamples ?? 8;
  let updated = false;

  const next = edges.map((edge) => {
    if (edge.nodes[0] !== nodes[0] || edge.nodes[1] !== nodes[1]) return edge;
    updated = true;
    return {
      ...edge,
      strength: clamp01(edge.strength + increment),
      lastReinforcedAt: now,
      evidenceCount: edge.evidenceCount + 1,
      examples: appendExample(edge.examples, example, maxExamples)
    };
  });

  if (updated) return next;
  return [
    ...next,
    {
      nodes,
      strength: clamp01(increment * 2),
      lastReinforcedAt: now,
      evidenceCount: 1,
      examples: appendExample([], example, maxExamples)
    }
  ];
}

export function reinforceCoHits(
  edges: AssociationEdge[],
  nodeIds: string[],
  example = "",
  options: AssociationOptions = {}
): AssociationEdge[] {
  const uniqueNodes = Array.from(new Set(nodeIds.map((node) => node.trim()).filter(Boolean))).sort();
  let next = edges;
  for (let outer = 0; outer < uniqueNodes.length; outer += 1) {
    for (let inner = outer + 1; inner < uniqueNodes.length; inner += 1) {
      next = reinforceAssociation(next, uniqueNodes[outer], uniqueNodes[inner], example, options);
    }
  }
  return next;
}

export function decayAssociations(
  edges: AssociationEdge[],
  amount = 0.02,
  minimumStrength = 0.2,
  now = new Date().toISOString()
): AssociationEdge[] {
  return edges
    .map((edge) => ({
      ...edge,
      strength: clamp01(edge.strength - amount),
      lastReinforcedAt: edge.lastReinforcedAt || now
    }))
    .filter((edge) => edge.strength >= minimumStrength);
}

export function relatedNodesFor(edges: AssociationEdge[], nodeId: string, minimumStrength = 0.2, limit = 5): string[] {
  return edges
    .filter((edge) => edge.strength >= minimumStrength && edge.nodes.includes(nodeId))
    .sort((a, b) => b.strength - a.strength)
    .slice(0, limit)
    .map((edge) => edge.nodes[0] === nodeId ? edge.nodes[1] : edge.nodes[0]);
}

export function normalizeAssociationNodes(nodeA: string, nodeB: string): [string, string] | null {
  const a = nodeA.trim();
  const b = nodeB.trim();
  if (!a || !b || a === b) return null;
  return a < b ? [a, b] : [b, a];
}

function appendExample(examples: string[], example: string, maxExamples: number): string[] {
  const value = example.trim();
  if (!value) return examples.slice(-maxExamples);
  return Array.from(new Set([...examples, value])).slice(-maxExamples);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
