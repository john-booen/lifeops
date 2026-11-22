import { expect, it } from "vitest";
import { hasJournalEvidence, type JournalToolRead } from "./eval/journalEvidence";

const expected = { from: "2026-11-06", to: "2026-11-12", includes: ["感到焦虑", "容易拖延"] };
const note = { date: "2026-11-09", path: "Daily/2026-11-09.md", text: "今天感到焦虑，容易拖延。原因尚未记录。" };
const summary = (): JournalToolRead => ({ name: "get_summaries", phase: "current_turn", args: { includeOriginals: true }, ok: true,
  output: JSON.stringify({ originalEvidence: { notes: [note] } }) });
const journal = (): JournalToolRead => ({ name: "query_vault", phase: "current_turn", args: { domain: "journal", operation: "get" }, ok: true,
  output: `### Journal Source\n- date: ${note.date}\n- path: ${note.path}\n- source: vault\n- evidence: vault:${note.path}\n\n${note.text}` });

it.each([summary, journal])("accepts a successful current-turn original body through either production read route", make => {
  expect(hasJournalEvidence([make()], expected)).toBe(true);
});
it.each(["failed", "prelude", "fixture", "stats", "summary-only", "out-of-range", "invalid-date", "unsafe-path", "split-facts"])("rejects %s evidence instead of passing on a tool name", state => {
  const read = summary();
  if (state === "failed") read.ok = false;
  if (state === "prelude" || state === "fixture") read.phase = state;
  if (state === "stats") read.name = "get_stats";
  if (state === "summary-only") read.output = JSON.stringify({ text: note.text });
  if (state === "out-of-range") read.output = JSON.stringify({ originalEvidence: { notes: [{ ...note, date: "2026-11-05" }] } });
  if (state === "invalid-date") read.output = JSON.stringify({ originalEvidence: { notes: [{ ...note, date: "2026-11-31" }] } });
  if (state === "unsafe-path") read.output = JSON.stringify({ originalEvidence: { notes: [{ ...note, path: "../private.md" }] } });
  if (state === "split-facts") read.output = JSON.stringify({ originalEvidence: { notes: [{ ...note, text: "感到焦虑" }, { ...note, text: "容易拖延" }] } });
  expect(hasJournalEvidence([read], expected)).toBe(false);
});
it.each(["list", "memory", "unreadable", "missing-source", "mismatched-evidence", "metadata-only"])("rejects %s journal output without the required original body", state => {
  const read = journal();
  if (state === "list") read.args.operation = "list";
  if (state === "memory") read.args.domain = "memory";
  if (state === "unreadable") read.output = read.output.replace("\n\n", "\n- bodyStatus: unreadable\n\n");
  if (state === "missing-source") read.output = read.output.replace("- source: vault\n", "");
  if (state === "mismatched-evidence") read.output = read.output.replace("- evidence: vault:" + note.path, "- evidence: vault:other.md");
  if (state === "metadata-only") read.output = read.output.replace("\n\n" + note.text, "\n- quoted: " + note.text + "\n\nNo readable body.");
  expect(hasJournalEvidence([read], expected)).toBe(false);
});
