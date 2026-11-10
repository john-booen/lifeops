export type ContextPriority = "critical" | "high" | "normal" | "low";

export interface ContextBlock {
  label: string;
  content: string;
  source: string;
  generatedAt: string;
  expiresAt?: string;
  confidence?: number;
  priority: ContextPriority;
}

export interface ContextBundleOptions {
  now?: Date | string;
  includeExpired?: boolean;
  includeMetadata?: boolean;
  maxChars?: number;
}

export interface ContextBundleResult {
  blocks: ContextBlock[];
  expiredBlocks: ContextBlock[];
  markdown: string;
}

const DEFAULT_MAX_CONTEXT_CHARS = 40_000;
const PRIORITY_RANK: Record<ContextPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3
};

export function buildContextBundle(blocks: ContextBlock[], options: ContextBundleOptions = {}): ContextBundleResult {
  const now = normalizeNow(options.now);
  const expiredBlocks = blocks.filter((block) => isContextBlockExpired(block, now));
  const activeBlocks = blocks.filter((block) => options.includeExpired || !isContextBlockExpired(block, now));
  const sortedBlocks = sortContextBlocks(activeBlocks);

  return {
    blocks: sortedBlocks,
    expiredBlocks: sortContextBlocks(expiredBlocks),
    markdown: truncateContext(
      contextBlocksToMarkdown(sortedBlocks, {
        ...options,
        now
      }),
      options.maxChars ?? DEFAULT_MAX_CONTEXT_CHARS
    )
  };
}

export function contextBlocksToMarkdown(blocks: ContextBlock[], options: ContextBundleOptions = {}): string {
  const now = normalizeNow(options.now);
  const includeMetadata = options.includeMetadata ?? true;
  return blocks.map((block) => {
    const title = block.label.trim().startsWith("##") ? block.label.trim() : `## ${block.label.trim()}`;
    const metadata = includeMetadata ? contextBlockMetadata(block, now) : "";
    return [title, metadata, block.content.trim() || "(empty)"].filter(Boolean).join("\n\n");
  }).join("\n\n");
}

export function filterActiveContextBlocks(blocks: ContextBlock[], now: Date | string = new Date()): ContextBlock[] {
  const normalizedNow = normalizeNow(now);
  return blocks.filter((block) => !isContextBlockExpired(block, normalizedNow));
}

export function sortContextBlocks(blocks: ContextBlock[]): ContextBlock[] {
  return [...blocks].sort((a, b) => {
    const priorityDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (priorityDiff !== 0) return priorityDiff;
    const confidenceDiff = (b.confidence ?? 0) - (a.confidence ?? 0);
    if (confidenceDiff !== 0) return confidenceDiff;
    return Date.parse(b.generatedAt) - Date.parse(a.generatedAt);
  });
}

export function isContextBlockExpired(block: Pick<ContextBlock, "expiresAt">, now: Date | string = new Date()): boolean {
  if (!block.expiresAt) return false;
  const expiresAt = Date.parse(block.expiresAt);
  if (Number.isNaN(expiresAt)) return false;
  return expiresAt <= normalizeNow(now).getTime();
}

function contextBlockMetadata(block: ContextBlock, now: Date): string {
  const items = [
    `source: ${block.source}`,
    `generatedAt: ${block.generatedAt}`,
    block.expiresAt ? `expiresAt: ${block.expiresAt}${isContextBlockExpired(block, now) ? " (expired)" : ""}` : "",
    typeof block.confidence === "number" ? `confidence: ${Math.max(0, Math.min(1, block.confidence)).toFixed(2)}` : "",
    `priority: ${block.priority}`
  ].filter(Boolean);
  return `> ${items.join(" | ")}`;
}

function normalizeNow(now: Date | string | undefined): Date {
  if (!now) return new Date();
  return now instanceof Date ? now : new Date(now);
}

function truncateContext(value: string, maxChars: number): string {
  const normalized = value.replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized || normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()}\n\n...[truncated ${normalized.length - maxChars} chars]`;
}
