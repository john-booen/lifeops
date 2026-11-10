import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
import { createPersonalMemory, memoryContentHash, reviewPersonalMemoryRecord } from "../src/personalMemory";
import { LEGACY_MEMORY_PREVIEW_LIMITS as limits, legacyMemoryPreviewToMarkdown, previewLegacyMemoryMigration, type LegacyMemorySnapshot } from "../src/legacyMemoryMigration";

const index = "旧记忆/memory-index.json", chat = "旧记忆/conversation-memory.jsonl", note = "旧记忆/个人画像.md";
const allowed = [{ kind: "index" as const, path: index }, { kind: "conversation" as const, path: chat }, { kind: "markdown" as const, path: note }], date = "2026-10-25T00:00:00.000Z";
const row = (content: string, extra = {}) => ({ id: "old", content, status: "active", ...extra });
const json = (entries: unknown): LegacyMemorySnapshot => ({ kind: "index", path: index, text: JSON.stringify(entries) });
const conversation = (entries: unknown[]): LegacyMemorySnapshot => ({ kind: "conversation", path: chat, text: entries.map(x => JSON.stringify(x)).join("\r\n") });
const memory = (content: string) => createPersonalMemory({ kind: "core_profile", content, sourceRefs: [{ sourceId: "synthetic-origin", path: "原文/虚构.md", capturedAt: date }] }, date);
const run = (sources: LegacyMemorySnapshot[], records = [] as ReturnType<typeof memory>[]) => previewLegacyMemoryMigration(sources, records, allowed);

describe("legacy-memory readonly preview", () => {
  it("groups normalized identical content across stores without approving, writing or changing sources", () => {
    const sources = [json([row("Ａlpha   偏好")]), conversation([{ type: "conversation_summary", userStatement: "alpha 偏好", content: "AI总结不得采用", assistantResponse: "AI断言不得采用" }])];
    const before = structuredClone(sources), records = [memory("别的候选")], original = structuredClone(records);
    const p = run(sources, records);
    expect(p).toEqual(run(sources, records)); expect(sources).toEqual(before); expect(records).toEqual(original);
    expect(p.mode).toBe("readonly_preview"); expect(p.items).toHaveLength(1);
    expect(p.counts).toMatchObject({ reviewedEntries: 2, unique: 1, duplicates: 1, pendingReview: 1 });
    expect(p.items[0].status).toBe("review"); expect(p.items[0].occurrences).toEqual([{ source: 0, position: 1 }, { source: 1, position: 1 }]);
    expect(JSON.stringify(p)).not.toMatch(/AI总结|AI断言|confirmationReceipt|sourceRefs|confirmedAt/);
    expect(p.sources[0].sha256).not.toBe(p.sources[1].sha256); // Raw versions differ even though contents normalize equally.
  });
  it("reports existing candidates and active registrations without merging or claiming current validity", () => {
    const candidate = memory("已有候选"), active = { ...memory("已登记内容"), status: "active" as const, confirmedAt: date, expiresAt: "2000-01-01T00:00:00Z" };
    const p = run([json([row(candidate.content), row(active.content)])], [candidate, active]);
    expect(p.items.map(i => i.status)).toEqual(["already_present", "already_present"]);
    expect(p.counts.pendingReview).toBe(0); expect(legacyMemoryPreviewToMarkdown(p)).not.toContain("已确认已存在");
  });
  it.each(["forgotten", "corrected"])("hides a %s old sentence even inside mixed Markdown before truncation", action => {
    const old = memory("纯虚构必须隐藏的旧偏好");
    const records = reviewPersonalMemoryRecord([old], old.id, action === "forgotten" ? { decision: "forget" } : { decision: "correct", content: "纯虚构已纠正的新偏好" }, date);
    const text = "# 旧资料\n\n" + "安全前缀".repeat(500) + old.content + "\n\n另一段";
    const p = run([{ kind: "markdown", path: note, text }, json([row(old.content)])], records);
    expect(p.items.every(i => i.status === "suppressed" && i.preview === undefined)).toBe(true);
    expect(JSON.stringify(p)).not.toContain(old.content); expect(legacyMemoryPreviewToMarkdown(p)).not.toContain(old.content);
    expect(records[0].status).toBe(action === "forgotten" ? "forgotten" : "active");
  });
  it("withholds whole historical blocks when an old tombstone has no safe match length", () => {
    const r = { ...memory("已停用"), status: "forgotten" as const, suppression: { version: 1 as const, contentHashes: [memoryContentHash("旧句")], recordedAt: date } };
    expect(run([json([row("看似无关的旧记录")])], [r]).items[0]).toMatchObject({ status: "suppressed" });
  });
  it("uses only the old user field; never falls back to summary, assistant, task patterns or inference", () => {
    const p = run([conversation([{ type: "conversation_summary", content: "summary secret", assistantResponse: "assistant secret" },
      { type: "task_pattern", content: "pattern secret" }, { type: "user_state", userStatement: "state secret" },
      { type: "conversation_summary", userStatement: "唯一用户字段", assistantResponse: "assistant secret" }])]);
    expect(p.items).toHaveLength(1); expect(p.items[0].preview).toBe("唯一用户字段");
    expect(p.sources[0]).toMatchObject({ invalid: 1, ignored: 2 }); expect(p.complete).toBe(false);
  });
  it.each([{}, { version: 2, entries: [] }, null, "array future"])("rejects an unknown index envelope %j without rewriting it", input => {
    const source = json(input), original = source.text, p = run([source]);
    expect(p.sources[0].status).toBe("unsupported"); expect(p.complete).toBe(false); expect(p.items).toEqual([]); expect(source.text).toBe(original);
  });
  it("reports malformed JSON/JSONL and invalid rows without inventing empty authority", () => {
    const p = run([{ kind: "index", path: index, text: "{broken" }, { kind: "conversation", path: chat, text: "bad\n" + JSON.stringify({ type: "future", userStatement: "unknown secret" }) }]);
    expect(p.sources.map(s => s.status)).toEqual(["invalid", "unsupported"]); expect(p.sources[1].invalid).toBe(1); expect(p.items).toEqual([]); expect(p.complete).toBe(false);
    expect(run([json([null, row("bad", { id: "" }), row("bad", { status: ["active"] }), row("old", { status: "archived" }), row("ok")])]).sources[0]).toMatchObject({ invalid: 3, ignored: 1, entries: 1 });
  });
  it.each(["../private.md", "/private.md", "old/../private.md", "old/./private.md", "old//private.md", "old\\private.md", "C:/private.md", " bad.md", "bad.md\n"])("rejects noncanonical path %j even if caller allowlisted it", path => {
    const p = previewLegacyMemoryMigration([{ kind: "markdown", path, text: "DO-NOT-LEAK" }], [], [{ kind: "markdown", path }]);
    expect(p.sources[0].status).toBe("excluded"); expect(p.items).toEqual([]); expect(JSON.stringify(p)).not.toContain("DO-NOT-LEAK");
  });
  it("keeps allowlist, privacy exclusion and unavailable states ahead of snapshot parsing", () => {
    const p = previewLegacyMemoryMigration([json([row("DO-NOT-LEAK")]), { kind: "markdown", path: "别的/资料.md", text: "DO-NOT-LEAK" }], [], allowed, ["旧记忆"]);
    expect(p.sources.every(s => s.status === "excluded" && s.sha256 === undefined)).toBe(true);
    expect(run([{ kind: "markdown", path: note, unavailable: "unreadable" }]).complete).toBe(false);
    expect(run([{ kind: "markdown", path: note, unavailable: "missing" }]).complete).toBe(true);
  });
  it("binds source kinds to their allowed paths so conversation cannot be displayed as whole Markdown", () => {
    const p = run([{ kind: "markdown", path: chat, text: JSON.stringify({ assistantResponse: "ASSISTANT-MUST-NOT-DISPLAY" }) }]);
    expect(p.sources[0].status).toBe("excluded"); expect(p.sources[0].sha256).toBeUndefined(); expect(p.items).toEqual([]);
    expect(JSON.stringify(p)).not.toContain("ASSISTANT-MUST-NOT-DISPLAY");
  });
  it("recognizes only an exact built-in empty template, preserving edited Markdown as unparsed history", () => {
    expect(run([{ kind: "markdown", path: note, text: "# 空模板\n", emptyTemplate: "# 空模板\n" }]).items).toEqual([]);
    const p = run([{ kind: "markdown", path: note, text: "# 空模板\n\n用户编辑", emptyTemplate: "# 空模板\n" }]);
    expect(p.items[0].preview).toContain("用户编辑"); expect(p.counts.unique).toBe(1);
  });
  it("caps all examined rows, including invalid/ignored ones, and reports partial results", () => {
    const p = run([json(Array(limits.entries).fill(null)), conversation([{ type: "conversation_summary", userStatement: "未处理" }])]);
    expect(p.sources[0].invalid).toBe(500); expect(p.sources[1].status).toBe("limit"); expect(p.items).toEqual([]); expect(p.complete).toBe(false);
    const duplicate = run([json(Array(limits.entries + 1).fill(row("same")))]);
    expect(duplicate.counts).toMatchObject({ reviewedEntries: 500, unique: 1, duplicates: 499 }); expect(duplicate.complete).toBe(false);
  });
  it("bounds source count, UTF-8 byte totals and displayed text without treating fragments as complete", () => {
    const sources = Array.from({ length: 9 }, (_, i) => ({ kind: "markdown" as const, path: `旧/${i}.md`, text: "x" }));
    expect(previewLegacyMemoryMigration(sources, [], sources.map(({ kind, path }) => ({ kind, path }))).counts.omittedSources).toBe(1);
    expect(run([{ kind: "markdown", path: note, text: "中".repeat(Math.floor(limits.sourceBytes / 3) + 1) }]).sources[0].status).toBe("too_large");
    const largeSources = ["x".repeat(limits.sourceBytes), "y".repeat(limits.sourceBytes), "z"].map((text, i) => ({ kind: "markdown" as const, path: `旧/大页${i}.md`, text }));
    const p = previewLegacyMemoryMigration(largeSources, [], largeSources.map(({ kind, path }) => ({ kind, path })));
    expect(p.sources[2].status).toBe("too_large"); expect(p.items[0].truncated).toBe(true); expect(p.items[0].preview?.length).toBe(1200); expect(p.complete).toBe(false);
  });
  it("renders old Markdown/HTML/images/fences as inert quoted text", () => {
    const malicious = "# heading\n![[私有附件.png]] ![x](https://synthetic.invalid/image) <img src='https://synthetic.invalid/i'>\n```\n[click](https://synthetic.invalid)\r$x$\r> old";
    const output = legacyMemoryPreviewToMarkdown(run([{ kind: "markdown", path: note, text: malicious }]));
    expect(output).not.toContain("![["); expect(output).not.toContain("![x]("); expect(output).not.toContain("<img"); expect(output).not.toContain("```");
    expect(output).toContain("&lt;img"); expect(output).toContain("\\# heading"); expect(output).toContain("仅查看和去重"); expect(output).not.toContain("\r"); expect(output).toContain("\\$x\\$");
  });
});
