import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const agentSource = readFileSync(resolve(testDir, "../src/agent/service.ts"), "utf8");

describe("agent execution architecture", () => {

  it("keeps tool execution behind Agent Runtime instead of inline main switches", () => {
    const executionBody = sectionBetween(agentSource, "export async function executeToolCalls", "export async function executeAgentToolCall");

    expect(executionBody).toContain("createAgentRuntime");
    expect(executionBody).toContain("executeAiToolCall");
    expect(executionBody).not.toContain("switch (toolCall.name)");
    expect(executionBody).not.toContain("case \"create_task\"");
  });

});

function sectionBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}
