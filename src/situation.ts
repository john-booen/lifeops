
import type { ContextBlock } from "./contextBundle";
import type { TimeContext } from "./timeContext";
import type { VisualAnalysisResult } from "./types";

interface SentimentSignal {
  valence: number;
  urgency: number;
  frustration: number;
  anxiety: number;
  fatigue: number;
  excitement: number;
}

type ConversationMode = "daily_companion" | "trading_discipline" | "evening_review" | "health_care";

export type SuggestedCiciAction = "be_quiet" | "check_in" | "remind" | "warn" | "encourage";

export interface SituationVoiceInput {
  isActive: boolean;
  lastIntent: string | null;
  lastSentiment: SentimentSignal | null;
  lastUserMessage: string | null;
}

export interface SituationInput {
  generatedAt?: string;
  time: TimeContext;
  voice?: Partial<SituationVoiceInput>;
}

export interface Situation {
  generatedAt: string;
  time: {
    date: string;
    weekday: string;
    timeOfDay: TimeContext["timeOfDay"];
    isWorkday: boolean;
    isTradingWindow: boolean;
    season: string;
  };
  voice: SituationVoiceInput;
  evidence: SituationEvidence[];
  uncertainties: string[];
  fusion: FusionResult;
}

export type SituationSnapshot = Situation;

export interface SituationEvidence {
  source: "time" | "voice";
  observedAt: string;
  confidence: number;
  summary: string;
}

export interface FusionResult {
  primaryActivity: string;
  inferredState: string;
  confidence: number;
  contradictions: string[];
  suggestedCiciMode: ConversationMode;
  suggestedCiciAction: SuggestedCiciAction;
}

interface FusionSignal {
  label: string;
  weight: number;
}

export function buildSituation(input: SituationInput): Situation {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const voice: SituationVoiceInput = {
    isActive: input.voice?.isActive ?? false,
    lastIntent: input.voice?.lastIntent ?? null,
    lastSentiment: input.voice?.lastSentiment ?? null,
    lastUserMessage: input.voice?.lastUserMessage ?? null
  };
  const partial = {
    time: input.time,
    voice
  };
  const evidence: SituationEvidence[] = [{
    source: "time",
    observedAt: generatedAt,
    confidence: 1,
    summary: `${input.time.date} ${input.time.timeOfDay}`
  }];
  if (voice.lastUserMessage) {
    evidence.push({
      source: "voice",
      observedAt: generatedAt,
      confidence: 0.72,
      summary: voice.lastUserMessage.slice(0, 160)
    });
  }
  const uncertainties: string[] = [];

  return {
    generatedAt,
    time: {
      date: input.time.date,
      weekday: input.time.weekday,
      timeOfDay: input.time.timeOfDay,
      isWorkday: input.time.isWorkday,
      isTradingWindow: input.time.isTradingWindow,
      season: input.time.season
    },
    voice,
    evidence,
    uncertainties,
    fusion: fuseSituation(partial)
  };
}

export function fuseSituation(input: {
  time: TimeContext;
  voice?: SituationVoiceInput;
}): FusionResult {
  const signals: FusionSignal[] = [];
  const contradictions: string[] = [];
  const sentiment = input.voice?.lastSentiment ?? null;

  if (input.time.timeOfDay === "night") signals.push({ label: "time_night", weight: 0.34 });
  if (input.time.isTradingWindow) signals.push({ label: "trading_window", weight: 0.36 });
  if (sentiment && (sentiment.frustration > 0.45 || sentiment.anxiety > 0.45)) signals.push({ label: "voice_stress", weight: 0.4 });
  if (sentiment && sentiment.fatigue > 0.45) signals.push({ label: "voice_fatigue", weight: 0.3 });

  return chooseFusion(input, signals, contradictions);
}

export function situationToMarkdown(situation: Situation): string {
  return [
    "## Situation Engine",
    `- generatedAt: ${situation.generatedAt}`,
    `- time: ${situation.time.date} ${situation.time.weekday} ${situation.time.timeOfDay}`,
    `- voiceActive: ${situation.voice.isActive ? "yes" : "no"}`,
    `- primaryActivity: ${situation.fusion.primaryActivity}`,
    `- inferredState: ${situation.fusion.inferredState}`,
    `- confidence: ${situation.fusion.confidence.toFixed(2)}`,
    `- suggestedCiciMode: ${situation.fusion.suggestedCiciMode}`,
    `- suggestedCiciAction: ${situation.fusion.suggestedCiciAction}`,
    situation.uncertainties.length > 0 ? ["", "### Uncertainties", ...situation.uncertainties.map((item) => `- ${item}`)].join("\n") : "",
    situation.fusion.contradictions.length > 0 ? ["", "### Contradictions", ...situation.fusion.contradictions.map((item) => `- ${item}`)].join("\n") : ""
  ].filter(Boolean).join("\n");
}

export function situationContextBlock(situation: Situation): ContextBlock {
  return {
    label: "Current Situation",
    content: situationToMarkdown(situation),
    source: "LifeOps Situation Engine",
    generatedAt: situation.generatedAt,
    expiresAt: new Date(Date.parse(situation.generatedAt) + 90_000).toISOString(),
    confidence: situation.fusion.confidence,
    priority: "critical"
  };
}

function chooseFusion(
  input: {
    time: TimeContext;
    voice?: SituationVoiceInput;
  },
  signals: FusionSignal[],
  contradictions: string[]
): FusionResult {
  const sentiment = input.voice?.lastSentiment ?? null;
  const confidence = clamp01(0.35 + signals.reduce((sum, signal) => sum + signal.weight, 0) / 2.5 - contradictions.length * 0.08);

  if (input.time.isTradingWindow && /交易|复盘|模型|风控/.test(input.voice?.lastUserMessage ?? "")) {
    return {
      primaryActivity: "交易/复盘敏感时段",
      inferredState: sentiment?.anxiety && sentiment.anxiety > 0.4
        ? "可能存在压力信号，需要核对交易计划与纪律"
        : "需要核对交易计划与纪律",
      confidence,
      contradictions,
      suggestedCiciMode: "trading_discipline",
      suggestedCiciAction: "warn"
    };
  }
  if (sentiment && sentiment.fatigue > 0.45) {
    return {
      primaryActivity: "休息/疲劳",
      inferredState: "出现可能的疲劳或休息迹象，可先确认本人感受",
      confidence,
      contradictions,
      suggestedCiciMode: "health_care",
      suggestedCiciAction: "encourage"
    };
  }
  if (input.time.timeOfDay === "evening") {
    return {
      primaryActivity: "晚间收束",
      inferredState: "适合复盘和收尾",
      confidence,
      contradictions,
      suggestedCiciMode: "evening_review",
      suggestedCiciAction: "remind"
    };
  }

  return {
    primaryActivity: "常规状态",
    inferredState: "正常",
    confidence,
    contradictions,
    suggestedCiciMode: "daily_companion",
    suggestedCiciAction: "check_in"
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
