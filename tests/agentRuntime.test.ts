import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/agentRuntime";
import type { StoreHost } from "../src/store/settingsSlice";
import { appendEveningEntry } from "../src/features/journal/entry";

class RuntimeStore {
  readonly settings = { folders: { aiReports: "LifeOps/Output/AI" } };
  readonly jsonFiles = new Map<string, unknown>();
  readonly textFiles = new Map<string, string>();
  appendCount = 0;
  failNextAppend = false;

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
    return `LifeOps/Journal/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}${period}.md`;
  }

  async readPath(filePath: string): Promise<string> {
    return this.textFiles.get(filePath) ?? "";
  }

  async appendDaily(date: string, heading: string, line: string, period: "早" | "晚", original?: string): Promise<void> {
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error("simulated write failure");
    }
    const path = this.dailyNotePath(date, period);
    const current = this.textFiles.get(path) ?? `# ${date}${period}\n`;
    this.textFiles.set(path, period === "晚" ? appendEveningEntry(current, heading, line, original)
      : `${current.trimEnd()}\n\n## ${heading}\n\n${line}\n`);
    this.appendCount += 1;
  }
}

function createRuntime(store: RuntimeStore): AgentRuntime {
  return new AgentRuntime({
    store: store as unknown as StoreHost,
    refreshViews: async () => undefined
  });
}

describe("agent runtime durable operations", () => {
  it("does not append a journal entry twice across runtime instances", async () => {
    const store = new RuntimeStore();
    const request = {
      toolName: "append_journal_entry",
      arguments: {
        content: "今天完成了数据底座第一阶段。",
        date: "2026-07-27",
        period: "晚"
      },
      source: "kimi" as const,
      userMessage: "请写入晚间日记：今天完成了数据底座第一阶段。",
      callId: "journal-call-1"
    };

    const first = await createRuntime(store).executeToolCall(request);
    const second = await createRuntime(store).executeToolCall(request);

    expect(first.success).toBe(true);
    expect(first.output).toContain("读回校验");
    expect(second).toEqual(first);
    expect(store.appendCount).toBe(1);
  });

  it("does not mark a failed write as successful and permits a safe retry", async () => {
    const store = new RuntimeStore();
    store.failNextAppend = true;
    const request = {
      toolName: "append_journal_entry",
      arguments: {
        content: "失败后应当允许重试。",
        date: "2026-07-27",
        period: "晚"
      },
      source: "qwen-omni" as const,
      userMessage: "请写入晚间日记：失败后应当允许重试。",
      callId: "journal-call-retry"
    };

    const failed = await createRuntime(store).executeToolCall(request);
    const retried = await createRuntime(store).executeToolCall(request);

    expect(failed.success).toBe(false);
    expect(failed.output).toContain("没有完成");
    expect(retried.success).toBe(true);
    expect(store.appendCount).toBe(1);
  });
});
