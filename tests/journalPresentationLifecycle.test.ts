import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, EventRef } from "obsidian";
import { watchJournalPresentation } from "../src/journalPresentation";

function note(path: string, text = "# 2026-11-24\n\n虚构正文") {
  let lines = text.split("\n");
  const names = new Set<string>();
  const view = {
    file: { path, basename: path.split("/").at(-1)!.replace(/\.md$/, "") },
    getMode: () => "source",
    editor: { getLine: vi.fn((i: number) => lines[i] ?? ""), lineCount: () => lines.length },
    containerEl: { classList: {
      contains: (name: string) => names.has(name),
      toggle: vi.fn((name: string, on: boolean) => on ? names.add(name) : names.delete(name))
    } }
  };
  return { view, names, setText: (text: string) => { lines = text.split("\n"); } };
}

function host() {
  const first = note("日记/2026-11-24.md");
  const other = note("日记/2026-11-23.md", "# 2026-11-23\n\n另一篇虚构正文");
  const handlers = new Map<string, (...args: any[]) => void>();
  const on = (name: string, callback: (...args: any[]) => void) => {
    handlers.set(name, callback); return {} as EventRef;
  };
  let leaves = [first, other].map(note => ({ view: note.view }));
  let ready!: () => void, current = true, root = "日记";
  const scan = vi.fn(() => leaves);
  const cache = vi.fn(() => ({ headings: [{ level: 1, heading: "2026-11-24" }] }));
  const app = { workspace: { on, getLeavesOfType: scan, onLayoutReady: (cb: () => void) => { ready = cb; } },
    metadataCache: { on, getFileCache: cache } } as unknown as App;
  const stop = watchJournalPresentation(app, () => root, () => {}, () => current);
  return { first, other, scan, cache, stop, ready: () => ready(), emit: (name: string, ...args: any[]) => handlers.get(name)!(...args),
    closeFirst: () => { leaves = leaves.filter(leaf => leaf.view !== first.view); },
    stale: () => { current = false; }, setRoot: (value: string) => { root = value; } };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("native Markdown editor presentation scheduling (fictional host)", () => {
  it("does no synchronous workspace/text/style work during a typing and deletion burst", () => {
    const h = host(); h.ready(); vi.advanceTimersByTime(200);
    h.scan.mockClear(); h.first.view.editor.getLine.mockClear(); h.other.view.editor.getLine.mockClear();
    h.first.view.containerEl.classList.toggle.mockClear();
    for (let i = 0; i < 100; i++) {
      h.first.setText(`# 2026-11-24\n\n${i % 2 ? "打字后删除" : "打字后删"}`);
      h.emit("editor-change", h.first.view.editor, h.first.view);
      vi.advanceTimersByTime(20);
    }
    vi.advanceTimersByTime(179);
    expect(h.scan.mock.calls.length).toBe(0);
    expect(h.first.view.editor.getLine.mock.calls.length).toBe(0);
    expect(h.other.view.editor.getLine.mock.calls.length).toBe(0);
    expect(h.first.view.containerEl.classList.toggle.mock.calls.length).toBe(0);
    vi.advanceTimersByTime(1);
    expect(h.scan).toHaveBeenCalledTimes(1);
    expect(h.first.view.editor.getLine).toHaveBeenCalled();
    expect(h.other.view.editor.getLine.mock.calls.length).toBe(0);
    expect(h.first.view.containerEl.classList.toggle.mock.calls.length).toBe(0);
    h.stop();
  });

  it("uses the latest heading after a burst, including embedded-editor file info", () => {
    const h = host(); h.ready(); vi.advanceTimersByTime(200);
    h.first.setText("---\ntags: [虚构]\n---\n\n# 修改过的标题\n正文");
    h.emit("editor-change", h.first.view.editor, { file: h.first.view.file });
    expect(h.first.names.has("lifeops-journal-has-title")).toBe(true);
    vi.advanceTimersByTime(200);
    expect(h.first.names.has("lifeops-journal-has-title")).toBe(false);
    expect(h.first.names.has("lifeops-journal-note")).toBe(true);
    h.stop();
  });

  it("coalesces saved-file metadata updates and only reads the matching view", () => {
    const h = host(); h.first.view.getMode = () => "preview";
    for (let i = 0; i < 50; i++) h.emit("changed", h.first.view.file);
    expect(h.scan.mock.calls.length).toBe(0);
    vi.advanceTimersByTime(200);
    expect(h.scan).toHaveBeenCalledTimes(1); expect(h.cache).toHaveBeenCalledTimes(1);
    expect(h.other.view.editor.getLine.mock.calls.length).toBe(0);
    expect(h.first.names.has("lifeops-journal-has-title")).toBe(true);
    h.stop();
  });

  it("rechecks file and root changes without leaving old journal styling", () => {
    const h = host(); h.ready(); vi.advanceTimersByTime(200);
    h.first.view.file.path = "日记备份/2026-11-24.md";
    h.emit("file-open", h.first.view.file); h.emit("layout-change");
    vi.advanceTimersByTime(200);
    expect(h.first.names.size).toBe(0);
    expect(h.other.names.has("lifeops-journal-note")).toBe(true);
    h.setRoot("日记备份"); h.emit("layout-change"); vi.advanceTimersByTime(200);
    expect(h.first.names.has("lifeops-journal-note")).toBe(true);
    expect(h.other.names.size).toBe(0);
    h.stop();
  });

  it("does not read a view closed before the deferred refresh", () => {
    const h = host(); h.emit("editor-change", h.first.view.editor, h.first.view);
    h.closeFirst(); vi.advanceTimersByTime(200);
    expect(h.first.view.editor.getLine.mock.calls.length).toBe(0);
    expect(h.other.view.editor.getLine.mock.calls.length).toBe(0);
    h.stop();
  });

  it.each(["stop", "stale"] as const)("ignores queued work and late callbacks after %s", boundary => {
    const h = host(); h.emit("editor-change", h.first.view.editor, h.first.view);
    h[boundary](); h.ready(); h.emit("changed", h.first.view.file);
    vi.advanceTimersByTime(1000);
    expect(h.scan.mock.calls.length).toBe(0);
    expect(h.first.names.size).toBe(0);
    h.stop();
  });
});
