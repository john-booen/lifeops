import type { AgentConversationMessage } from "./types";
import { createVaultApi, type VaultFileAdapter, type VaultUserContext } from "./vaultApi";
import type { FolderSettings } from "./types";

const DEFAULT_TOTAL_CONTEXT_CHARS = 60_000;
const DEFAULT_BASE_CONTEXT_CHARS = 42_000;
const DEFAULT_RETRIEVAL_CONTEXT_CHARS = 14_000;
const DEFAULT_KNOWLEDGE_CONTEXT_CHARS = 22_000;
const DEFAULT_HISTORY_MESSAGES = 10;
const DEFAULT_HISTORY_MESSAGE_CHARS = 1_200;

const SECTION_BUDGETS: Record<string, number> = {
  "目标与项目接续": 6000,
  "Context Policy": 1_200,
  Daily: 4_000,
  "Recent Daily Notes": 4_000,
  "Vault Facts": 1_500,
  Tasks: 5_000,
  Habits: 3_000,
  Health: 1_800,
  "Recent Health Notes": 1_800,
  Trades: 2_500,
  "Recent Trading Reviews": 3_500,
  "Trading Models": 4_000,
  Goals: 4_000,
  "Recent Ideas": 2_000,
  "Recent Outputs": 2_000,
  "Vault Index Summary": 2_500,
  "Recent Agent Conversations": 2_500,
  "Long-term Memory": 7_000,
  "Accountability Reviews": 1_200
};

export interface AgentContextBundleInput {
  baseContext: string;
  retrievalContext: string;
  knowledgeContext?: string;
}

export interface AgentUserContextInput {
  adapter: VaultFileAdapter;
  folders?: FolderSettings;
  date?: string | Date;
  recentDays?: number;
}

export async function getUserContext(input: AgentUserContextInput): Promise<VaultUserContext> {
  const api = createVaultApi(input.adapter, { folders: input.folders });
  return api.getUserContext({
    date: input.date,
    recentDays: input.recentDays
  });
}

export function buildAgentContextBundle(input: AgentContextBundleInput): string {
  const baseContext = trimMarkdownSections(input.baseContext, DEFAULT_BASE_CONTEXT_CHARS);
  const knowledgeContext = truncateContext(input.knowledgeContext ?? "", DEFAULT_KNOWLEDGE_CONTEXT_CHARS);
  const retrievalContext = truncateContext(input.retrievalContext, DEFAULT_RETRIEVAL_CONTEXT_CHARS);
  const bundle = [
    baseContext || "# LifeOps Context\n\n(当前上下文加载失败，已降级为最小上下文。)",
    knowledgeContext ? ["# On-demand Knowledge Context", knowledgeContext].join("\n\n") : "",
    retrievalContext ? ["# Retrieved Vault Notes", retrievalContext].join("\n\n") : ""
  ].filter(Boolean).join("\n\n");
  return truncateContext(bundle, DEFAULT_TOTAL_CONTEXT_CHARS);
}

export function normalizeAgentHistory(
  history: AgentConversationMessage[],
  maxMessages = DEFAULT_HISTORY_MESSAGES,
  maxCharsPerMessage = DEFAULT_HISTORY_MESSAGE_CHARS
): AgentConversationMessage[] {
  return history
    .filter((message) => message.content.trim())
    .slice(-maxMessages)
    .map((message) => ({
      role: message.role,
      content: truncateContext(message.content, maxCharsPerMessage)
    }));
}

export function truncateContext(value: string, maxChars: number): string {
  const normalized = value.replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized || normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()}\n\n...[truncated ${normalized.length - maxChars} chars]`;
}

function trimMarkdownSections(markdown: string, maxChars: number): string {
  const normalized = markdown.replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized || normalized.length <= maxChars) return normalized;

  const sections = splitMarkdownSections(normalized);
  const trimmed = sections.map((section) => {
    const budget = SECTION_BUDGETS[section.title] ?? 1_600;
    return truncateContext(section.content, budget);
  }).join("\n\n");

  return truncateContext(trimmed, maxChars);
}

function splitMarkdownSections(markdown: string): Array<{ title: string; content: string }> {
  const matches = Array.from(markdown.matchAll(/^##\s+(.+)$/gm));
  if (matches.length === 0) {
    return [{ title: "Context", content: markdown }];
  }

  const sections: Array<{ title: string; content: string }> = [];
  const first = matches[0];
  if (first.index && first.index > 0) {
    sections.push({ title: "Preamble", content: markdown.slice(0, first.index).trim() });
  }

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? markdown.length;
    sections.push({
      title: match[1].trim(),
      content: markdown.slice(start, end).trim()
    });
  }

  return sections;
}
