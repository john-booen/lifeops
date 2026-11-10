import { describe, expect, it } from "vitest";
import {
  canPromotePattern,
  createPersonalMemory,
  inferExplicitPersonalMemory,
  personalMemoriesToMarkdown,
  reviewPersonalMemoryRecord,
  selectPersonalMemories,
  upsertPersonalMemoryRecord
} from "../src/personalMemory";

const source = {
  sourceId: "conversation:2026-07-28",
  path: "LifeOps/Output/AI/Conversations/2026-07-28.md",
  capturedAt: "2026-07-28T08:00:00.000Z"
};

describe("personal memory", () => {
  it.each(["不要记住我喜欢长回复", "这只是举例：我喜欢长回复", "他问我：‘我喜欢长回复’，不代表我", "请翻译：\"我喜欢长回复\""])("does not turn an opt-out or quoted example into an automatic candidate: %s", text => {
    expect(inferExplicitPersonalMemory(text, source)).toBeNull();
  });
  it("keeps extracted ordinary preferences and user rules pending confirmation", () => {
    const preference = inferExplicitPersonalMemory("我更喜欢你说话直接一点", source);
    const rule = inferExplicitPersonalMemory("以后不要主动催我下单", source);

    expect(preference).toMatchObject({ kind: "core_profile", status: "candidate", truth: "explicit_fact" });
    expect(rule).toMatchObject({ kind: "user_rule", status: "candidate", truth: "explicit_fact" });
  });

  it("keeps sensitive facts and all inferences as candidates", () => {
    const sensitive = createPersonalMemory({
      kind: "current_state",
      content: "我最近交易亏损后很焦虑",
      truth: "explicit_fact",
      sourceRefs: [source]
    });
    const inference = createPersonalMemory({
      kind: "pattern_candidate",
      content: "用户可能会在疲劳时冲动交易",
      truth: "inference",
      sourceRefs: [source]
    });

    expect(sensitive.status).toBe("candidate");
    expect(sensitive.sensitive).toBe(true);
    expect(inference.status).toBe("candidate");
  });

  it("requires repeated independent evidence before a pattern is promotable", () => {
    const record = createPersonalMemory({
      kind: "pattern_candidate",
      content: "用户在睡眠不足时更容易违反交易纪律",
      truth: "inference",
      confidence: 0.8,
      sourceRefs: [
        source,
        { ...source, sourceId: "journal:2", path: "日记/2.md", capturedAt: "2026-07-29T08:00:00.000Z" },
        { ...source, sourceId: "journal:3", path: "日记/3.md", capturedAt: "2026-07-30T08:00:00.000Z" }
      ]
    });

    expect(canPromotePattern(record)).toBe(true);
    expect(canPromotePattern({ ...record, sourceRefs: record.sourceRefs.slice(0, 2) })).toBe(false);
  });

  it("supports confirmation, correction and persistent suppression", () => {
    const candidate = createPersonalMemory({
      kind: "core_profile",
      content: "用户不喜欢长回复",
      truth: "inference",
      sourceRefs: [source]
    });
    const corrected = reviewPersonalMemoryRecord([candidate], candidate.id, {
      decision: "correct",
      content: "用户在语音中偏好简短回复"
    });
    const forgotten = reviewPersonalMemoryRecord(corrected, candidate.id, { decision: "forget" });

    expect(corrected[0]).toMatchObject({
      status: "active",
      truth: "explicit_fact",
      content: "用户在语音中偏好简短回复"
    });
    expect(corrected[0].revisions[0].content).toBe("用户不喜欢长回复");
    expect(forgotten[0]).toMatchObject({ status: "forgotten", sourceRefs: [], revisions: [] });
    expect(forgotten[0].suppression?.contentHashes).toHaveLength(2);
    expect(selectPersonalMemories(forgotten)).toEqual([]);
  });

  it("loads confirmed core memory and rules before lower-priority episodes", () => {
    const core = createPersonalMemory({ kind: "core_profile", content: "用户喜欢直接沟通", sourceRefs: [source] });
    const rule = createPersonalMemory({ kind: "user_rule", content: "不要催促实盘交易", sourceRefs: [source] });
    const episode = createPersonalMemory({ kind: "episode", content: "今天读了一本书", sourceRefs: [source] });
    const confirmed = [episode, rule, core].map(record => reviewPersonalMemoryRecord([record], record.id, { decision: "confirm" })[0]);
    const selected = selectPersonalMemories(confirmed, "随便聊聊");
    const markdown = personalMemoriesToMarkdown(selected);

    expect(selected.slice(0, 2).map((item) => item.kind)).toEqual(["core_profile", "user_rule"]);
    expect(markdown).toContain("核心画像");
    expect(markdown).toContain("用户规则");
  });

  it("merges evidence without silently downgrading a confirmed memory", () => {
    const active = createPersonalMemory({ kind: "core_profile", content: "用户喜欢直接沟通", sourceRefs: [source] });
    const incoming = createPersonalMemory({
      id: active.id,
      kind: "core_profile",
      content: "用户喜欢直接沟通",
      truth: "inference",
      sourceRefs: [{ ...source, sourceId: "conversation:2", capturedAt: "2026-07-29T08:00:00.000Z" }]
    });
    const confirmed = reviewPersonalMemoryRecord([active], active.id, { decision: "confirm" });
    const merged = upsertPersonalMemoryRecord(confirmed, incoming);

    expect(merged[0].status).toBe("active");
    expect(merged[0].sourceRefs).toHaveLength(2);
  });
});
