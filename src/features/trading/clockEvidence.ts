import { clockFromMatch, clockMatches } from "../../clockText";
import { isTradeTimestamp } from "./types";

type ClockField = "openedAt" | "closedAt";
type ClockEvidence = { field?: ClockField } & ({ timestamp: string } | { clock: string });

const event = "开仓|入场|进场|买入|平仓|出场|离场|卖出";
const beforeEvent = new RegExp(`(${event})(?:的?(?:时间|时刻))?\\s*(?:是|为|[:=])?\\s*$`, "u");
const afterEvent = new RegExp(`^\\s*(${event})`, "u");
const clockValue = /T(\d{2}:\d{2})(?::(\d{2})(\.\d+)?)?/u;

function adjacentField(text: string, start: number, end: number): ClockField | undefined {
  const match = afterEvent.exec(text.slice(end)) ?? beforeEvent.exec(text.slice(0, start));
  if (match) return ["平仓", "出场", "离场", "卖出"].includes(match[1]) ? "closedAt" : "openedAt";
}

export function tradeClockEvidence(message: string): ClockEvidence[] {
  const text = message.normalize("NFKC");
  const evidence: ClockEvidence[] = [];
  // Keep a complete timestamp separate so its timezone offset is never read as another clock.
  const remaining = text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/gu, (timestamp, start: number) => {
    if (isTradeTimestamp(timestamp)) evidence.push({ timestamp, field: adjacentField(text, start, start + timestamp.length) });
    return " ".repeat(timestamp.length);
  });
  for (const match of clockMatches(remaining)) {
    const start = match.index!, end = start + match[0].length;
    if (/[.+\d-]$/u.test(remaining.slice(0, start))) continue;
    const minute = clockFromMatch(match);
    if (!minute) continue;
    const seconds = /^:([0-5]\d)(?!\d)/u.exec(remaining.slice(end));
    const field = adjacentField(remaining, start, end + (seconds?.[0].length ?? 0));
    // A bare “三点” may be a price movement. Prefer a time-of-day qualifier or a trade action.
    if (!match[1] && !match[3] && !match[4] && !match[5] && !field) continue;
    evidence.push({ clock: `${minute}:${seconds?.[1] ?? "00"}`, field });
  }
  return evidence;
}

export function supportsTradeClock(evidence: readonly ClockEvidence[], field: ClockField, timestamp: string, other?: string): boolean {
  const parts = clockValue.exec(timestamp);
  if (!parts) return false;
  return evidence.some(item => {
    if (item.field && item.field !== field) return false;
    if (field === "closedAt" && !item.field && other && Date.parse(other) === Date.parse(timestamp)) return false;
    return "timestamp" in item ? Date.parse(item.timestamp) === Date.parse(timestamp)
      : (!parts[3] || Number(parts[3]) === 0) && item.clock === `${parts[1]}:${parts[2] ?? "00"}`;
  });
}
