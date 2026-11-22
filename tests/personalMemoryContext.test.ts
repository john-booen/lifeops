import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
import { createPersonalMemory, personalMemorySourceAssessment, reviewPersonalMemoryRecord } from "../src/personalMemory";
import { confirmedMemoryContextSourcePaths, createPersonalMemoryContextFilter, formatConfirmedPersonalMemoryContext, MEMORY_CONTEXT_OMISSION, personalMemoryContextRevision } from "../src/personalMemoryContext";

const oldText = "I prefer concise replies";
const source = { sourceId: "source:one", path: "source.md", capturedAt: "2026-09-16T10:00:00Z" };
function record() { return createPersonalMemory({ kind: "core_profile", content: oldText, sourceRefs: [source] }); }

describe("partial prepared personal-memory source audit", () => {
  function assessed() {
    const original = record(), records = reviewPersonalMemoryRecord([original], original.id, { decision: "confirm" });
    records[0][personalMemorySourceAssessment] = { usable: true, reason: "synthetic verified source", verifiedSourceIds: [source.sourceId], contextSources: [{ ref: source, basis: "legacy_existing" }] };
    return records;
  }
  it("takes paths only, from an intact current verified block, without mutating records", () => {
    const records = assessed(), before = JSON.stringify(records), context = formatConfirmedPersonalMemoryContext(records);
    expect(confirmedMemoryContextSourcePaths(records, "", context)).toEqual([source.path]);
    expect(JSON.stringify(records)).toBe(before);
  });
  it("keeps confidence in the stored record and audit view while omitting the ranking score from conversation evidence",async()=>{
    const records=assessed(),before=JSON.stringify(records);
    const {personalMemoriesToMarkdown}=await import("../src/personalMemory");
    expect(personalMemoriesToMarkdown(records,"all")).toContain("confidence:");
    const context=formatConfirmedPersonalMemoryContext(records);
    expect(context).not.toContain("confidence:");
    expect(confirmedMemoryContextSourcePaths(records,"",context)).toEqual([source.path]);
    expect(JSON.stringify(records)).toBe(before);
  });
  it.each(["missing-assessment", "unusable", "unverified-ref", "expired", "excluded"])("does not turn %s into an audited source", state => {
    const records = assessed(), context = formatConfirmedPersonalMemoryContext(records);
    if (state === "missing-assessment") delete records[0][personalMemorySourceAssessment];
    if (state === "unusable") records[0][personalMemorySourceAssessment]!.usable = false;
    if (state === "unverified-ref") records[0][personalMemorySourceAssessment]!.verifiedSourceIds = [];
    if (state === "expired") records[0].expiresAt = "2000-01-01T00:00:00Z";
    expect(confirmedMemoryContextSourcePaths(records, "", context, state === "excluded" ? [source.path] : [])).toEqual([]);
  });
  it.each(["clipped", "separate-matches"])("does not stitch %s into a complete prepared memory block", state => {
    const records = assessed();
    const context = state === "clipped" ? formatConfirmedPersonalMemoryContext(records).split("  - sources:")[0]
      : `${oldText}\n\nother source\n  - id: ${records[0].id}\n\nother source\n${source.path}@${source.capturedAt}`;
    expect(confirmedMemoryContextSourcePaths(records, "", context)).toEqual([]);
  });
  it("includes a checked fixed original dependency while skipping ambiguous duplicate source IDs", () => {
    const records = assessed();
    records[0].sourceRefs = [{ sourceId: "fixed-original", path: "notes/original.md", capturedAt: source.capturedAt, contentHash: "a".repeat(64) },
      source, { ...source, path: "notes/unverified-alias.md" }];
    records[0][personalMemorySourceAssessment]!.contextSources = [{ ref: records[0].sourceRefs[0], basis: "fixed_version" }, { ref: source, basis: "legacy_existing" }];
    expect(confirmedMemoryContextSourcePaths(records, "", formatConfirmedPersonalMemoryContext(records))).toEqual(["notes/original.md"]);
  });
  it.each(["../outside.md", "/outside.md", "https://example.invalid/a.md", "notes\\outside.md", "notes/\nsecret.md", "notes//outside.md", `notes/${"x".repeat(240)}.md`, " notes/spaced.md "])("skips a path the diagnostic format cannot preserve exactly: %s", path => {
    const records = assessed(); records[0].sourceRefs = [{ ...source, path }];
    expect(confirmedMemoryContextSourcePaths(records, "", formatConfirmedPersonalMemoryContext(records))).toEqual([]);
  });
  it("bounds unique paths to twenty without endorsing candidates", () => {
    const records = assessed();
    records[0].sourceRefs = Array.from({ length: 22 }, (_, index) => ({ ...source, sourceId: `source-${index}`, path: `notes/${index}.md` }));
    records[0][personalMemorySourceAssessment]!.verifiedSourceIds = records[0].sourceRefs.map(ref => ref.sourceId);
    records[0][personalMemorySourceAssessment]!.contextSources = records[0].sourceRefs.map(ref => ({ ref, basis: "legacy_existing" }));
    const result = confirmedMemoryContextSourcePaths(records, "", formatConfirmedPersonalMemoryContext(records));
    expect(result).toHaveLength(20);
    records[0].status = "candidate";
    expect(confirmedMemoryContextSourcePaths(records, "", formatConfirmedPersonalMemoryContext(records))).toEqual([]);
  });
  it("invalidates an existing session when source meaning changes with the same verified IDs", () => {
    const records = assessed(), before = personalMemoryContextRevision(records);
    records[0][personalMemorySourceAssessment]!.contextSources![0].basis = "correction";
    expect(personalMemoryContextRevision(records)).not.toBe(before);
    expect(formatConfirmedPersonalMemoryContext(records)).toContain("当前正文的更正确认操作已核验");
  });
});

describe("confirmed memory availability in model context", () => {
  it("omits an oversized record whole while retaining a complete smaller current fact", () => {
    const large = createPersonalMemory({ kind: "core_profile", content: "Verified background. ".repeat(150), sourceRefs: [source] });
    const small = record();
    const confirmed = reviewPersonalMemoryRecord(reviewPersonalMemoryRecord([large, small], large.id, { decision: "confirm" }), small.id, { decision: "confirm" });
    const context = formatConfirmedPersonalMemoryContext(confirmed, "", 900);
    expect(context).toContain(oldText);
    expect(context).toContain(small.id);
    expect(context).not.toContain("Verified background.");
    expect(context).not.toContain(large.id);
    expect(context).toContain("另有1条相关记忆因本轮长度上限未放入");
  });
  it("distinguishes budget-omitted facts from no available confirmed memory", () => {
    const original = record(), records = reviewPersonalMemoryRecord([original], original.id, { decision: "confirm" });
    const context = formatConfirmedPersonalMemoryContext(records, "", 0);
    expect(context).toContain("不能据此说记忆不存在");
    expect(context).not.toContain("本轮没有可用的已确认个人记忆。");
    expect(context).not.toContain(oldText);
  });
  it("includes a current confirmed fact while excluding unrelated candidates", () => {
    const original = record();
    const confirmed = reviewPersonalMemoryRecord([original], original.id, { decision: "confirm" });
    const candidate = createPersonalMemory({ kind: "core_profile", content: "unconfirmed preference", sourceRefs: [source] });
    const context = formatConfirmedPersonalMemoryContext([...confirmed, candidate]);
    expect(context).toContain("本轮可用的已确认个人记忆：1条");
    expect(context).toContain(oldText);
    expect(context).not.toContain(candidate.content);
  });
  it.each(["empty", "candidate", "forgotten", "expired", "source-invalid"])("makes %s memory unavailability explicit without guessing a preference", state => {
    const original = record();
    let records = state === "empty" ? [] : [original];
    if (!["empty", "candidate"].includes(state)) records = reviewPersonalMemoryRecord(records, original.id, { decision: "confirm" });
    if (state === "forgotten") records = reviewPersonalMemoryRecord(records, original.id, { decision: "forget" });
    if (state === "expired") records[0].expiresAt = "2000-01-01T00:00:00Z";
    if (state === "source-invalid") records[0][personalMemorySourceAssessment] = { usable: false, reason: "synthetic source missing", verifiedSourceIds: [] };
    const context = formatConfirmedPersonalMemoryContext(records);
    expect(context).toContain("本轮可用的已确认个人记忆：0条");
    expect(context).toContain("不能由助手默认表达风格推导用户偏好");
    expect(context).not.toContain(oldText);
  });
});

describe("suppressed memory in historical context", () => {
  it.each(["correct", "forget"] as const)("omits %s content embedded inside a larger source paragraph", decision => {
    const original = record();
    const records = reviewPersonalMemoryRecord([original], original.id, decision === "correct" ? { decision, content: "I prefer detailed replies for research" } : { decision });
    const filter = createPersonalMemoryContextFilter(records);
    const result = filter(`Unrelated current fact\n\n用户：${oldText}.\nAI: noted.\n\nAnother relevant fact`);
    expect(result).not.toContain(oldText);
    expect(result).toContain(MEMORY_CONTEXT_OMISSION);
    expect(result).toContain("Unrelated current fact");
    expect(result).toContain("Another relevant fact");
    expect(filter("I prefer detailed replies for research")).toBe("I prefer detailed replies for research");
  });
  it.each(["Ｉ prefer concise replies", "I PREFER concise replies", "I prefer\n\nconcise replies"])("matches normalization and wrapping: %s", text => {
    const original = record();
    const forgotten = reviewPersonalMemoryRecord([original], original.id, { decision: "forget" });
    expect(createPersonalMemoryContextFilter(forgotten)(`用户：${text}`)).toBe(MEMORY_CONTEXT_OMISSION);
    expect(JSON.stringify(forgotten)).not.toContain(oldText);
  });
  it("withholds unverified history for legacy tombstones without guessing match lengths", () => {
    const original = record();
    const forgotten = reviewPersonalMemoryRecord([original], original.id, { decision: "forget" });
    delete forgotten[0].suppression!.contentLengths;
    expect(createPersonalMemoryContextFilter(forgotten)("historical source")).toBe(MEMORY_CONTEXT_OMISSION);
  });
  it("changes session revision for confirmation/correction/forgetting, but not unrelated candidates", () => {
    const original = record();
    const confirmed = reviewPersonalMemoryRecord([original], original.id, { decision: "confirm" });
    const corrected = reviewPersonalMemoryRecord(confirmed, original.id, { decision: "correct", content: "detailed replies" });
    const forgotten = reviewPersonalMemoryRecord(corrected, original.id, { decision: "forget" });
    expect(new Set([[], confirmed, corrected, forgotten].map(records => personalMemoryContextRevision(records))).size).toBe(4);
    expect(personalMemoryContextRevision([original])).toBe(personalMemoryContextRevision([]));
    expect(personalMemoryContextRevision(confirmed.map(record => ({ ...record, sourceRefs: [] })))).not.toBe(personalMemoryContextRevision(confirmed));
  });
  it("expires a session snapshot when the same stored state passes its time limit", () => {
    const original = record();
    const confirmed = reviewPersonalMemoryRecord([original], original.id, { decision: "confirm" });
    confirmed[0].expiresAt = "2026-09-17T00:00:00Z";
    expect(personalMemoryContextRevision(confirmed, new Date("2026-09-16T23:59:59Z")))
      .not.toBe(personalMemoryContextRevision(confirmed, new Date("2026-09-17T00:00:01Z")));
  });
  it("uses the rolling prefilter only as a candidate, preserving exact SHA matching", () => {
    const records = Array.from({ length: 40 }, (_, index) => {
      const memory = createPersonalMemory({ id: `fact-${index}`, kind: "episode", content: `Hidden ${"x".repeat(index + 1)} unique detail`, sourceRefs: [source] });
      return reviewPersonalMemoryRecord([memory], memory.id, { decision: "forget" })[0];
    });
    const filter = createPersonalMemoryContextFilter(records);
    const unrelated = "unrelated source paragraph ".repeat(1200);
    expect(filter(unrelated)).toBe(unrelated);
    for (let index = 0; index < 40; index += 1) {
      expect(filter(`${unrelated}\n\nSpeaker: Hidden ${"x".repeat(index + 1)} unique detail`)).not.toContain(`Hidden ${"x".repeat(index + 1)} unique detail`);
    }
  // Forty large independent histories also run under V8 coverage instrumentation.
  }, 20_000);
});
