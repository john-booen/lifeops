import { todayString } from "./date";
import type { CaptureKind, ClassifiedInput } from "./types";

const KIND_LABELS: Record<CaptureKind, string> = {
  todo: "待办",
  done: "已完成",
  diary: "日记",
  idea: "灵感",
  habit: "打卡",
  trade: "交易",
  health: "健康",
  memo: "备忘"
};

export function classifyByRules(raw: string, source = "obsidian", date = todayString()): ClassifiedInput {
  const text = raw.trim();
  const lower = text.toLowerCase();
  const prefixed = matchPrefix(text);
  if (prefixed) {
    return buildClassification(prefixed, text, date, source, 0.98, "指令前缀匹配");
  }

  const healthScore = scoreAny(text, ["睡", "体重", "步", "心率", "疲劳", "精神", "运动", "公里", "kg", "kcal"]);
  const tradeScore = scoreAny(text, ["交易", "入场", "出场", "止损", "止盈", "盈亏", "做多", "做空", "复盘", "模型"]);
  const doneScore = scoreAny(text, ["完成", "做完", "已做", "打卡", "跑完", "结束了", "done"]);
  const todoScore = scoreAny(text, ["明天", "待办", "需要", "记得", "提醒", "安排", "计划", "todo", "要做"]);
  const ideaScore = scoreAny(text, ["想法", "灵感", "思路", "idea", "可以做", "突然想到"]);

  if (tradeScore >= 3) return buildClassification("trade", text, date, source, 0.88, "包含明确交易记录或复盘关键词");
  if (doneScore >= 1 && todoScore === 0) return buildClassification("done", text, date, source, 0.8, "包含完成类表达");
  if (todoScore >= 1) return buildClassification("todo", text, date, source, 0.79, "包含计划或待办类表达");
  if (tradeScore >= 2) return buildClassification("trade", text, date, source, 0.84, "包含交易记录或复盘关键词");
  if (healthScore >= 2) return buildClassification("health", text, date, source, 0.82, "包含健康或运动数据关键词");
  if (ideaScore >= 1) return buildClassification("idea", text, date, source, 0.78, "包含灵感或想法类表达");
  if (lower.includes("今天") || lower.length > 40) return buildClassification("diary", text, date, source, 0.68, "更像自然日记片段");

  return buildClassification("memo", text, date, source, 0.55, "无法稳定归类，进入备忘或待确认");
}

export function parseAiClassification(raw: string, fallback: ClassifiedInput): ClassifiedInput {
  try {
    const text = raw.trim();
    const fenced = text.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/i);
    const parsed = JSON.parse(fenced ? fenced[1] : text) as Partial<ClassifiedInput>;
    if (!parsed.kind || !isCaptureKind(parsed.kind)) return fallback;
    return {
      ...fallback,
      ...parsed,
      kind: parsed.kind,
      confidence: clampConfidence(Number(parsed.confidence ?? fallback.confidence)),
      title: String(parsed.title || fallback.title),
      content: String(parsed.content || fallback.content),
      reason: String(parsed.reason || "AI 分类")
    };
  } catch {
    return fallback;
  }
}

export function captureKindLabel(kind: CaptureKind): string {
  return KIND_LABELS[kind];
}

export function captureSavedMessage(input: ClassifiedInput): string {
  if (input.kind === "trade") return "交易原话已保存到待确认。可以在对话里记交易，或打开记录交易表单。";
  return `LifeOps 已记录为${captureKindLabel(input.kind)}：${input.title}`;
}

function matchPrefix(text: string): CaptureKind | null {
  const match = text.match(/^\/([a-zA-Z-]+)\s+/);
  if (!match) return null;
  const prefix = match[1].toLowerCase();
  const map: Record<string, CaptureKind> = {
    todo: "todo",
    done: "done",
    diary: "diary",
    journal: "diary",
    idea: "idea",
    habit: "habit",
    trade: "trade",
    health: "health",
    memo: "memo"
  };
  return map[prefix] ?? null;
}

function scoreAny(text: string, words: string[]): number {
  return words.reduce((score, word) => score + (text.includes(word) ? 1 : 0), 0);
}

function buildClassification(
  kind: CaptureKind,
  raw: string,
  date: string,
  source: string,
  confidence: number,
  reason: string
): ClassifiedInput {
  const cleaned = raw.replace(/^\/[a-zA-Z-]+\s+/, "").trim();
  return {
    kind,
    confidence: clampConfidence(confidence),
    title: cleaned.slice(0, 40) || captureKindLabel(kind),
    content: cleaned,
    date,
    raw,
    source,
    reason
  };
}

function isCaptureKind(value: string): value is CaptureKind {
  return ["todo", "done", "diary", "idea", "habit", "trade", "health", "memo"].includes(value);
}

function clampConfidence(value: number): number {
  if (Number.isNaN(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}
