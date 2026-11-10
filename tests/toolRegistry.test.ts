import { describe, expect, it } from "vitest";
import { AGENT_TOOLS, agentToolsForChat, agentToolsForRealtime, getLifeOpsTool } from "../src/toolRegistry";

describe("tool registry", () => {
  it("exposes the Phase 1 tool set to chat and realtime models", () => {
    const names = AGENT_TOOLS.map((tool) => tool.name);

    expect(names).toEqual(expect.arrayContaining([
      "create_task",
      "complete_task",
      "delete_task",
      "create_habit",
      "complete_habit",
      "miss_habit",
      "append_journal_entry",
      "append_knowledge_note",
      "append_trading_model_note",
      "query_vault",
      "list_personal_memory_candidates",
      "review_personal_memory",
      "undo_latest_operation"
    ]));
    expect(getLifeOpsTool("delete_task")?.safety).toBe("ui-confirm");
    expect(getLifeOpsTool("take_screenshot")).toBeUndefined();
    expect(getLifeOpsTool("review_personal_memory")?.safety).toBe("ui-confirm");
    expect(getLifeOpsTool("append_memory_note")?.safety).toBe("direct-write");
    expect(getLifeOpsTool("append_knowledge_note")?.safety).toBe("direct-write");
    expect(getLifeOpsTool("append_trading_model_note")?.safety).toBe("direct-write");
    expect(agentToolsForChat().find((tool) => tool.name === "query_vault")).toBeTruthy();
    expect(agentToolsForRealtime().find((tool) => tool.name === "query_vault")).toMatchObject({
      type: "function",
      name: "query_vault"
    });
    expect(agentToolsForChat().find((tool) => tool.name === "read_latest_journal")).toBeUndefined();
    expect(getLifeOpsTool("propose_task_plan")?.safety).toBe("ui-confirm");
    expect(agentToolsForChat().find(tool => tool.name === "propose_task_plan")).toBeTruthy();
    expect(agentToolsForRealtime().find(tool => tool.name === "propose_task_plan")).toBeUndefined();
  });
});
