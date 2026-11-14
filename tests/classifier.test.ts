import { describe, expect, it } from "vitest";
import { classifyByRules, parseAiClassification } from "../src/classifier";
import { parseHealthCsv } from "../src/csv";

describe("classifyByRules", () => {
  it("classifies todos", () => {
    const result = classifyByRules("明天上午整理交易模型");
    expect(result.kind).toBe("todo");
  });

  it("classifies completed work", () => {
    const result = classifyByRules("今天跑步 5 公里完成了");
    expect(result.kind).toBe("done");
  });

  it("classifies trades", () => {
    const result = classifyByRules("这笔交易入场太急，止损设置不合理，需要复盘");
    expect(result.kind).toBe("trade");
  });

  it("classifies explicit prefixes", () => {
    const result = classifyByRules("/idea 可以做一个交易模型检查清单");
    expect(result.kind).toBe("idea");
    expect(result.confidence).toBeGreaterThan(0.9);
  });
});

describe("parseAiClassification", () => {
  const value = JSON.stringify({ kind: "todo", confidence: 0.95, title: "合成清单", content: "核对合成清单" });
  const fallback = { ...classifyByRules("合成备注", "synthetic"), kind: "memo" as const, confidence: 0.1 };

  it.each([value, `\`\`\`json\n${value}\n\`\`\``, `\`\`\`\n${value}\n\`\`\``, `  \`\`\`JSON\r\n${value}\r\n\`\`\`  `])("accepts a complete JSON classification with an optional fence", raw => {
    const result = parseAiClassification(raw, fallback);
    expect(result).toMatchObject({ kind: "todo", confidence: 0.95, content: "核对合成清单", raw: fallback.raw, source: "synthetic" });
    expect(result).not.toBe(fallback);
  });

  it.each([
    `解释：\n\`\`\`json\n${value}\n\`\`\``,
    `\`\`\`json\n${value}\n\`\`\`\n还有其他内容`,
    `\`\`\`json\n${value}\n\`\`\`\n\`\`\`json\n${value}\n\`\`\``,
    `\`\`\`javascript\n${value}\n\`\`\``,
    `\`\`\`json\n${value}`,
    "```json\n{\"kind\":\"execute_shell\"}\n```",
    "```json\nnull\n```",
    "```json\n[{\"kind\":\"todo\"}]\n```"
  ])("keeps the original fallback for invalid or ambiguous output", raw => {
    expect(parseAiClassification(raw, fallback)).toBe(fallback);
  });
});

describe("parseHealthCsv", () => {
  it("parses bilingual health fields", () => {
    const entries = parseHealthCsv("日期,睡眠小时,步数\n2026-05-25,7.5,8000");
    expect(entries).toHaveLength(1);
    expect(entries[0].sleepHours).toBe(7.5);
    expect(entries[0].steps).toBe(8000);
  });

  it("reads documented units and keeps missing metrics distinct from explicit zeros", () => {
    const [entry] = parseHealthCsv('日期,睡眠小时,步数,体重,跑步距离,静息心率\n2026-05-25,—,"8,000 步",68.5 公斤,0 km,62 bpm');
    expect(entry).toMatchObject({ date: "2026-05-25", steps: 8000, weightKg: 68.5, runningKm: 0, restingHeartRate: 62 });
    expect(entry.sleepHours).toBeUndefined();
  });

  it.each([
    ["2026-05-26,坏值", /第 2 条健康记录.*睡眠小时/],
    ["2026-05-26,7小时30分", /第 2 条健康记录.*睡眠小时/],
    ["2026-05-26,25", /第 2 条健康记录.*睡眠小时/],
    ["2026-02-30,7.5", /第 2 条健康记录.*日期/]
  ])("rejects an invalid row rather than silently changing a metric: %s", (row, error) => {
    expect(() => parseHealthCsv(`日期,睡眠小时\n2026-05-25,7\n${row}`)).toThrow(error);
  });

  it("rejects unquoted comma-separated thousands that would shift values", () => {
    expect(() => parseHealthCsv("日期,步数\n2026-05-25,8,000")).toThrow(/第 1 条健康记录的列数/);
  });
});
