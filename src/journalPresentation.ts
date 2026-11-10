import type { App, MarkdownView } from "obsidian";

/** Presentation only: never rewrite a journal or a global Obsidian preference. */
export function refreshJournalPresentation(app: App, dailyRoot: string): void {
  const prefix = `${dailyRoot.replace(/\/+$/, "")}/`;
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const view = leaf.view as MarkdownView;
    const file = view.file;
    const journal = Boolean(file?.path.startsWith(prefix));
    view.containerEl.classList.toggle("lifeops-journal-note", journal);
    let duplicateTitle = false;
    if (journal && file) {
      // Live editor content wins over the metadata cache, which may lag edits.
      if (view.getMode() === "source" && view.editor) {
        const first = view.editor.getLine(0);
        let start = 0;
        if (first === "---") {
          for (let line = 1; line < Math.min(view.editor.lineCount(), 100); line++) {
            if (view.editor.getLine(line) === "---") { start = line + 1; break; }
          }
        }
        for (let line = start; line < Math.min(view.editor.lineCount(), start + 8); line++) {
          const text = view.editor.getLine(line).trim();
          if (!text) continue;
          duplicateTitle = text.replace(/^#\s+/, "") === file.basename && /^#\s+/.test(text);
          break;
        }
      } else {
        const first = app.metadataCache.getFileCache(file)?.headings?.[0];
        duplicateTitle = first?.level === 1 && first.heading === file.basename;
      }
    }
    view.containerEl.classList.toggle("lifeops-journal-has-title", duplicateTitle);
  }
}

export function clearJournalPresentation(app: App): void {
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    leaf.view.containerEl.classList.remove("lifeops-journal-note", "lifeops-journal-has-title");
  }
}
