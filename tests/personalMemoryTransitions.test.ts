import { describe, expect, it } from "vitest";
import {
  createPersonalMemory, findMemorySuppression, personalMemoriesToMarkdown,
  reviewPersonalMemoryRecord, selectPersonalMemories, upsertPersonalMemoryRecord
} from "../src/personalMemory";

const source = { sourceId: "journal:original", path: "日记/original.md", capturedAt: "2026-09-16T10:00:00Z" };
const oldText = "I prefer concise replies";
const correctedText = "I prefer detailed replies for research";
const make = (id: string, content = oldText) => createPersonalMemory({ id, kind: "core_profile", content, sourceRefs: [source] });
const active = (id: string, content = oldText) => reviewPersonalMemoryRecord([make(id, content)], id, { decision: "confirm" })[0];

describe("personal memory transition boundaries", () => {
  it("retires existing duplicates when one copy is corrected", () => {
    const records = reviewPersonalMemoryRecord([active("original"), active("duplicate"), make("candidate", "I  prefer concise replies")], "original", { decision: "correct", content: correctedText });
    expect(selectPersonalMemories(records).map(r => r.content)).toEqual([correctedText]);
    expect(records.filter(r => r.status === "candidate")).toEqual([]);
    expect(() => reviewPersonalMemoryRecord(records, "duplicate", { decision: "confirm" })).toThrow();
    expect(findMemorySuppression(records, oldText)).toBeDefined();
  });

  it("does not confirm a stale duplicate reintroduced beside a correction", () => {
    const corrected = reviewPersonalMemoryRecord([active("original")], "original", { decision: "correct", content: correctedText });
    const records = [...corrected, make("stale")];
    expect(() => reviewPersonalMemoryRecord(records, "stale", { decision: "confirm" })).toThrow();
    expect(selectPersonalMemories([...corrected, active("stale")]).map(r => r.content)).toEqual([correctedText]);
  });

  it("does not restore forgotten or corrected text through a different correction", () => {
    const forgotten = reviewPersonalMemoryRecord([active("original")], "original", { decision: "forget" });
    expect(() => reviewPersonalMemoryRecord([...forgotten, active("other", "unrelated")], "other", { decision: "correct", content: oldText })).toThrow();
  });

  it("retains a tombstone when a later observation reuses its ID for different text", () => {
    const forgotten = reviewPersonalMemoryRecord([active("original")], "original", { decision: "forget" });
    const next = upsertPersonalMemoryRecord(forgotten, make("original", "a new observation"));
    expect(next.find(r => r.id === "original")).toEqual(forgotten[0]);
    expect(next.filter(r => r.status === "candidate")).toHaveLength(1);
    expect(findMemorySuppression(next, oldText)).toBeDefined();
  });

  it("forgets the revision history of matching copies, independent of array order", () => {
    const duplicate = { ...active("duplicate"), revisions: [{ content: "An older preference", changedAt: source.capturedAt, reason: "superseded" as const }] };
    const records = reviewPersonalMemoryRecord([make("older", "An older preference"), active("original"), duplicate], "original", { decision: "forget" });
    expect(records.every(r => r.status === "forgotten")).toBe(true);
    expect(findMemorySuppression(records, "An older preference")).toBeDefined();
    expect(JSON.stringify(records)).not.toContain("An older preference");
  });

  it("requires a usable source before activating a candidate", () => {
    const candidate = createPersonalMemory({ id: "unsourced", kind: "core_profile", content: oldText });
    expect(() => reviewPersonalMemoryRecord([candidate], candidate.id, { decision: "confirm" })).toThrow();
  });

  it("rejects empty corrections before changing memory", () => {
    expect(() => reviewPersonalMemoryRecord([active("original")], "original", { decision: "correct", content: "  " })).toThrow();
  });

  it("marks newly sensitive corrections as sensitive", () => {
    const records = reviewPersonalMemoryRecord([active("original")], "original", { decision: "correct", content: "用户正在用药" });
    expect(records[0].sensitive).toBe(true);
  });

  it("never formats unconfirmed, unsourced or suppressed records as confirmed memory", () => {
    const forgotten = reviewPersonalMemoryRecord([active("original")], "original", { decision: "forget" });
    expect(personalMemoriesToMarkdown([...forgotten, make("candidate", "pending"), active("stale"), { ...active("source-less", "unsourced"), sourceRefs: [] }])).toBe("");
  });
});
