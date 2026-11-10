import type { AgentActionSuggestion } from "./types";

export interface UIConfirmCard {
  action: AgentActionSuggestion;
  createdAt: string;
  status: "pending" | "accepted" | "rejected";
}

export function createConfirmCard(action: AgentActionSuggestion): UIConfirmCard {
  return {
    action,
    createdAt: new Date().toISOString(),
    status: "pending"
  };
}
