import { describe, expect, it, vi } from "vitest";
import { executeVaultQuery } from "../src/vaultQuery";

vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));

const journalFiles = [
  file("日记/2026/07/2026-07-26早.md", "# 早\n\n今天跑步。", 10),
  file("日记/2026/07/2026-07-27晚.md", "# 晚\n\n复盘了交易。", 20)
];

describe("generic Vault query", () => {
  it("finds the latest journal by Vault date, not by a recent-days shortcut", async () => {
    const output = await executeVaultQuery(store(), { domain: "journal", operation: "get" });
    expect(output).toContain("2026-07-27");
    expect(output).toContain("2026-07-27晚.md");
    expect(output).toContain("复盘了交易");
  });

  it("returns date-specific journal source evidence", async () => {
    const output = await executeVaultQuery(store(), { domain: "journal", operation: "get", date: "2026-07-26" });
    expect(output).toContain("2026-07-26早.md");
    expect(output).toContain("今天跑步");
  });

  it("keeps non-journal reads behind the same gateway", async () => {
    const host = store();
    const output = await executeVaultQuery(host, { domain: "trade", operation: "search", query: "模型" });
    expect(host.searchKnowledge).not.toHaveBeenCalled();
    expect(output).toContain("交易/模型.md");
    expect(output).toContain("来源原文");
  });

  it("reads confirmed personal memory without mixing it into ordinary note search", async () => {
    const host = store();
    host.buildPersonalMemoryContext = vi.fn().mockResolvedValue("### 核心画像\n- 用户偏好简洁直接的沟通。");
    const output = await executeVaultQuery(host, { domain: "memory", operation: "get", query: "你记得我什么" });
    expect(host.buildPersonalMemoryContext).toHaveBeenCalledWith("你记得我什么");
    expect(host.searchKnowledge).not.toHaveBeenCalled();
    expect(output).toContain("偏好简洁直接");
  });
});

function store() {
  const note = file("交易/模型.md", "来源原文：等待突破后确认。", 30);
  return {
    settings: { folders: { dailyRoot: "日记", tradingModels: "交易",aiReports:"AI" } },
    path:(...parts:string[])=>parts.join("/"),
    personalMemoryPath: () => "memory.json",
    getFile: (path: string) => [...journalFiles, note].find(entry => entry.path === path) ?? null,
    readPath: async (path:string) => [...journalFiles,note].find(entry=>entry.path===path)?.content??"",
    app: {
      vault: {
        getMarkdownFiles: () => [...journalFiles, note],
        read: async (entry: ReturnType<typeof file>) => entry.content
      }
    },
    searchKnowledge: vi.fn().mockResolvedValue([{
      sourceId: "vault:交易/模型.md",
      path: "交易/模型.md",
      title: "交易模型",
      category: "trading-models",
      mtime: note.stat.mtime,
      excerpt: "来源原文：等待突破后确认。"
    }])
  } as any;
}

function file(path: string, content: string, mtime: number) {
  const name = path.split("/").at(-1)!;
  return { path, name, basename: name.replace(/\.md$/, ""), stat: { mtime }, content };
}
