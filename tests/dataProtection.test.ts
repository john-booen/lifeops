import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, TFile } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { OperationLedger } from "../src/dataFoundation/operationLedger";
import type { StoreHost } from "../src/store/settingsSlice";
import type { LifeOpsTask } from "../src/types";
import { formatVaultTaskBlock } from "../src/vaultApi";

vi.mock("obsidian", () => ({
  App: class App {},
  Notice: class Notice {},
  TFile: class TFile {},
  TFolder: class TFolder {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\.\//, "")
}));

const { LifeOpsStore } = await import("../src/store");
const { TFile: MockFile, TFolder: MockFolder } = await import("obsidian");

const PRIVATE_TEXT = "PRIVATE-DIARY-SENTINEL-DO-NOT-PRINT";
const NOW = "2026-09-09T00:00:00.000Z";
const ledgerRequest = {
  operationId: "data-protection-operation",
  toolName: "create_task",
  source: "system" as const,
  arguments: { title: "Synthetic acceptance task" }
};

// Only the Obsidian I/O surface is substituted. Store and Ledger JSON methods
// remain real, and all content lives in a fresh, disposable OS temporary folder.
class DiskVault {
  readonly writes: Array<{ kind: string; path: string }> = [];
  processCalls = 0;
  beforeProcess?: (file: TFile) => Promise<void>;
  readFailure?: Error;

  constructor(readonly root: string) {}

  diskPath(path: string): string {
    const target = resolve(this.root, path);
    const child = relative(this.root, target);
    if (child === ".." || child.startsWith(`..${sep}`) || resolve(target) === resolve(this.root)) {
      throw new Error("Test path must be a file or folder inside its temporary root");
    }
    return target;
  }

  getAbstractFileByPath(path: string): TFile | InstanceType<typeof MockFolder> | null {
    const target = this.diskPath(path);
    if (!existsSync(target)) return null;
    const stat = statSync(target);
    const name = path.split("/").at(-1) ?? "";
    if (stat.isDirectory()) return Object.assign(new MockFolder(), { path, name });
    return Object.assign(new MockFile(), {
      path, name, basename: name.replace(/\.[^.]+$/, ""), extension: name.split(".").at(-1) ?? "",
      stat: { ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size }
    });
  }

  getFileByPath(path: string): TFile | null {
    const file = this.getAbstractFileByPath(path);
    return file instanceof MockFile ? file : null;
  }

  async read(file: TFile): Promise<string> {
    if (this.readFailure) throw this.readFailure;
    return readFile(this.diskPath(file.path), "utf8");
  }

  async cachedRead(file: TFile): Promise<string> { return this.read(file); }

  async createFolder(path: string): Promise<void> {
    await mkdir(this.diskPath(path));
    this.writes.push({ kind: "createFolder", path });
  }

  async create(path: string, content: string): Promise<TFile> {
    await writeFile(this.diskPath(path), content, { encoding: "utf8", flag: "wx" });
    this.writes.push({ kind: "create", path });
    return this.getFileByPath(path)!;
  }

  async modify(file: TFile, content: string): Promise<void> {
    await writeFile(this.diskPath(file.path), content, "utf8");
    this.writes.push({ kind: "modify", path: file.path });
  }

  async process(file: TFile, updater: (content: string) => string): Promise<string> {
    this.processCalls += 1;
    const hook = this.beforeProcess;
    this.beforeProcess = undefined;
    await hook?.(file);
    // Read after the race hook, as Obsidian's process callback sees current bytes.
    const next = updater(await this.read(file));
    await writeFile(this.diskPath(file.path), next, "utf8");
    this.writes.push({ kind: "process", path: file.path });
    return next;
  }

  getMarkdownFiles(): TFile[] {
    const walk = (folder: string): string[] => readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
      const path = resolve(folder, entry.name);
      return entry.isDirectory() ? walk(path) : [relative(this.root, path).split(sep).join("/")];
    });
    return walk(this.root).filter((path) => path.endsWith(".md")).map((path) => this.getFileByPath(path)!);
  }

  async seed(path: string, content: string): Promise<void> {
    await mkdir(dirname(this.diskPath(path)), { recursive: true });
    await writeFile(this.diskPath(path), content, "utf8");
  }

  async bytes(path: string): Promise<string> { return readFile(this.diskPath(path), "utf8"); }
}

let vault: DiskVault;
let store: InstanceType<typeof LifeOpsStore> & StoreHost;

beforeEach(async () => {
  vault = new DiskVault(await mkdtemp(resolve(tmpdir(), "lifeops-data-protection-")));
  store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as typeof store;
});

afterEach(async () => { await rm(vault.root, { recursive: true, force: true }); });

async function rejectedByProtection(operation: () => Promise<unknown>): Promise<void> {
  const error = await operation().then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ name: "DataProtectionError", code: "LIFEOPS_DATA_PROTECTED" });
  expect(String(error)).not.toContain(PRIVATE_TEXT);
}

function taskFixture(): LifeOpsTask {
  return {
    id: "existing-task", title: "Synthetic existing task", status: "active", priority: "medium",
    quadrant: "important-not-urgent", category: "", project: "", date: "2026-09-09", endDate: "",
    time: "", dueDate: "", dueTime: "", repeatUnit: "none", repeatInterval: 1, repeatUntil: "",
    parentTaskId: "", note: PRIVATE_TEXT, source: "manual", sourceNotePath: "", createdAt: NOW,
    updatedAt: NOW, completedAt: "", completionLog: [], sortOrder: 0
  };
}

const versionedCases = [
  { name: "personal memory", path: () => store.personalMemoryPath(), read: () => store.readPersonalMemories(), body: { updatedAt: NOW, records: [] } },
  { name: "source manifest", path: () => store.sourceManifestPath(), read: () => store.readSourceManifest(), body: { updatedAt: NOW, entries: [] } },
  { name: "observation", path: () => store.observationsPath(), read: () => store.readObservations(), body: { updatedAt: NOW, observations: [] } },
  { name: "proactive policy", path: () => store.proactivePolicyPath(), read: () => store.readProactivePolicyState(), body: { deliveries: [], feedback: [], mutedKinds: [] } },
  { name: "operation ledger", path: () => new OperationLedger(store).filePath, read: () => new OperationLedger(store).claim(ledgerRequest), body: { records: [] } }
];

describe("existing JSON is preserved when its format cannot be understood", () => {
  it("uses the fallback only for a missing file, without creating it", async () => {
    const fallback = { tasks: [] };
    expect(await store.readJson(store.taskDbPath(), fallback)).toBe(fallback);
    expect(existsSync(vault.diskPath(store.taskDbPath()))).toBe(false);
    expect(vault.writes).toEqual([]);
  });

  it.each([
    ["malformed JSON", `{"tasks":["${PRIVATE_TEXT}"`],
    ["empty file", ""], ["whitespace", " \n\t "], ["null", "null"],
    ["array root", "[]"], ["boolean root", "true"], ["string root", JSON.stringify(PRIVATE_TEXT)],
    ["missing task list", "{}"], ["wrong task list type", '{"tasks":{}}']
  ])("rejects %s without replacing it with an empty task list", async (_name, original) => {
    await vault.seed(store.taskDbPath(), original);
    await rejectedByProtection(() => store.readJson(store.taskDbPath(), { tasks: [] }));
    expect(await vault.bytes(store.taskDbPath())).toBe(original);
    expect(vault.writes).toEqual([]);
  });

  it.each([1, 2, "1", null])("rejects the unsupported schemaVersion field with value %s", async (schemaVersion) => {
    const original = JSON.stringify({ schemaVersion, tasks: [], privateNote: PRIVATE_TEXT });
    await vault.seed(store.taskDbPath(), original);
    await rejectedByProtection(() => store.readJson(store.taskDbPath(), { tasks: [] }));
    expect(await vault.bytes(store.taskDbPath())).toBe(original);
    expect(vault.writes).toEqual([]);
  });

  it.each(versionedCases)("rejects version 2 through the real $name reader", async ({ path, read, body }) => {
    const original = JSON.stringify({ version: 2, ...body, privateNote: PRIVATE_TEXT });
    await vault.seed(path(), original);
    await rejectedByProtection(read);
    expect(await vault.bytes(path())).toBe(original);
    expect(vault.writes).toEqual([]);
  });

  it("does not treat an existing file read failure as missing data", async () => {
    const original = JSON.stringify({ tasks: [taskFixture()] });
    await vault.seed(store.taskDbPath(), original);
    vault.readFailure = new Error("Synthetic unreadable file");
    await expect(store.readJson(store.taskDbPath(), { tasks: [] })).rejects.toThrow();
    expect(await vault.bytes(store.taskDbPath())).toBe(original);
    expect(vault.writes).toEqual([]);
  });

  it.each([
    { name: "personal memory records", path: () => store.personalMemoryPath(), read: () => store.readPersonalMemories(), field: "records" },
    { name: "observation list", path: () => store.observationsPath(), read: () => store.readObservations(), field: "observations" }
  ])("does not normalize a malformed version 1 $name field into an empty list", async ({ path, read, field }) => {
    const original = JSON.stringify({ version: 1, updatedAt: NOW, [field]: { privateNote: PRIVATE_TEXT } });
    await vault.seed(path(), original);
    await rejectedByProtection(read);
    expect(await vault.bytes(path())).toBe(original);
    expect(vault.writes).toEqual([]);
  });
});

describe("supported existing formats remain usable without migration", () => {
  it("reads a populated legacy task database without changing its bytes", async () => {
    const original = JSON.stringify({ tasks: [taskFixture()] });
    await vault.seed(store.taskDbPath(), original);
    expect((await store.readTaskDb({ readOnly: true })).tasks[0]).toMatchObject({ id: "existing-task", note: PRIVATE_TEXT });
    expect(await vault.bytes(store.taskDbPath())).toBe(original);
    expect(vault.writes).toEqual([]);
  });

  it("reads a populated legacy habit database without changing its bytes", async () => {
    const habit = {
      id: "existing-habit", name: "Synthetic reading", frequencyUnit: "day", frequencyInterval: 1,
      targetCount: 1, startDate: "2026-09-09", penaltyThreshold: 3, color: "#27ae60", createdAt: NOW
    };
    const checkin = { habitId: habit.id, date: "2026-09-09", status: "done", count: 1, updatedAt: NOW, note: PRIVATE_TEXT };
    const original = JSON.stringify({ habits: [habit], checkins: [checkin] });
    await vault.seed(store.habitDbPath(), original);
    expect(await store.readHabitDb()).toEqual({ habits: [habit], checkins: [checkin] });
    expect(await vault.bytes(store.habitDbPath())).toBe(original);
    expect(vault.writes).toEqual([]);
  });

  it.each(versionedCases.slice(0, 4))("reads supported version 1 $name data without rewriting it", async ({ path, read, body }) => {
    const original = JSON.stringify({ version: 1, ...body });
    await vault.seed(path(), original);
    expect(await read()).toMatchObject({ version: 1, ...body });
    expect(await vault.bytes(path())).toBe(original);
    expect(vault.writes).toEqual([]);
  });

  it("keeps real version 1 Ledger claims and cached verification durable", async () => {
    const ledger = new OperationLedger(store);
    await vault.seed(ledger.filePath, JSON.stringify({ version: 1, records: [] }));
    expect((await ledger.claim(ledgerRequest)).kind).toBe("execute");
    await ledger.verify(ledgerRequest.operationId, { success: true, output: "Synthetic verified result", actions: [] });
    const reopened = new OperationLedger(store);
    expect((await reopened.claim(ledgerRequest)).kind).toBe("cached");
    const document = JSON.parse(await vault.bytes(ledger.filePath));
    expect(document).toMatchObject({ version: 1, records: [{ operationId: ledgerRequest.operationId, status: "verified" }] });
    expect(document).not.toHaveProperty("schemaVersion");
  });

  it("accepts legacy array documents without converting their root", async () => {
    for (const path of [store.memoryIndexPath(), store.associationsPath()]) {
      await vault.seed(path, "[]");
      expect(await store.readJson(path, [])).toEqual([]);
      await store.writeJson(path, []);
      expect(JSON.parse(await vault.bytes(path))).toEqual([]);
    }
  });

  it("creates and updates supported JSON in nested folders", async () => {
    await store.writeJson(store.taskDbPath(), { tasks: [] });
    await store.writeJson(store.taskDbPath(), { tasks: [taskFixture()] });
    expect(JSON.parse(await vault.bytes(store.taskDbPath())).tasks).toEqual([taskFixture()]);
  });
});

describe("all Store JSON write entrances apply data protection", () => {
  it("rejects a fallback write even when the caller swallows the preceding read error", async () => {
    const original = `{"tasks":["${PRIVATE_TEXT}"`;
    await vault.seed(store.taskDbPath(), original);
    const swallowError = vi.fn(() => ({ tasks: [] }));
    const fallback = await store.readJson(store.taskDbPath(), { tasks: [] }).catch(swallowError);
    expect(swallowError).toHaveBeenCalledOnce();
    expect(fallback).toEqual({ tasks: [] });
    await rejectedByProtection(() => store.writeJson(store.taskDbPath(), fallback));
    expect(await vault.bytes(store.taskDbPath())).toBe(original);
    expect(vault.writes).toEqual([]);
  });

  it.each([
    ["malformed", `{"tasks":["${PRIVATE_TEXT}"`],
    ["whitespace", " \n "],
    ["unknown schema", JSON.stringify({ schemaVersion: 2, tasks: [], privateNote: PRIVATE_TEXT })]
  ])("writeJson cannot overwrite an existing %s document", async (_name, original) => {
    await vault.seed(store.taskDbPath(), original);
    await rejectedByProtection(() => store.writeJson(store.taskDbPath(), { tasks: [] }));
    expect(await vault.bytes(store.taskDbPath())).toBe(original);
    expect(vault.writes).toEqual([]);
  });

  it.each([null, [], { tasks: {} }, { schemaVersion: 1, tasks: [] }])("writeJson rejects invalid outgoing task data %#", async (outgoing) => {
    const original = JSON.stringify({ tasks: [taskFixture()] });
    await vault.seed(store.taskDbPath(), original);
    await rejectedByProtection(() => store.writeJson(store.taskDbPath(), outgoing));
    expect(await vault.bytes(store.taskDbPath())).toBe(original);
    expect(vault.writes).toEqual([]);
  });

  it("does not create an outgoing version 2 memory document", async () => {
    await rejectedByProtection(() => store.writeJson(store.personalMemoryPath(), { version: 2, updatedAt: NOW, records: [] }));
    expect(existsSync(vault.diskPath(store.personalMemoryPath()))).toBe(false);
    expect(vault.writes).toEqual([]);
  });

  it("writePersonalMemories cannot normalize an unsupported outgoing version back to 1", async () => {
    const original = JSON.stringify({ version: 1, updatedAt: NOW, records: [] });
    await vault.seed(store.personalMemoryPath(), original);
    const unsupported = { version: 2, updatedAt: NOW, records: [], privateNote: PRIVATE_TEXT };
    await rejectedByProtection(() => store.writePersonalMemories(
      unsupported as unknown as Parameters<typeof store.writePersonalMemories>[0]
    ));
    expect(await vault.bytes(store.personalMemoryPath())).toBe(original);
    expect(vault.writes).toEqual([]);
  });

  it("writeFile cannot restore JSON over an unsupported current version", async () => {
    const original = JSON.stringify({ version: 2, updatedAt: NOW, records: [], privateNote: PRIVATE_TEXT });
    await vault.seed(store.personalMemoryPath(), original);
    await rejectedByProtection(() => store.writeFile(store.personalMemoryPath(), JSON.stringify({ version: 1, updatedAt: NOW, records: [] })));
    expect(await vault.bytes(store.personalMemoryPath())).toBe(original);
    expect(vault.writes).toEqual([]);
  });

  it.each(["", "null", '{"tasks":', JSON.stringify({ schemaVersion: 2, tasks: [] })])("writeFile rejects unsafe JSON restoration content %#", async (outgoing) => {
    const original = JSON.stringify({ tasks: [taskFixture()] });
    await vault.seed(store.taskDbPath(), original);
    await rejectedByProtection(() => store.writeFile(store.taskDbPath(), outgoing));
    expect(await vault.bytes(store.taskDbPath())).toBe(original);
    expect(vault.writes).toEqual([]);
  });

  it("writeFile can still create and update ordinary Markdown", async () => {
    await store.writeFile("Synthetic/notes.md", "# First\n");
    await store.writeFile("Synthetic/notes.md", "# Second\n");
    expect(await vault.bytes("Synthetic/notes.md")).toBe("# Second\n");
  });

  it.each(["writeJson", "writeFile"] as const)("%s revalidates version upgrades inside vault.process", async (method) => {
    const path = store.personalMemoryPath();
    const supported = { version: 1, updatedAt: NOW, records: [] };
    const upgraded = JSON.stringify({ ...supported, version: 2, privateNote: PRIVATE_TEXT });
    await vault.seed(path, JSON.stringify(supported));
    vault.beforeProcess = async (file) => {
      expect(file.path).toBe(path);
      await vault.seed(path, upgraded);
    };
    await rejectedByProtection(() => method === "writeJson"
      ? store.writeJson(path, supported)
      : store.writeFile(path, JSON.stringify(supported)));
    expect(vault.processCalls).toBe(1);
    expect(await vault.bytes(path)).toBe(upgraded);
    expect(vault.writes).toEqual([]);
  });
});

describe("Ledger recovery checks the document before executing undo", () => {
  it.each(["malformed", "null", "version 2"] as const)("does not run undo with a %s ledger", async (kind) => {
    const ledger = new OperationLedger(store);
    await ledger.claim(ledgerRequest);
    await ledger.verify(ledgerRequest.operationId, {
      success: true, output: "Synthetic result", actions: [],
      undo: { kind: "restore_file", path: "Synthetic/undo-target.md", content: PRIVATE_TEXT, existed: true }
    });
    const verified = JSON.parse(await vault.bytes(ledger.filePath));
    const original = kind === "malformed" ? `{"records":["${PRIVATE_TEXT}"`
      : kind === "null" ? "null" : JSON.stringify({ ...verified, version: 2 });
    await vault.seed(ledger.filePath, original);
    vault.writes.length = 0;
    const executeUndo = vi.fn(async () => undefined);
    await rejectedByProtection(() => ledger.revert(ledgerRequest.operationId, executeUndo));
    expect(executeUndo).not.toHaveBeenCalled();
    expect(await vault.bytes(ledger.filePath)).toBe(original);
    expect(vault.writes).toEqual([]);
  });
});

describe("task Markdown cannot bypass an unsupported task database", () => {
  async function seedTaskPair(): Promise<{ database: string; board: string }> {
    const database = JSON.stringify({ schemaVersion: 2, tasks: [taskFixture()], privateNote: PRIVATE_TEXT });
    const board = `# LifeOps 任务看板\n\n## 进行中\n\n${formatVaultTaskBlock(taskFixture())}\n\n## 已完成\n\n## 放弃\n`;
    await vault.seed(store.taskDbPath(), database);
    await vault.seed(store.taskMirrorPath(), board);
    return { database, board };
  }

  it("does not hide an unsupported database behind a populated Markdown board", async () => {
    const { database, board } = await seedTaskPair();
    await rejectedByProtection(() => store.readTaskDb({ readOnly: true }));
    expect(await vault.bytes(store.taskDbPath())).toBe(database);
    expect(await vault.bytes(store.taskMirrorPath())).toBe(board);
    expect(vault.writes).toEqual([]);
  });

  it("rejects task creation before modifying either the database or Markdown", async () => {
    const { database, board } = await seedTaskPair();
    await rejectedByProtection(() => store.createTask({ title: "Must not be created", date: "2026-09-09" }));
    expect(await vault.bytes(store.taskDbPath())).toBe(database);
    expect(await vault.bytes(store.taskMirrorPath())).toBe(board);
    expect(vault.writes).toEqual([]);
  });
});

describe("direct mirror writes preserve Markdown when its database is damaged", () => {
  it.each(["task", "habit"] as const)("protects the existing %s mirror from an empty recovery snapshot", async (kind) => {
    const databasePath = kind === "task" ? store.taskDbPath() : store.habitDbPath();
    const boardPath = kind === "task" ? store.taskMirrorPath() : store.habitMirrorPath();
    const habit = {
      id: "protected-habit", name: "Synthetic reading", frequencyUnit: "day" as const,
      frequencyInterval: 1, targetCount: 1, startDate: "2026-09-09", penaltyThreshold: 3,
      color: "#27ae60", createdAt: NOW
    };
    await vault.seed(databasePath, JSON.stringify(kind === "task"
      ? { tasks: [taskFixture()] } : { habits: [habit], checkins: [] }));
    if (kind === "task") await store.writeTaskMirror([taskFixture()]);
    else await store.writeHabitMirror([habit], []);
    const board = await vault.bytes(boardPath);
    expect(board).toContain(kind === "task" ? taskFixture().title : habit.name);
    const damagedDatabase = `{"privateNote":"${PRIVATE_TEXT}"`;
    await vault.seed(databasePath, damagedDatabase);
    vault.writes.length = 0;

    await rejectedByProtection(() => kind === "task" ? store.writeTaskMirror([]) : store.writeHabitMirror([], []));

    expect(await vault.bytes(databasePath)).toBe(damagedDatabase);
    expect(await vault.bytes(boardPath)).toBe(board);
    expect(vault.writes).toEqual([]);
  });
});

describe("JSON contracts follow configured paths rather than filenames", () => {
  it.each(["SyntheticCustom/Tasks", ""])("protects the configured task database when tasks folder is %j", async (tasksFolder) => {
    store.settings.folders.tasks = tasksFolder;
    const path = store.taskDbPath();
    expect(path).toBe(tasksFolder ? `${tasksFolder}/LifeOps任务库.json` : "LifeOps任务库.json");
    const original = JSON.stringify({ schemaVersion: 2, tasks: [], privateNote: PRIVATE_TEXT });
    await vault.seed(path, original);
    await rejectedByProtection(() => store.readJson(path, { tasks: [] }));
    await rejectedByProtection(() => store.writeJson(path, { tasks: [] }));
    expect(await vault.bytes(path)).toBe(original);
    expect(vault.writes).toEqual([]);
  });

  it("allows an ordinary user JSON file with the same name in another directory to retain its own schema", async () => {
    const path = "SyntheticUserNotes/LifeOps任务库.json";
    const original = { schemaVersion: 2, notes: ["Synthetic user document"] };
    await vault.seed(path, JSON.stringify(original));
    expect(await store.readJson(path, {})).toEqual(original);
    const updated = { ...original, notes: [...original.notes, "Synthetic additional note"] };
    await store.writeJson(path, updated);
    expect(JSON.parse(await vault.bytes(path))).toEqual(updated);
    await store.writeFile(path, JSON.stringify(original));
    expect(await store.readJson(path, {})).toEqual(original);
  });
});
