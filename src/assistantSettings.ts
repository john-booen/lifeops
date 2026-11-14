import type { LifeOpsSettings } from "./types";

export function normalizeAssistantName(value: unknown): string {
  if (typeof value !== "string") return "";
  const name = value.trim();
  return /^[\p{L}\p{N}][\p{L}\p{N} ·_-]{0,23}$/u.test(name) ? name : "";
}

export function assistantName(settings: Pick<LifeOpsSettings, "assistantName">): string {
  return normalizeAssistantName(settings.assistantName) || "LifeOps";
}

export function localHomeVideoPath(value: unknown): string {
  if (typeof value !== "string") return "";
  const path = value.trim();
  return /\.(?:mp4|webm)$/iu.test(path) && !/[\\:\u0000-\u001f\u007f]/u.test(path)
    && path.split("/").every(part => part && !part.startsWith(".")) ? path : "";
}
