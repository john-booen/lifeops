export interface JournalToolRead {
  name: string;
  phase: "fixture" | "prelude" | "current_turn";
  args: Record<string, unknown>;
  ok: boolean;
  output: string;
}
export interface JournalEvidenceCheck { from: string; to: string; includes: string[] }
const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)
  && Number.isFinite(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
const path = (value: unknown): value is string => typeof value === "string" && value.endsWith(".md")
  && !/^(?:\/|~|[a-z][a-z\d+.-]*:)/iu.test(value) && !/[\\\u0000-\u001f]/u.test(value)
  && value.split("/").every(part => part && part !== "." && part !== "..");

/** Inspect successful current-turn original bodies, never the model's prose or a tool's name alone. */
export function hasJournalEvidence(reads: JournalToolRead[], expected: JournalEvidenceCheck): boolean {
  if (!date(expected.from) || !date(expected.to) || expected.from > expected.to || !expected.includes.length
    || expected.includes.some(text => typeof text !== "string" || !text)) return false;
  const notes: Array<{date:string;path:string;text:string}> = [];
  for (const read of reads) {
    if (!read.ok || read.phase !== "current_turn") continue;
    if (read.name === "get_summaries") {
      try {
        const data = JSON.parse(read.output);
        for (const note of data.originalEvidence?.notes ?? []) {
          if (date(note?.date) && path(note.path) && typeof note.text === "string") notes.push(note);
        }
      } catch { /* Invalid or summary-only output supplies no original body. */ }
    } else if (read.name === "query_vault" && read.args.domain === "journal" && ["get", "search"].includes(String(read.args.operation))) {
      for (const block of read.output.split(/(?:^|\n)### Journal Source\n/u).slice(1)) {
        const split = block.indexOf("\n\n"); if (split < 0) continue;
        const metadata = block.slice(0, split), body = block.slice(split + 2);
        const day = /^- date: (.+)$/mu.exec(metadata)?.[1], file = /^- path: (.+)$/mu.exec(metadata)?.[1];
        if (date(day) && path(file) && metadata.split("\n").includes("- source: vault")
          && metadata.split("\n").includes("- evidence: vault:" + file) && !metadata.includes("- bodyStatus:")) notes.push({date:day,path:file,text:body});
      }
    }
  }
  return notes.some(note => note.date >= expected.from && note.date <= expected.to && expected.includes.every(text => note.text.includes(text)));
}
