import { providerAuditIdentifier } from "./providerRun";

export function normalizeExcludedVaultPrefixes(values: string[]): string[] {
  return Array.from(new Set(values
    .map((value) => normalizeVaultPath(value).replace(/\/$/, ""))
    .filter(Boolean)
    .filter((value) => value !== ".")))
    .sort();
}

export function parseExcludedVaultPrefixes(value: string): string[] {
  return normalizeExcludedVaultPrefixes(value.split(/[\n,，]+/));
}

export function isVaultPathExcluded(path: string, prefixes: string[] = []): boolean {
  const normalized = normalizeVaultPath(path);
  if (normalized === ".obsidian" || normalized.startsWith(".obsidian/")) return true;
  return normalizeExcludedVaultPrefixes(prefixes).some((prefix) => (
    normalized === prefix || normalized.startsWith(`${prefix}/`)
  ));
}

/** Transient sensor caches enter current context only through their guarded projection. */
export function isVisualCachePath(path: string, aiReportsRoot: string): boolean {
  const normalized = normalizeVaultPath(path), root = normalizeVaultPath(aiReportsRoot);
  return ["Vision", "Desktop", "Situation"].some(folder => normalized === `${root}/${folder}` || normalized.startsWith(`${root}/${folder}/`));
}

function normalizeVaultPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}

export function providerDisclosureRequired(capability: "text" | "embedding" | "vision" | "voice"): string {
  const data = {
    text: "用户消息、必要的对话历史和选中的 Vault/记忆文本片段",
    embedding: "用于建索引或查询的 Vault 文本片段",
    vision: "已启用的本人摄像头画面，或经逐次确认的完整屏幕截图",
    voice: "麦克风音频；TTS 时还会发送需要朗读的回复文本"
  }[capability];
  return `尚未授权 ${capability} Provider 数据发送。将发送：${data}。请先在 LifeOps 设置中阅读并确认。`;
}

export type ProviderEgressCapability = "text" | "embedding" | "vision" | "voice" | "tts";

export interface ProviderEgressAuditRecord {
  recordedAt: string;
  capability: ProviderEgressCapability;
  provider: string;
  model: string;
  purpose: string;
  requestBytes: number;
  sourceCount: number;
  contentLogged: false;
}

type ProviderEgressSink = (record: ProviderEgressAuditRecord) => void | Promise<void>;
let providerEgressSink: ProviderEgressSink | null = null;

export function setProviderEgressSink(sink: ProviderEgressSink | null): void {
  providerEgressSink = sink;
}

export async function recordProviderEgress(
  input: Omit<ProviderEgressAuditRecord, "recordedAt" | "contentLogged">,
  credentials: readonly string[] = []
): Promise<ProviderEgressAuditRecord> {
  const record: ProviderEgressAuditRecord = {
    recordedAt: new Date().toISOString(),
    capability: input.capability,
    provider: providerAuditIdentifier(input.provider.trim(), credentials)?.slice(0, 80) ?? "unknown",
    model: providerAuditIdentifier(input.model.trim(), credentials) ?? "unknown",
    purpose: input.purpose.trim().slice(0, 120),
    requestBytes: Math.max(0, Math.round(input.requestBytes)),
    sourceCount: Math.max(0, Math.round(input.sourceCount)),
    contentLogged: false
  };
  await providerEgressSink?.(record);
  return record;
}

export function utf8RequestBytes(value: string | ArrayBuffer | Blob): number {
  if (typeof value === "string") return new TextEncoder().encode(value).byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  return value.size;
}

export function countProviderSources(value: unknown): number {
  const sources = new Set<string>();
  collectStructuredSources(value, sources);
  collectTextSources(value, sources);
  return sources.size;
}

function collectTextSources(value: unknown, sources: Set<string>): void {
  if (typeof value === "string") {
    collectSourcesFromText(value, sources);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectTextSources(item, sources));
    return;
  }
  if (!value || typeof value !== "object") return;
  Object.values(value as Record<string, unknown>).forEach((item) => collectTextSources(item, sources));
}

function collectSourcesFromText(text: string, sources: Set<string>): void {
  const linePattern = /(?:^|\n)\s*(?:#{2,4}\s+|-\s*path:\s*|Path:\s*)([^\n]+)/gim;
  for (const match of text.matchAll(linePattern)) {
    const candidate = match[1].trim();
    if (looksLikeVaultSource(candidate)) sources.add(candidate.toLowerCase());
  }
}

function collectStructuredSources(value: unknown, sources: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectStructuredSources(item, sources));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (["path", "sourcePath", "sourceId"].includes(key) && typeof item === "string" && item.trim()) {
      sources.add(item.trim().toLowerCase());
    }
    collectStructuredSources(item, sources);
  }
}

function looksLikeVaultSource(value: string): boolean {
  const candidate = value.split(" / ")[0].trim();
  return candidate.endsWith(".md") || candidate.includes("/") || candidate.startsWith("vault:");
}
