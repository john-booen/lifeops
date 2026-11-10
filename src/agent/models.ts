import type { LifeOpsSettings } from "../types";

export type AgentModelRole = "fast" | "main" | "deep";

export function agentModelRole(source: "text" | "voice" | "system", message: string): AgentModelRole {
  return source === "voice" || [...message.trim()].length <= 15 ? "fast" : "main";
}

export function settingsForAgentModel(settings: LifeOpsSettings, role: AgentModelRole): LifeOpsSettings {
  const ai = settings.ai;
  if (ai.provider === "off" || role !== "fast" || ai.fallbackProvider === "off" || !ai.fallbackEndpoint || !ai.fallbackModel) return settings;
  return {
    ...settings,
    ai: {
      ...ai,
      provider: ai.fallbackProvider,
      endpoint: ai.fallbackEndpoint,
      apiKey: ai.fallbackApiKey,
      model: ai.fallbackModel,
      fallbackProvider: ai.provider,
      fallbackEndpoint: ai.endpoint,
      fallbackApiKey: ai.apiKey,
      fallbackModel: ai.model
    }
  };
}
