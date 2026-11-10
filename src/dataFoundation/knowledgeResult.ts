export interface KnowledgeResult {
  sourceId: string;
  path: string;
  title: string;
  category: string;
  excerpt: string;
  mtime: number;
  score: number;
  reasons: string[];
  contentHash?: string;
}

export function knowledgeResultsToMarkdown(results: KnowledgeResult[]): string {
  return results.map((result) => [
    `### ${result.path}`,
    `- sourceId: ${result.sourceId}`,
    `- title: ${result.title}`,
    `- category: ${result.category}`,
    `- mtime: ${result.mtime}`,
    result.contentHash ? `- contentHash: ${result.contentHash}` : "",
    `- score: ${result.score.toFixed(2)}`,
    `- reasons: ${result.reasons.join(", ") || "matched index"}`,
    "",
    result.excerpt.trim()
  ].filter(Boolean).join("\n")).join("\n\n");
}

export function hasSourceGrounding(result: KnowledgeResult): boolean {
  return Boolean(
    result.sourceId.trim()
      && result.path.trim()
      && Number.isFinite(result.mtime)
      && result.excerpt.trim()
  );
}
