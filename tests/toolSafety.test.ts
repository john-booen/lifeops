import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../src/agentRuntime";
import { AGENT_TOOLS, getLifeOpsTool, runConfirmedToolAction } from "../src/toolRegistry";
import type { StoreHost } from "../src/store/settingsSlice";
import { applyTaskSlice } from "../src/store/taskSlice";
import { createPersonalMemory } from "../src/personalMemory";

vi.mock("obsidian", () => ({ Notice: class {}, normalizePath: (path: string) => path }));

class SafetyStore {
  settings = { folders: { aiReports: "AI" } };
  json = new Map<string, unknown>();
  files = new Map<string, string>();
  writes = 0;
  corruptAppend = false;
  path(...parts: string[]) { return parts.join("/"); }
  async readJson<T>(path: string, fallback: T): Promise<T> { return (this.json.get(path) as T) ?? fallback; }
  async writeJson(path: string, value: unknown) { this.writes++; this.json.set(path, structuredClone(value)); }
  async readPath(path: string) { return this.files.get(path) ?? ""; }
  getFile(path: string) { return this.files.has(path) ? { path } : null; }
  async writeFile(path: string, value: string) { this.writes++; this.files.set(path, value); }
  async deleteFile(path: string) { this.writes++; this.files.delete(path); }
  memoryFilePath(name: string) { return `AI/Memory/${name}`; }
  personalMemoryPath() { return "AI/Memory/PersonalMemory.json"; }
  async appendMemoryNote(name: string, value: string) {
    const path = this.memoryFilePath(name);
    await this.writeFile(path, (this.files.get(path) ?? "") + (this.corruptAppend ? "broken" : value));
  }
  async readTaskDb(options?: { readOnly?: boolean }) {
    expect(options?.readOnly).toBe(true);
    return { tasks: [{ id: "t1", title: "测试任务", status: "active" }] };
  }
  document = { version: 1 as const, updatedAt: new Date().toISOString(), records: [createPersonalMemory({ id: "m1", kind: "core_profile", content: "旧记忆" })] };
  async readPersonalMemories() { return structuredClone(this.document); }
  async writePersonalMemories(document: typeof this.document) {
    this.writes++;
    this.document = structuredClone(document);
    if (this.corruptAppend) this.document.records = [];
  }
  async writePersonalMemoryReview() { return "review.md"; }
}

function setup() {
  const store = new SafetyStore();
  const context = {
    store: store as unknown as StoreHost,
    refreshViews: vi.fn(async () => undefined),
    captureScreenshotAnalysis: vi.fn(async () => { throw new Error("must not capture"); })
  };
  return { store, context, runtime: new AgentRuntime(context) };
}

afterEach(() => vi.restoreAllMocks());

const confirmationCases = [
  { name: "delete_task", args: { taskIdOrTitle: "t1" }, type: "delete_task" },
  { name: "review_personal_memory", args: { memoryId: "m1", decision: "confirm" }, type: "review_memory" },
];

describe("central Tool Safety", () => {
  it("does not repair a legacy task mirror while preparing a deletion", async () => {
    class LegacyStore {
      settings = { folders: { aiReports: "AI" } };
      path(...parts: string[]) { return parts.join("/"); }
      taskMirrorPath() { return "tasks.md"; }
      taskDbPath() { return "tasks.json"; }
      getFile() { return null; }
      async readJson() { return { tasks: [{ id: "legacy", title: "旧任务", status: "active" }] }; }
    }
    applyTaskSlice(LegacyStore as any);
    const store = new LegacyStore() as any;
    store.writeTaskMirror = vi.fn(async () => { throw new Error("unexpected mirror write"); });
    const runtime = new AgentRuntime({ store, refreshViews: async () => undefined });
    const result = await runtime.executeAiToolCall({ name: "delete_task", arguments: { taskIdOrTitle: "legacy" } }, "kimi");
    expect(result.success).toBe(true);
    expect(result.actions[0].taskIds).toEqual(["legacy"]);
    expect(store.writeTaskMirror).not.toHaveBeenCalled();
  });
  for (const source of ["kimi", "qwen-omni", "system"] as const) {
    it.each(confirmationCases)(`${source}: $name has zero writes before UI confirmation`, async ({ name, args, type }) => {
      const { store, context, runtime } = setup();
      const execute = vi.spyOn(getLifeOpsTool(name)!, "execute");
      const request = { toolName: name, arguments: { ...args, confirmedByUser: true }, source,
        callId: "proposal-1", userMessage: "确认执行", confirmedByUser: true };
      const result = await runtime.executeToolCall(request);
      const retry = await new AgentRuntime(context).executeToolCall(request);
      expect(result.success).toBe(true);
      expect(result.actions[0].type).toBe(type);
      expect(retry.actions[0].id).toBe(result.actions[0].id);
      expect(store.writes).toBe(0);
      expect(store.json.size).toBe(0);
      expect(execute).not.toHaveBeenCalled();
      expect(context.captureScreenshotAnalysis).not.toHaveBeenCalled();
    });
  }



  it("rejects forbidden and unknown tools before claiming the ledger", async () => {
    const { runtime, store } = setup();
    const tool = getLifeOpsTool("delete_task")!;
    const previous = tool.safety;
    try {
      tool.safety = "forbidden";
      for (const name of [tool.name, "unknown_tool"]) {
        expect((await runtime.executeAiToolCall({ name, arguments: {} }, "kimi")).success).toBe(false);
      }
      expect(store.writes).toBe(0);
    } finally { tool.safety = previous; }
  });

  it("fails closed when confirmation preparation fails or is absent", async () => {
    const { runtime, store } = setup();
    const tool = getLifeOpsTool("delete_task")!;
    const previous = tool.prepareConfirmation;
    try {
      for (const prepare of [undefined, async () => { throw new Error("read failed"); }]) {
        tool.prepareConfirmation = prepare;
        expect((await runtime.executeAiToolCall({ name: tool.name, arguments: { taskIdOrTitle: "t1" } }, "kimi")).success).toBe(false);
      }
      expect(store.writes).toBe(0);
    } finally { tool.prepareConfirmation = previous; }
  });

  it("allows a safe query attempt without intent but refuses a fabricated unverified body", async () => {
    const { runtime } = setup();
    const execute = vi.spyOn(getLifeOpsTool("query_vault")!, "execute")
      .mockResolvedValue({ success: true, output: "只读结果", actions: [] });
    const result=await runtime.executeAiToolCall({ name: "query_vault", arguments: {} }, "kimi");
    expect(result.success).toBe(false);expect(result.output).not.toContain("只读结果");
    expect(execute).toHaveBeenCalledOnce();
  });
});

describe("confirmed personal memory writes", () => {
  it("saves a conversation fact directly, deduplicates the call and supports undo", async () => {
    const { runtime, store } = setup();
    const call = { id: "memory", name: "append_memory_note", arguments: { content: "喜欢早起" } };
    const result = await runtime.executeAiToolCall(call, "kimi");
    expect(result.success, result.output).toBe(true); expect(result.actions).toEqual([]);
    expect(result.receipt).toBeDefined();
    expect(store.document.records.find(r => r.content === "喜欢早起")).toMatchObject({status:"active",tags:expect.arrayContaining(["对话"])});
    const writes = store.writes;
    expect((await runtime.executeAiToolCall(call, "kimi")).receipt).toEqual(result.receipt);
    expect(store.writes).toBe(writes);
    expect((await runtime.executeAiToolCall({...call,arguments:{content:"另一条"}}, "kimi")).success).toBe(false);
    await runtime.undoOperation(result.receipt!.operationId);
    expect(store.document.records.some(r => r.content === "喜欢早起")).toBe(false);
  });

  it("reports failed canonical readback without touching the legacy archive", async () => {
    const { runtime, store } = setup();
    const path = store.memoryFilePath("当前状态.md"); store.files.set(path, "原内容"); store.corruptAppend = true;
    const result = await runtime.executeAiToolCall({ name: "append_memory_note", arguments: { content: "新增内容" } }, "kimi");
    expect(result.success).toBe(false); expect(result.output).toContain("读回校验失败");
    expect(store.files.get(path)).toBe("原内容");
  });

  it("rejects a memory filename outside the supported list without writing", async () => {
    const { runtime, store } = setup();
    const result = await runtime.executeAiToolCall({ name: "append_memory_note",
      arguments: { content: "内容", fileName: "../../elsewhere.md" } }, "kimi");
    expect(result.success).toBe(false);
    expect(store.document.records.some(record => record.content === "内容")).toBe(false);
    expect(store.files.size).toBe(0);
  });
});
