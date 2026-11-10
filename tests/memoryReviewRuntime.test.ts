import { describe, expect, it, vi } from "vitest";
import { OperationLedger } from "../src/dataFoundation/operationLedger";
import { createPersonalMemory, emptyPersonalMemoryDocument } from "../src/personalMemory";
import type { PersonalMemoryDocument, PersonalMemoryReview } from "../src/personalMemory";
import type { StoreHost } from "../src/store/settingsSlice";
import { getLifeOpsTool, runConfirmedToolAction } from "../src/toolRegistry";

class MemoryReviewStore {
  readonly settings = { folders: { aiReports: "LifeOps/Output/AI" } };
  readonly files = new Map<string, unknown>();
  document: PersonalMemoryDocument;
  deletedTaskIds: string[] = [];
  tasks = [
    { id: "task-a", title: "任务 A", status: "active" },
    { id: "task-b", title: "任务 B", status: "active" }
  ];
  taskMirrorWrites = 0;
  reviewWrites = 0;

  constructor() {
    const candidate = createPersonalMemory({
      kind: "pattern_candidate",
      content: "用户可能习惯在夜间交易",
      truth: "inference",
      sourceRefs: [{
        sourceId: "journal-1",
        path: "日记/2026-07-28.md",
        capturedAt: "2026-07-28T01:00:00.000Z"
      }]
    }, "2026-07-28T01:00:00.000Z");
    this.document = { ...emptyPersonalMemoryDocument(), records: [candidate] };
  }

  path(...parts: string[]): string {
    return parts.join("/");
  }

  async readJson<T>(filePath: string, fallback: T): Promise<T> {
    return (this.files.get(filePath) as T | undefined) ?? fallback;
  }

  async writeJson(filePath: string, value: unknown): Promise<void> {
    this.files.set(filePath, structuredClone(value));
  }

  async readPersonalMemories(): Promise<PersonalMemoryDocument> {
    return this.document;
  }

  async writePersonalMemories(document: PersonalMemoryDocument): Promise<void> {
    this.document = structuredClone(document);
  }

  async reviewPersonalMemory(id: string, review: PersonalMemoryReview) {
    const current = this.document.records.find((record) => record.id === id);
    if (!current) return null;
    if (review.decision === "forget") {
      this.document = { ...this.document, records: [] };
      return null;
    }
    const updated = {
      ...current,
      content: review.decision === "correct" ? review.content : current.content,
      status: "active" as const
    };
    this.document = { ...this.document, records: [updated] };
    return updated;
  }

  async writePersonalMemoryReview(): Promise<string> {
    this.reviewWrites += 1;
    return "LifeOps/Output/AI/Workflows/personal-memory-review.md";
  }

  async deleteTask(taskId: string): Promise<void> {
    this.deletedTaskIds.push(taskId);
  }

  async readTaskDb() {
    return { tasks: structuredClone(this.tasks) };
  }

  async writeTaskDb(database: { tasks: Array<{ id: string; title: string; status: string }> }): Promise<void> {
    this.tasks = structuredClone(database.tasks);
  }

  async writeTaskMirror(): Promise<void> {
    this.taskMirrorWrites += 1;
  }
}

describe("personal memory review and undo runtime", () => {
  it("lists candidates and requires a confirmation card before correction", async () => {
    const store = new MemoryReviewStore();
    const context = {
      store: store as unknown as StoreHost,
      refreshViews: vi.fn(async () => undefined)
    };
    const list = await getLifeOpsTool("list_personal_memory_candidates")?.execute({}, context, {
      operationId: "list-1",
      source: "kimi"
    });
    expect(list?.output).toContain("用户可能习惯在夜间交易");
    expect(list?.output).toContain(store.document.records[0].id);

    const review = await getLifeOpsTool("review_personal_memory")?.prepareConfirmation?.({
      memoryId: store.document.records[0].id,
      decision: "correct",
      correctedContent: "用户明确要求夜间不做交易"
    }, context, {
      operationId: "review-1",
      source: "kimi"
    });
    expect(review?.actions[0]).toMatchObject({
      type: "review_memory",
      memoryDecision: "correct",
      correctedMemoryContent: "用户明确要求夜间不做交易"
    });
    expect(store.document.records[0].status).toBe("candidate");

    await runConfirmedToolAction(review!.actions[0], context);
    expect(store.document.records[0]).toMatchObject({
      content: "用户明确要求夜间不做交易",
      status: "active"
    });
    expect(store.reviewWrites).toBe(1);

    const ledger = new OperationLedger(store);
    expect(await ledger.latestReversible()).toMatchObject({
      toolName: "confirm_review_memory",
      status: "verified"
    });
    await getLifeOpsTool("undo_latest_operation")?.execute({}, context, {
      operationId: "undo-review-1",
      source: "kimi"
    });
    expect(store.document.records[0]).toMatchObject({
      content: "用户可能习惯在夜间交易",
      status: "candidate"
    });
    expect(store.reviewWrites).toBe(2);
  });

  it("makes the latest reversible operation reachable through a tool", async () => {
    const store = new MemoryReviewStore();
    const ledger = new OperationLedger(store);
    await ledger.claim({
      operationId: "create-task-1",
      toolName: "create_task",
      source: "kimi",
      arguments: { title: "稍后撤销" }
    });
    await ledger.verify("create-task-1", {
      success: true,
      output: "created",
      actions: [],
      undo: { kind: "delete_task", taskId: "task-1" }
    });
    const context = {
      store: store as unknown as StoreHost,
      refreshViews: vi.fn(async () => undefined)
    };
    const result = await getLifeOpsTool("undo_latest_operation")?.execute({}, context, {
      operationId: "undo-1",
      source: "kimi"
    });

    expect(result?.success).toBe(true);
    expect(store.deletedTaskIds).toEqual(["task-1"]);
    expect(await ledger.latestReversible()).toBeNull();
  });

  it("audits, verifies, deduplicates and restores confirmed task deletion", async () => {
    const store = new MemoryReviewStore();
    const context = {
      store: store as unknown as StoreHost,
      refreshViews: vi.fn(async () => undefined)
    };
    const action = {
      id: "confirmed-delete-a",
      type: "delete_task" as const,
      title: "删除任务",
      description: "test",
      content: "任务 A",
      date: "2026-07-28",
      taskIds: ["task-a"]
    };

    await runConfirmedToolAction(action, context);
    expect(store.tasks.map((task) => task.id)).toEqual(["task-b"]);
    expect(await new OperationLedger(store).latestReversible()).toMatchObject({
      toolName: "confirm_delete_task",
      status: "verified"
    });

    await runConfirmedToolAction(action, context);
    expect(store.tasks.map((task) => task.id)).toEqual(["task-b"]);

    await getLifeOpsTool("undo_latest_operation")?.execute({}, context, {
      operationId: "undo-delete-a",
      source: "kimi"
    });
    expect(store.tasks.map((task) => task.id).sort()).toEqual(["task-a", "task-b"]);
    expect(store.taskMirrorWrites).toBeGreaterThanOrEqual(2);
  });
});
