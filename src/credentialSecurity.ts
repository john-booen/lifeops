import { chmod } from "node:fs/promises";
import type { LifeOpsSettings } from "./types";

export function credentialStorageRiskMessage(): string {
  return "LifeOps 会把 API Key 明文保存在当前 Vault 的 .obsidian/plugins/lifeops-assistant/data.json。文件仅限当前 macOS 用户读写，但 Vault 备份或同步仍可能复制它。请先在设置中明确接受此风险。";
}

export function assertCredentialStorageAccepted(accepted: boolean, credential: string): void {
  if (credential.trim() && !accepted) throw new Error(credentialStorageRiskMessage());
}

export function configuredCredentials(settings: LifeOpsSettings): string[] {
  return Array.from(new Set([
    settings.ai.apiKey,
    settings.ai.fallbackApiKey,
    settings.embedding.apiKey,
    settings.vision.apiKey,
    settings.voice.apiKey,
    settings.voice.aliyunAccessKeyId,
    settings.voice.aliyunAccessKeySecret,
    settings.voice.aliyunAppKey,
    settings.realtimeVoice.apiKey,
    settings.gateway.sharedSecret
  ].map((value) => value.trim()).filter(Boolean)));
}

export function redactSensitiveText(value: unknown, credentials: string[] = []): string {
  let text = value instanceof Error ? value.message : String(value ?? "");
  for (const credential of Array.from(new Set(credentials.filter(Boolean))).sort((a, b) => b.length - a.length)) {
    text = text.replaceAll(credential, "[REDACTED]");
  }
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/gi, "[REDACTED]")
    .replace(/\b(?:api[_ -]?key|access[_ -]?key(?:secret)?|authorization)\s*[:=]\s*[^\s,;]+/gi, (match) => `${match.split(/[:=]/, 1)[0]}=[REDACTED]`);
}

export async function restrictCredentialFilePermissions(path: string): Promise<void> {
  await chmod(path, 0o600);
}
