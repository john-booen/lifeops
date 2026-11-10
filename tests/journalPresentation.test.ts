import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { clearJournalPresentation, refreshJournalPresentation } from "../src/journalPresentation";

function fixture(path: string, content: string, mode = "source") {
  const names = new Set<string>();
  const view = {
    file: { path, basename: path.split("/").at(-1)!.replace(/\.md$/, "") },
    getMode: () => mode,
    editor: { getLine: (i: number) => content.split("\n")[i] ?? "", lineCount: () => content.split("\n").length },
    containerEl: { classList: { toggle: (s: string, on: boolean) => on ? names.add(s) : names.delete(s), remove: (...s: string[]) => s.forEach(x => names.delete(x)) } }
  };
  const app = { workspace: { getLeavesOfType: () => [{ view }] }, metadataCache: { getFileCache: () => ({ headings: [{ level: 1, heading: view.file.basename }] }) } } as unknown as App;
  return { app, view, names };
}

describe("journal presentation does not change note content or global preferences", () => {
  it("hides a duplicate filename only when the editor contains the same first heading", () => {
    const f = fixture("日记/2026-09-23早.md", "# 2026-09-23早\n\n正文");
    refreshJournalPresentation(f.app, "日记");
    expect([...f.names]).toEqual(["lifeops-journal-note", "lifeops-journal-has-title"]);
    f.view.editor.getLine = i => i === 0 ? "只有正文" : "";
    refreshJournalPresentation(f.app, "日记");
    expect(f.names.has("lifeops-journal-has-title")).toBe(false);
    clearJournalPresentation(f.app);
    expect(f.names.size).toBe(0);
  });
  it("does not apply to a neighboring folder or leave classes after switching files", () => {
    const f = fixture("日记/2026-09-23早.md", "# 2026-09-23早");
    refreshJournalPresentation(f.app, "日记");
    f.view.file.path = "日记备份/2026-09-23早.md";
    refreshJournalPresentation(f.app, "日记");
    expect(f.names.size).toBe(0);
  });
  it("handles frontmatter and reading mode without rewriting a title", () => {
    const f = fixture("日记/2026-09-23早.md", "---\ntags: [生活]\n---\n\n# 2026-09-23早\n");
    refreshJournalPresentation(f.app, "日记");
    expect(f.names.has("lifeops-journal-has-title")).toBe(true);
    f.view.getMode = () => "preview";
    refreshJournalPresentation(f.app, "日记");
    expect(f.names.has("lifeops-journal-has-title")).toBe(true);
  });
});
