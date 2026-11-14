import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/agentRuntime";
import { OperationLedger, type OperationLedgerDocument } from "../src/dataFoundation/operationLedger";
import type { StoreHost } from "../src/store/settingsSlice";

class LinkedNoteStore {
  readonly settings = {
    linkedNoteNames: { knowledge: "Cici 知识沉淀.md", trading: "Cici 交易模型迭代.md" },
    folders: {
      aiReports: "LifeOps/Output/AI",
      ideas: "LifeOps/Knowledge/Ideas",
      tradingModels: "LifeOps/Knowledge/TradeRules"
    }
  };
  readonly jsonFiles = new Map<string, unknown>();
  readonly textFiles = new Map<string, string>();
  failTradingDailyWrite = false;
  refreshCount = 0;

  path(...parts: string[]): string {
    return parts.join("/");
  }

  async readJson<T>(filePath: string, fallback: T): Promise<T> {
    return (this.jsonFiles.get(filePath) as T | undefined) ?? fallback;
  }

  async writeJson(filePath: string, value: unknown): Promise<void> {
    this.jsonFiles.set(filePath, structuredClone(value));
  }

  dailyNotePath(date: string, period: "早" | "晚"): string {
    return `日记/${date}${period}.md`;
  }

  async readPath(filePath: string): Promise<string> {
    return this.textFiles.get(filePath) ?? "";
  }

  getFile(filePath: string): { path: string } | null {
    return this.textFiles.has(filePath) ? { path: filePath } : null;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    this.textFiles.set(filePath, content);
  }

  async deleteFile(filePath: string): Promise<void> {
    this.textFiles.delete(filePath);
  }

  async appendKnowledgeNote(content: string, date: string): Promise<void> {
    const notePath = this.path(this.settings.folders.ideas, "Cici 知识沉淀.md");
    this.appendText(notePath, `\n## test\n\n${content.trim()}\n`);
    this.appendText(this.path(this.settings.folders.ideas, "每日记录", `${date}.md`), `\n## 灵感\n\n- [[${notePath.replace(/\.md$/, "")}|Cici 知识沉淀]]\n`);
  }

  async appendTradingModelNote(content: string, date: string): Promise<void> {
    const notePath = this.path(this.settings.folders.tradingModels, "Cici 交易模型迭代.md");
    this.appendText(notePath, `\n## test\n\n${content.trim()}\n`);
    if (this.failTradingDailyWrite) {
      throw new Error("simulated daily link failure");
    }
    this.appendText(this.path(this.settings.folders.tradingModels, "每日记录", `${date}.md`), `\n## 交易\n\n- [[${notePath.replace(/\.md$/, "")}|Cici 交易模型迭代]]\n`);
  }

  private appendText(filePath: string, content: string): void {
    this.textFiles.set(filePath, `${this.textFiles.get(filePath) ?? ""}${content}`);
  }
}

function createRuntime(store: LinkedNoteStore): AgentRuntime {
  return new AgentRuntime({
    store: store as unknown as StoreHost,
    refreshViews: async () => {
      store.refreshCount += 1;
    }
  });
}

describe("linked-note Agent Runtime writes", () => {
  it.each([
    {
      toolName: "append_knowledge_note",
      content: "把信息来源和推断分开记录。",
      folder: "LifeOps/Knowledge/Ideas",
      fileName: "Cici 知识沉淀.md",
      linkLabel: "Cici 知识沉淀"
    },
    {
      toolName: "append_trading_model_note",
      content: "没有止损位置就不入场。",
      folder: "LifeOps/Knowledge/TradeRules",
      fileName: "Cici 交易模型迭代.md",
      linkLabel: "Cici 交易模型迭代"
    }
  ])("writes and verifies both files for $toolName", async ({ toolName, content, folder, fileName, linkLabel }) => {
    const store = new LinkedNoteStore();
    const result = await createRuntime(store).executeToolCall({
      toolName,
      arguments: { content, date: "2026-08-15" },
      source: "kimi",
      userMessage: `请写入知识笔记和交易模型：${content}`,
      callId: `success-${toolName}`
    });

    const notePath = `${folder}/${fileName}`;
    expect(result.success).toBe(true);
    expect(result.output).toContain("读回校验");
    expect(store.textFiles.get(notePath)).toContain(content);
    expect(store.textFiles.get(`${folder}/每日记录/2026-08-15.md`)).toContain(`[[${notePath.replace(/\.md$/, "")}|${linkLabel}]]`);
  });

  it("rolls back both snapshots when the second write fails", async () => {
    const store = new LinkedNoteStore();
    const notePath = "LifeOps/Knowledge/TradeRules/Cici 交易模型迭代.md";
    const dailyPath = "LifeOps/Knowledge/TradeRules/每日记录/2026-08-15.md";
    store.textFiles.set(notePath, "original trading note");
    store.textFiles.set(dailyPath, "original daily note");
    store.failTradingDailyWrite = true;

    const result = await createRuntime(store).executeToolCall({
      toolName: "append_trading_model_note",
      arguments: { content: "这段不应残留", date: "2026-08-15" },
      source: "kimi",
      userMessage: "请写入交易模型：这段不应残留",
      callId: "failed-trading-write"
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("simulated daily link failure");
    expect(store.textFiles.get(notePath)).toBe("original trading note");
    expect(store.textFiles.get(dailyPath)).toBe("original daily note");
    expect(await new OperationLedger(store).latestReversible()).toBeNull();
  });

  it("undoes a verified write by restoring both files exactly", async () => {
    const store = new LinkedNoteStore();
    const notePath = "LifeOps/Knowledge/Ideas/Cici 知识沉淀.md";
    const dailyPath = "LifeOps/Knowledge/Ideas/每日记录/2026-08-15.md";
    store.textFiles.set(notePath, "original knowledge note");
    store.textFiles.set(dailyPath, "original daily note");
    const runtime = createRuntime(store);

    const result = await runtime.executeToolCall({
      toolName: "append_knowledge_note",
      arguments: { content: "撤销后不应存在", date: "2026-08-15" },
      source: "system",
      confirmedByUser: true,
      callId: "undo-knowledge-write"
    });
    expect(result.success).toBe(true);

    const ledger = new OperationLedger(store);
    const document = store.jsonFiles.get(ledger.filePath) as OperationLedgerDocument;
    expect(document.records[0].result?.undo).toMatchObject({
      kind: "restore_files",
      files: [
        { path: notePath, content: "original knowledge note", existed: true },
        { path: dailyPath, content: "original daily note", existed: true }
      ]
    });

    await runtime.undoOperation("undo-knowledge-write");

    expect(store.textFiles.get(notePath)).toBe("original knowledge note");
    expect(store.textFiles.get(dailyPath)).toBe("original daily note");
    expect(document.records[0].status).toBe("verified");
    expect((store.jsonFiles.get(ledger.filePath) as OperationLedgerDocument).records[0].status).toBe("reverted");
  });
});
