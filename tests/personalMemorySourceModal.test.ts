import { describe, expect, it, vi } from "vitest";
import { createPersonalMemory, personalMemorySourceAssessment, reviewPersonalMemoryRecord } from "../src/personalMemory";
vi.mock("obsidian", () => ({ Modal: class {} }));
const { memoryConfirmationSourceText } = await import("../src/personalMemorySourceModal");
const ref = { sourceId: "confirmed:one", path: "AI/Operations/operation-ledger.json", capturedAt: "2026-09-16T10:00:00Z" };
const candidate = createPersonalMemory({ kind: "core_profile", content: "我喜欢简短回复", sourceRefs: [ref] });
const record = reviewPersonalMemoryRecord([candidate], candidate.id, { decision: "confirm", sourceRef: ref })[0];

describe("read-only memory confirmation source details", () => {
  it("shows only the selected memory and its verified receipt", () => {
    const selected = { ...record, [personalMemorySourceAssessment]: { usable: true, reason: "verified", verifiedSourceIds: [ref.sourceId] } };
    const text = memoryConfirmationSourceText(selected, ref.sourceId).join("\n");
    expect(text).toContain(record.content);
    expect(text).toContain("独立确认凭据");
    expect(text).not.toContain("operation-ledger.json");
  });
  it("does not claim verification for a missing or superseded confirmation", () => {
    const selected = { ...record, [personalMemorySourceAssessment]: { usable: false, reason: "unavailable", verifiedSourceIds: [] } };
    expect(memoryConfirmationSourceText(selected, ref.sourceId).join("\n")).toContain("未作为当前内容的确认依据");
    expect(memoryConfirmationSourceText(selected, "confirmed:another")).toEqual(["这条来源已经变化，请关闭后重新核对。"]);
  });
});
