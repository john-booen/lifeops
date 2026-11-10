export const STREAMING_ASR_MODEL = "qwen-audio-3.1-asr-flash-streaming";

export function streamingAsrEndpoint(endpoint: string): URL {
  const addressError = () => new Error("带热词的识别需要百炼官方语音地址。请检查语音设置。");
  let url: URL;
  try { url = new URL(endpoint.trim() || "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"); }
  catch { throw addressError(); }
  const official = ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com"].includes(url.hostname)
    || /^[a-z0-9-]+\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(url.hostname);
  if (!official || url.protocol !== "wss:" || url.port || url.username || url.password || url.search || url.hash) {
    throw addressError();
  }
  return new URL("/api-ws/v1/inference", url.origin);
}

export function asrHotwords(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const words = value.slice(0, 8000).split(/[,，\n]+/u).map(word => word.normalize("NFKC").trim());
  return [...new Set(words.filter(word => word && word.length <= 80 && (/^[\x20-\x7e]+$/.test(word)
    ? word.split(/\s+/u).length <= 7 : Array.from(word).length <= 15)))].slice(0, 50);
}

export function normalizeRealtimeAsrLanguage(language: string): string | undefined {
  const lower = language.trim().toLowerCase();
  if (!lower) return undefined;
  if (lower.startsWith("zh")) return "zh";
  if (lower.startsWith("en")) return "en";
  if (lower.startsWith("ja") || lower.startsWith("jp")) return "ja";
  if (lower.startsWith("ko") || lower.startsWith("kr")) return "ko";
  return lower;
}
