import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { JOURNAL_INSTRUCTIONS } from "../src/journalInstructions";
import { agentToolsForRealtime } from "../src/toolRegistry";
import { BailianRealtimeClient } from "../src/bailianRealtime";
import { buildOmniE2eInstructions } from "../src/voice/voiceRealtime";
import { LifeOpsAi } from "../src/ai";
vi.mock("obsidian", () => ({ Notice: class {}, requestUrl: vi.fn() }));
vi.mock("ws", () => ({ default: class { constructor() { throw Error("No network"); } } }));

it("serializes only registered tool names in the real Omni instructions and schemas", () => {
  const client = new BailianRealtimeClient(DEFAULT_SETTINGS.realtimeVoice, {}, {
    mode: "omni-e2e", instructions: buildOmniE2eInstructions("合成上下文"), tools: agentToolsForRealtime()
  });
  const payload = (client as any).buildSessionUpdatePayload();
  expect(payload.session.tools.every((tool: any) => tool.type === "function" && tool.function?.name && !("name" in tool))).toBe(true);
  const definitions = payload.session.tools.map((tool: any) => tool.function);
  const names = new Set(definitions.map((tool: any) => tool.name));
  expect([...names]).toEqual(agentToolsForRealtime().map(tool => tool.name));
  // Catches stale tool references such as read_latest_journal even if schemas evolve.
  const mentioned = payload.session.instructions.match(/\b[a-z]+_[a-z_]+\b/g) ?? [];
  expect(mentioned.length).toBeGreaterThan(0);
  for (const name of mentioned) expect(names.has(name), `Instruction references unavailable ${name}`).toBe(true);
  const query = definitions.find((tool: any) => tool.name === "query_vault");
  expect(query.parameters.properties.period.enum).toEqual(["早", "晚"]);
  expect(query.parameters.properties.date.description).toContain("昨天");
  const save = definitions.find((tool: any) => tool.name === "append_journal_entry");
  expect(save.parameters.required).toEqual(["content", "period"]);
});

describe("shared journal policy across provider paths", () => {
  it("keeps text and native voice factual editing aligned while preserving spoken presentation", () => {
    const text = (new LifeOpsAi(DEFAULT_SETTINGS) as any).agentMessages("", "帮我整理日记", [], "text")[0].content;
    const voice = buildOmniE2eInstructions();
    for (const rule of JOURNAL_INSTRUCTIONS) expect(voice).toContain(rule);
    for (const safeguard of ["保留原句", "否定、疑问、不确定性", "不回答日记里的自问", "建议与已发生事实分开"]) expect(text).toContain(safeguard);
    expect(voice).toContain("自然、简洁、口语化");
    expect(voice).toContain("不读出路径、内部ID或Markdown符号");
  });
});
