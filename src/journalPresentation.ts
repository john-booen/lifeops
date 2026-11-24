import type { App, EventRef, MarkdownView } from "obsidian";

/** Cosmetic work waits until typing pauses; no document reads in editor-change. */
export function watchJournalPresentation(
  app: App,
  dailyRoot: () => string,
  registerEvent: (event: EventRef) => void,
  isCurrent: () => boolean
): () => void {
  let stopped = false, allViews = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const edited = new Set<MarkdownView>();
  const changedPaths = new Set<string>();
  const current = () => !stopped && isCurrent();
  const schedule = () => {
    if (!current()) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!current()) return;
      const root = dailyRoot();
      for (const leaf of app.workspace.getLeavesOfType("markdown")) {
        const view = leaf.view as MarkdownView;
        if (allViews || edited.has(view) || (view.file && changedPaths.has(view.file.path))) {
          refreshJournalViewPresentation(app, root, view);
        }
      }
      allViews = false;
      edited.clear();
      changedPaths.clear();
    }, 200);
  };
  const refreshAll = () => {
    if (!current()) return;
    allViews = true;
    schedule();
  };
  registerEvent(app.workspace.on("file-open", refreshAll));
  registerEvent(app.workspace.on("layout-change", refreshAll));
  registerEvent(app.workspace.on("editor-change", (_editor, info) => {
    if (!current()) return;
    // Embedded editors may provide MarkdownFileInfo rather than a workspace view.
    if ("containerEl" in info) edited.add(info as MarkdownView);
    else if (info.file) changedPaths.add(info.file.path);
    schedule();
  }));
  registerEvent(app.metadataCache.on("changed", file => {
    if (!current()) return;
    changedPaths.add(file.path);
    schedule();
  }));
  app.workspace.onLayoutReady(refreshAll);
  return () => {
    stopped = true;
    clearTimeout(timer);
    edited.clear();
    changedPaths.clear();
  };
}

/** Presentation only: never rewrite a journal or a global Obsidian preference. */
export function refreshJournalPresentation(app: App, dailyRoot: string): void {
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    refreshJournalViewPresentation(app, dailyRoot, leaf.view as MarkdownView);
  }
}

function refreshJournalViewPresentation(app: App, dailyRoot: string, view: MarkdownView): void {
    const prefix = `${dailyRoot.replace(/\/+$/, "")}/`;
    const file = view.file;
    const journal = Boolean(file?.path.startsWith(prefix));
    setClass(view, "lifeops-journal-note", journal);
    let duplicateTitle = false;
    if (journal && file) {
      // Live editor content wins over the metadata cache, which may lag edits.
      if (view.getMode() === "source" && view.editor) {
        const first = view.editor.getLine(0);
        const lineCount = view.editor.lineCount();
        let start = 0;
        if (first === "---") {
          for (let line = 1; line < Math.min(lineCount, 100); line++) {
            if (view.editor.getLine(line) === "---") { start = line + 1; break; }
          }
        }
        for (let line = start; line < Math.min(lineCount, start + 8); line++) {
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
    setClass(view, "lifeops-journal-has-title", duplicateTitle);
}

function setClass(view: MarkdownView, name: string, enabled: boolean): void {
  if (view.containerEl.classList.contains(name) !== enabled) view.containerEl.classList.toggle(name, enabled);
}

export function clearJournalPresentation(app: App): void {
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    leaf.view.containerEl.classList.remove("lifeops-journal-note", "lifeops-journal-has-title");
  }
}
