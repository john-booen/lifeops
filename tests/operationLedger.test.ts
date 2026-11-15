import { describe, expect, it, vi } from "vitest";
import {
  OperationLedger,
  operationFingerprint,
  type OperationLedgerDocument,
  type OperationLedgerHost
} from "../src/dataFoundation/operationLedger";

class MemoryLedgerHost implements OperationLedgerHost {
  readonly settings = { folders: { aiReports: "LifeOps/Output/AI" } };
  readonly files = new Map<string, unknown>();

  path(...parts: string[]): string {
    return parts.join("/");
  }

  async readJson<T>(filePath: string, fallback: T): Promise<T> {
    return (this.files.get(filePath) as T | undefined) ?? fallback;
  }

  async writeJson(filePath: string, value: unknown): Promise<void> {
    this.files.set(filePath, structuredClone(value));
  }
}

describe("operation ledger", () => {
  it.each(["{", '{"version":2,"records":[]}'])("refuses to compact unreadable or incompatible history (%s)", async start => {
    const ledger = new OperationLedger(new MemoryLedgerHost());
    const raw = start.padEnd(13 * 1024 * 1024);
    const replace = vi.fn(async () => undefined);
    await expect(ledger.compactRevertedSnapshots(async () => raw, replace)).rejects.toThrow("操作历史格式无法安全读取");
    expect(replace).not.toHaveBeenCalled();
  });

  it("does not fabricate receipts when a write was never claimed", async () => {
    const host = new MemoryLedgerHost(), ledger = new OperationLedger(host);
    await expect(ledger.verify("missing-write", { success: true, output: "虚构", actions: [] })).rejects.toThrow("未找到操作记录");
    expect(host.files.size).toBe(0);
  });

  it("does not let a late failed claim replace a newer verified attempt", async () => {
    const host = new MemoryLedgerHost(), ledger = new OperationLedger(host);
    const input = { operationId: "claim-late-failure", toolName: "create_task", source: "system" as const, arguments: { title: "纯虚构" } };
    const first = await ledger.claim(input);
    expect(await ledger.failClaim(first.record, "first failed")).toBe(true);
    const second = await ledger.claim(input);
    await ledger.verify(input.operationId, { success: true, output: "已保存", actions: [] });
    expect(await ledger.failClaim(first.record, "late old failure")).toBe(false);
    expect(await ledger.failClaim(second.record, "late settled failure")).toBe(false);
    expect((await ledger.claim(input)).record.status).toBe("verified");
  });
  it("returns a verified result for the same durable operation id", async () => {
    const host = new MemoryLedgerHost();
    const ledger = new OperationLedger(host, () => new Date("2026-07-27T12:00:00.000Z"));
    const request = {
      operationId: "call-1",
      toolName: "create_task",
      source: "kimi" as const,
      arguments: { title: "发材料", date: "明天" }
    };

    expect((await ledger.claim(request)).kind).toBe("execute");
    await ledger.verify(request.operationId, {
      success: true,
      output: "已创建任务：发材料。",
      actions: []
    });

    const duplicate = await ledger.claim(request);
    expect(duplicate.kind).toBe("cached");
    expect(duplicate.record.result?.output).toContain("已创建任务");
  });

  it("allows a failed operation to retry and preserves its attempt count", async () => {
    const host = new MemoryLedgerHost();
    const ledger = new OperationLedger(host);
    const request = {
      operationId: "call-retry",
      toolName: "complete_habit",
      source: "qwen-omni" as const,
      arguments: { name: "英语" }
    };

    await ledger.claim(request);
    await ledger.fail(request.operationId, "write failed");
    const retry = await ledger.claim(request);

    expect(retry.kind).toBe("execute");
    expect(retry.record.attempts).toBe(2);
  });

  it("rejects reuse of one operation id for a different payload", async () => {
    const host = new MemoryLedgerHost();
    const ledger = new OperationLedger(host);
    await ledger.claim({
      operationId: "call-collision",
      toolName: "create_task",
      source: "kimi",
      arguments: { title: "任务 A" }
    });

    const collision = await ledger.claim({
      operationId: "call-collision",
      toolName: "create_task",
      source: "kimi",
      arguments: { title: "任务 B" }
    });

    expect(collision.kind).toBe("collision");
  });

  it("keeps a stale executing operation blocked until explicit recovery", async () => {
    const host = new MemoryLedgerHost();
    const first = new OperationLedger(host, () => new Date("2026-07-27T12:00:00.000Z"));
    const request = {
      operationId: "call-stale",
      toolName: "append_journal_entry",
      source: "kimi" as const,
      arguments: { content: "stale" }
    };
    await first.claim(request);

    const resumed = new OperationLedger(host, () => new Date("2026-07-27T12:03:00.000Z"));
    const claim = await resumed.claim(request);

    expect(claim.kind).toBe("busy");
    expect(claim.record.attempts).toBe(1);
  });

  it("serializes concurrent ledger claims", async () => {
    const host = new MemoryLedgerHost();
    const ledgerA = new OperationLedger(host);
    const ledgerB = new OperationLedger(host);
    const [first, second] = await Promise.all([
      ledgerA.claim({
        operationId: "call-a",
        toolName: "create_task",
        source: "kimi",
        arguments: { title: "A" }
      }),
      ledgerB.claim({
        operationId: "call-b",
        toolName: "create_task",
        source: "kimi",
        arguments: { title: "B" }
      })
    ]);
    const document = host.files.get(ledgerA.filePath) as OperationLedgerDocument;

    expect(first.kind).toBe("execute");
    expect(second.kind).toBe("execute");
    expect(document.records.map((record) => record.operationId).sort()).toEqual(["call-a", "call-b"]);
  });

  it("uses stable argument ordering for fingerprints", () => {
    expect(operationFingerprint("x", { a: 1, b: 2 })).toBe(operationFingerprint("x", { b: 2, a: 1 }));
  });

  it("records triggers independently of source and leaves an unknown legacy target untouched", async () => {
    const host = new MemoryLedgerHost(), ledger = new OperationLedger(host, () => new Date("2026-11-08T12:00:00.000Z"));
    const save = async (operationId: string, toolName: string) => {
      await ledger.claim({ operationId, toolName, source: "system", arguments: {} });
      return ledger.verify(operationId, { success: true, output: "虚构保存", actions: [], undo: { kind: "delete_task", taskId: operationId } });
    };
    expect((await save("manual-task", "local_createTask")).trigger).toBe("user");
    expect((await save("auto-task", "local_checkHabitPunishments")).trigger).toBe("automatic");
    expect((await ledger.latestReversible())?.operationId).toBe("manual-task");

    const document = await host.readJson<OperationLedgerDocument>(ledger.filePath, { version: 1, records: [] });
    for (const record of document.records) delete record.trigger;
    await host.writeJson(ledger.filePath, document);
    expect((await ledger.latestReversible())?.operationId).toBe("manual-task");

    expect((await save("old-unknown", "legacy_unknown_operation")).trigger).toBeUndefined();
    expect(await ledger.latestReversible()).toBeNull();
    const undone: string[] = [];
    await ledger.revert("old-unknown", async descriptor => {
      if (descriptor.kind === "delete_task") undone.push(descriptor.taskId);
    });
    expect(undone).toEqual(["old-unknown"]);
    expect((await ledger.latestReversible())?.operationId).toBe("manual-task");

    expect((await save("reading-index", "local_index_reading")).trigger).toBe("automatic");
    expect((await save("learning-note", "local_capture_learning_note")).trigger).toBe("automatic");
    expect((await ledger.latestReversible())?.operationId).toBe("manual-task");
    expect((await save("reminder-click", "respond_proactive_candidate")).trigger).toBe("user");
    expect((await ledger.latestReversible())?.operationId).toBe("reminder-click");
  });

  it("reverts a verified reversible operation exactly once", async () => {
    const host = new MemoryLedgerHost();
    const ledger = new OperationLedger(host, () => new Date("2026-07-28T12:00:00.000Z"));
    await ledger.claim({
      operationId: "call-reversible",
      toolName: "create_task",
      source: "kimi",
      arguments: { title: "可撤销任务" }
    });
    await ledger.verify("call-reversible", {
      success: true,
      output: "created",
      actions: [],
      undo: { kind: "delete_task", taskId: "task-1" }
    });

    const executed: string[] = [];
    const reverted = await ledger.revert("call-reversible", async (descriptor) => {
      if (descriptor.kind === "delete_task") executed.push(descriptor.taskId);
    });
    await ledger.revert("call-reversible", async () => {
      executed.push("duplicate");
    });

    expect(reverted.status).toBe("reverted");
    expect(executed).toEqual(["task-1"]);
    expect(await ledger.latestReversible()).toBeNull();
  });

  it("rejects undo when a verified operation has no recovery descriptor", async () => {
    const host = new MemoryLedgerHost();
    const ledger = new OperationLedger(host);
    await ledger.claim({
      operationId: "call-not-reversible",
      toolName: "read_today_journal",
      source: "kimi",
      arguments: {}
    });
    await ledger.verify("call-not-reversible", {
      success: true,
      output: "read",
      actions: []
    });

    await expect(ledger.revert("call-not-reversible", async () => undefined))
      .rejects.toThrow("操作不可撤销");
  });
});
