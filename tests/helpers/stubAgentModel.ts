import type { AiChatResult, ChatMessage } from "../../src/ai";
import type { LifeOpsSettings } from "../../src/types";

interface StubHost {
  settings: LifeOpsSettings;
  ai: unknown;
}

export function stubAgentModel(
  host: StubHost,
  first: (messages: ChatMessage[]) => Promise<AiChatResult>,
  afterTools: (messages: ChatMessage[]) => Promise<AiChatResult> = async messages => ({
    content: messages.filter(message => message.role === "tool").map(message => message.content).join("\n"),
    toolCalls: []
  })
): void {
  Object.assign(host.settings.ai, {
    provider: "openai-compatible", endpoint: "https://fictional.invalid/chat", model: "synthetic-agent",
    apiKey: "synthetic-only", dataDisclosureAccepted: true, fallbackProvider: "off"
  });
  host.ai = {
    async agentTurnStream(messages: ChatMessage[], onText: (text: string) => void) {
      const result = await (messages.some(message => message.role === "tool") ? afterTools(messages) : first(messages));
      if (result.content && !result.toolCalls.length) onText(result.content);
      return result;
    }
  };
}
