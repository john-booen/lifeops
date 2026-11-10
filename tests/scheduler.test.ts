import { describe, expect, it } from "vitest";
import { generateProactiveCandidates, isInQuietHours, shouldSuppressProactiveCandidate } from "../src/scheduler";
import { getTimeContext } from "../src/timeContext";

describe("scheduler", () => {
  it("stays silent when disabled or below panel-candidate level", () => {
    const time = getTimeContext(new Date(2026, 5, 11, 8, 0));

    expect(generateProactiveCandidates({ time, now: new Date(2026, 5, 11, 8, 0) })).toHaveLength(0);
    expect(generateProactiveCandidates({ time, now: new Date(2026, 5, 11, 8, 0) }, {
      enabled: true,
      proactiveLevel: 1,
      minMinutesBetweenCandidates: 90,
      quietHoursStart: 23,
      quietHoursEnd: 7
    })).toHaveLength(0);
  });

  it("generates a morning briefing candidate", () => {
    const now = new Date(2026, 5, 11, 8, 0);
    const candidates = generateProactiveCandidates({ time: getTimeContext(now), now }, {
      enabled: true,
      proactiveLevel: 2,
      minMinutesBetweenCandidates: 90,
      quietHoursStart: 23,
      quietHoursEnd: 7
    });

    expect(candidates.map((item) => item.kind)).toContain("daily_brief");
  });

  it("suppresses candidates during cooldown and quiet hours", () => {
    const now = new Date(2026, 5, 11, 23, 30);
    const settings = {
      enabled: true,
      proactiveLevel: 2 as const,
      minMinutesBetweenCandidates: 90,
      quietHoursStart: 23,
      quietHoursEnd: 7
    };

    expect(isInQuietHours(now, 23, 7)).toBe(true);
    expect(shouldSuppressProactiveCandidate({ time: getTimeContext(now), now }, settings, now)).toBe(true);
    expect(shouldSuppressProactiveCandidate({
      time: getTimeContext(new Date(2026, 5, 11, 8, 0)),
      now: new Date(2026, 5, 11, 8, 0),
      lastCandidateAt: "2026-06-11T07:15:00.000Z"
    }, settings, new Date(2026, 5, 11, 8, 0))).toBe(true);
  });

  it("prioritizes weekly and trading candidates", () => {
    const now = new Date(2026, 5, 14, 19, 0);
    const candidates = generateProactiveCandidates({
      time: getTimeContext(now),
      now,
      candidateMemoryCount: 2,
      recentTradingSignal: true
    }, {
      enabled: true,
      proactiveLevel: 2,
      minMinutesBetweenCandidates: 90,
      quietHoursStart: 23,
      quietHoursEnd: 7
    });

    expect(candidates[0].priority).toBe("high");
    expect(candidates.map((item) => item.workflowId)).toContain("weekly_review");
  });

  it("only raises a critical sensor candidate when sustained fatigue overlaps high-risk activity", () => {
    const now = new Date(2026, 5, 11, 14, 0);
    const settings = {
      enabled: true,
      proactiveLevel: 4 as const,
      minMinutesBetweenCandidates: 0,
      quietHoursStart: 0,
      quietHoursEnd: 0
    };
    const candidates = generateProactiveCandidates({
      time: getTimeContext(now),
      now,
      sustainedFatigueRisk: true,
      highRiskActivity: true
    }, settings);
    expect(candidates[0]).toMatchObject({
      kind: "sensor_risk",
      priority: "critical",
      voiceEligible: true
    });

    expect(generateProactiveCandidates({
      time: getTimeContext(now),
      now,
      sustainedFatigueRisk: true,
      highRiskActivity: false
    }, settings).some((item) => item.kind === "sensor_risk")).toBe(false);
  });
});
