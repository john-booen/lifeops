import { addDays, formatDate, normalizeJournalDate, todayString } from "./date";
import { DEFAULT_SETTINGS } from "./defaults";
import { taskScheduleLabel, validateTaskSchedule } from "./taskSchedule";
import { findJournalFilesForDate, journalPeriodFromPath } from "./journalResolver";
import type {
  FolderSettings,
  LifeOpsTask,
  LifeOpsTaskInput,
  LifeOpsTaskPriority,
  LifeOpsTaskQuadrant,
  LifeOpsTaskStatus
} from "./types";

export interface VaultMarkdownFile {
  path: string;
  content?: string;
  mtime?: number;
}

export interface VaultFileAdapter {
  taskAuthority?: Pick<VaultApi, "readTasks" | "createTask" | "completeTask">;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  process?(path: string, updater: (content: string) => string): Promise<string>;
  exists?(path: string): Promise<boolean>;
  listMarkdownFiles?(): Promise<VaultMarkdownFile[]>;
}

export interface VaultApiOptions {
  folders?: FolderSettings;
  now?: () => Date;
  idFactory?: () => string;
}

export interface VaultNoteRead {
  path: string;
  content: string;
  exists: boolean;
}

export interface VaultSearchResult {
  path: string;
  title: string;
  snippet: string;
  score: number;
  mtime?: number;
}

export interface VaultUserContext {
  markdown: string;
  goals: VaultNoteRead;
  tasks: LifeOpsTask[];
  recentNotes: VaultNoteRead[];
}

export interface VaultApi {
  createTask(input: LifeOpsTaskInput): Promise<LifeOpsTask>;
  readTasks(): Promise<LifeOpsTask[]>;
  completeTask(idOrTitle: string, note?: string): Promise<LifeOpsTask>;
  readDailyNote(date: string | Date, period?: DailyNotePeriod): Promise<VaultNoteRead>;
  readRecentNotes(days: number, options?: { endDate?: string | Date; includeEvening?: boolean }): Promise<VaultNoteRead[]>;
  readTradingJournal(date: string | Date): Promise<VaultNoteRead>;
  searchVault(query: string, options?: { limit?: number }): Promise<VaultSearchResult[]>;
  getUserContext(options?: { date?: string | Date; recentDays?: number }): Promise<VaultUserContext>;
  paths: VaultApiPaths;
}

export type DailyNotePeriod = "早" | "晚";

export interface VaultApiPaths {
  taskBoard(): string;
  goals(): string;
  dailyNote(date: string | Date, period?: DailyNotePeriod): string;
  tradingJournal(date: string | Date): string;
}

interface TaskBoardSection {
  title: string;
  lines: string[];
}

interface TaskBoardDocument {
  preamble: string[];
  sections: TaskBoardSection[];
}

interface ParsedTaskBlock {
  task: LifeOpsTask;
  start: number;
  end: number;
  block: string[];
}

const TASK_BOARD_TITLE = "# LifeOps 任务看板";
const TASK_BOARD_NOTICE = "> 这个文件由 LifeOps 插件维护。";
const ACTIVE_SECTION = "进行中";
const COMPLETED_SECTION = "已完成";
const ABANDONED_SECTION = "放弃";
const TASK_SECTIONS = [ACTIVE_SECTION, COMPLETED_SECTION, ABANDONED_SECTION];

const PRIORITY_TO_LABEL: Record<LifeOpsTaskPriority, string> = {
  high: "高",
  medium: "中",
  low: "低",
  none: "无"
};

const LABEL_TO_PRIORITY: Record<string, LifeOpsTaskPriority> = {
  高: "high",
  中: "medium",
  低: "low",
  无: "none"
};

const QUADRANT_TO_LABEL: Record<LifeOpsTaskQuadrant, string> = {
  "important-urgent": "重要且紧急",
  "important-not-urgent": "重要不紧急",
  "not-important-urgent": "不重要但紧急",
  "not-important-not-urgent": "不重要不紧急"
};

const LABEL_TO_QUADRANT: Record<string, LifeOpsTaskQuadrant> = {
  重要且紧急: "important-urgent",
  重要不紧急: "important-not-urgent",
  不重要但紧急: "not-important-urgent",
  不重要不紧急: "not-important-not-urgent"
};

export class VaultApiError extends Error {
  constructor(message: string, readonly path?: string) {
    super(path ? `${message}: ${path}` : message);
    this.name = "VaultApiError";
  }
}

export function createVaultApi(adapter: VaultFileAdapter, options: VaultApiOptions = {}): VaultApi {
  const folders = mergeFolders(options.folders);
  const now = options.now ?? (() => new Date());
  const paths = createVaultApiPaths(folders);

  async function readTaskBoardText(): Promise<string> {
    const path = paths.taskBoard();
    if (adapter.exists && !(await adapter.exists(path))) {
      return defaultTaskBoard();
    }
    return adapter.read(path);
  }

  async function processTaskBoard(updater: (markdown: string) => string): Promise<string> {
    const path = paths.taskBoard();
    if (adapter.exists && !(await adapter.exists(path))) {
      const next = updater(defaultTaskBoard());
      await adapter.write(path, next);
      return next;
    }
    if (adapter.process) {
      return adapter.process(path, updater);
    }
    const next = updater(await readTaskBoardText());
    await adapter.write(path, next);
    return next;
  }

  async function readOptional(path: string): Promise<VaultNoteRead> {
    if (adapter.exists && !(await adapter.exists(path))) {
      return { path, content: "", exists: false };
    }
    const content = await adapter.read(path);
    return { path, content, exists: true };
  }

  async function readTasks(): Promise<LifeOpsTask[]> {
    if (adapter.taskAuthority) return adapter.taskAuthority.readTasks();
    if (adapter.exists && !(await adapter.exists(paths.taskBoard()))) {
      return [];
    }
    return parseVaultTasks(await adapter.read(paths.taskBoard()));
  }

  async function readRecentNotes(days: number, readOptions: { endDate?: string | Date; includeEvening?: boolean } = {}): Promise<VaultNoteRead[]> {
    const count = Math.max(0, Math.floor(days));
    const endDate = toDateString(readOptions.endDate ?? now());
    const notes: VaultNoteRead[] = [];
    for (let offset = count - 1; offset >= 0; offset -= 1) {
      const date = addDays(endDate, -offset);
      const matches = await listJournalFiles(date);
      if (matches) {
        const selected = readOptions.includeEvening
          ? matches
          : matches.filter((file) => journalPeriodFromPath(file.path) !== "晚");
        for (const file of selected) notes.push(await readListedFile(file));
      } else {
        notes.push(await readOptional(paths.dailyNote(date, "早")));
        if (readOptions.includeEvening) notes.push(await readOptional(paths.dailyNote(date, "晚")));
      }
    }
    return notes;
  }

  async function listJournalFiles(date: string, period?: DailyNotePeriod): Promise<VaultMarkdownFile[] | null> {
    if (!adapter.listMarkdownFiles) return null;
    const files = await adapter.listMarkdownFiles();
    return findJournalFilesForDate(files, folders.dailyRoot, date, period);
  }

  async function readListedFile(file: VaultMarkdownFile): Promise<VaultNoteRead> {
    return {
      path: file.path,
      content: file.content ?? await adapter.read(file.path),
      exists: true
    };
  }

  return {
    paths,

    async createTask(input: LifeOpsTaskInput): Promise<LifeOpsTask> {
      if (adapter.taskAuthority) return adapter.taskAuthority.createTask(input);
      const task = buildTaskFromInput(input, now(), options.idFactory);
      await processTaskBoard((board) => insertTaskIntoBoard(board, task));
      return task;
    },

    readTasks,

    async completeTask(idOrTitle: string, note = ""): Promise<LifeOpsTask> {
      if (adapter.taskAuthority) return adapter.taskAuthority.completeTask(idOrTitle, note);
      const value = idOrTitle.trim();
      if (!value) {
        throw new VaultApiError("任务 ID 或标题不能为空", paths.taskBoard());
      }
      const completedAt = now().toISOString();
      let completedTask: LifeOpsTask | null = null;
      await processTaskBoard((board) => {
        const result = completeTaskInBoard(board, value, completedAt, note);
        completedTask = result.task;
        return result.markdown;
      });
      if (!completedTask) {
        throw new VaultApiError("任务完成操作没有返回结果", value);
      }
      return completedTask;
    },

    async readDailyNote(date: string | Date, period?: DailyNotePeriod): Promise<VaultNoteRead> {
      const value = toDateString(date);
      const matches = await listJournalFiles(value, period);
      if (matches && matches.length > 0) return readListedFile(matches[0]);
      return readOptional(paths.dailyNote(value, period ?? "早"));
    },

    readRecentNotes,

    async readTradingJournal(date: string | Date): Promise<VaultNoteRead> {
      return readOptional(paths.tradingJournal(date));
    },

    async searchVault(query: string, searchOptions: { limit?: number } = {}): Promise<VaultSearchResult[]> {
      const text = query.trim();
      if (!text) return [];
      if (!adapter.listMarkdownFiles) {
        throw new VaultApiError("searchVault 需要 adapter.listMarkdownFiles()");
      }
      const limit = Math.max(1, searchOptions.limit ?? 10);
      const terms = tokenizeQuery(text);
      const files = await adapter.listMarkdownFiles();
      const results: VaultSearchResult[] = [];
      for (const file of files) {
        const content = file.content ?? await adapter.read(file.path);
        const score = scoreContent(content, terms);
        if (score <= 0) continue;
        results.push({
          path: file.path,
          title: titleFromPath(file.path),
          snippet: buildSnippet(content, terms),
          score,
          mtime: file.mtime
        });
      }
      return results
        .sort((a, b) => b.score - a.score || (b.mtime ?? 0) - (a.mtime ?? 0) || a.path.localeCompare(b.path))
        .slice(0, limit);
    },

    async getUserContext(contextOptions: { date?: string | Date; recentDays?: number } = {}): Promise<VaultUserContext> {
      const recentDays = Math.max(1, contextOptions.recentDays ?? 3);
      const goals = await readOptional(paths.goals());
      const tasks = await readTasks();
      const recentNotes = await readRecentNotes(recentDays, { endDate: contextOptions.date ?? now(), includeEvening: true });
      return {
        goals,
        tasks,
        recentNotes,
        markdown: renderUserContextMarkdown(goals, tasks, recentNotes)
      };
    }
  };
}

export function createVaultApiPaths(folders: FolderSettings = DEFAULT_SETTINGS.folders): VaultApiPaths {
  const merged = mergeFolders(folders);
  return {
    taskBoard: () => joinPath(merged.tasks, "任务看板.md"),
    goals: () => joinPath(merged.goals, "目标.md"),
    dailyNote: (date: string | Date, period: DailyNotePeriod = "早") => {
      const value = toDateString(date);
      const [year, month] = value.split("-");
      return joinPath(merged.dailyRoot, year, month, `${value}${period}.md`);
    },
    tradingJournal: (date: string | Date) => {
      const value = toDateString(date);
      const [year, month] = value.split("-");
      return joinPath(merged.tradingReviews, year, `${Number(month)}月`, `${value}.md`);
    }
  };
}

export function defaultTaskBoard(): string {
  return [
    TASK_BOARD_TITLE,
    "",
    TASK_BOARD_NOTICE,
    "",
    `## ${ACTIVE_SECTION}`,
    "",
    `## ${COMPLETED_SECTION}`,
    "",
    `## ${ABANDONED_SECTION}`,
    ""
  ].join("\n");
}

export function formatVaultTaskBlock(task: LifeOpsTask): string {
  const dateRange = task.date ? `${task.date}${task.endDate ? ` -> ${task.endDate}` : ""}` : "无日期";
  const due = task.dueDate ? `${task.dueDate}${task.dueTime ? ` ${task.dueTime}` : ""}` : "";
  const meta = [
    `状态=${task.status}`,
    `优先级=${PRIORITY_TO_LABEL[task.priority] ?? "中"}`,
    `象限=${QUADRANT_TO_LABEL[task.quadrant] ?? "重要不紧急"}`,
    `分类=${task.category || "AI建议"}`,
    task.estimateMin !== undefined ? `估计分钟=${task.estimateMin}` : "",
    task.ideaId ? `想法ID=${task.ideaId}` : "",
    task.learningTrackId ? `学习轨道=${task.learningTrackId}` : "",
    `项目=${task.project || "默认"}`,
    `日期=${dateRange}`,
    `时间=${task.time || ""}`,
    task.startTime !== undefined ? `计划开始=${task.startTime}` : "",
    task.endTime !== undefined ? `计划结束=${task.endTime}` : "",
    `截止=${due}`,
    task.repeatUnit && task.repeatUnit !== "none" ? `重复=${formatRepeat(task)}` : "",
    task.completedAt ? `完成=${task.completedAt}` : "",
    `ID=${task.id}`,
    task.source ? `来源=${task.source}` : ""
  ].filter(Boolean).join(" · ");
  const checkbox = task.status === "completed" ? "[x]" : "[ ]";
  const noteLine = task.note ? task.note.split(/\r?\n/).map(line => `\n  - 备注：${line}`).join("") : "";
  return `- ${checkbox} ${task.title}\n  - ${meta}${noteLine}`;
}

export function insertTaskIntoBoard(markdown: string, task: LifeOpsTask): string {
  const document = ensureTaskBoardSections(parseTaskBoard(markdown));
  const active = getSection(document, ACTIVE_SECTION);
  active.lines = insertBlockAtTop(active.lines, formatVaultTaskBlock(task).split("\n"));
  return renderTaskBoard(document);
}

export function parseVaultTasks(markdown: string): LifeOpsTask[] {
  const document = ensureTaskBoardSections(parseTaskBoard(markdown));
  return document.sections.flatMap((section) => {
    if (!TASK_SECTIONS.includes(section.title)) return [];
    return parseTaskBlocks(section.lines, sectionStatus(section.title)).map((block) => block.task);
  });
}

export function completeTaskInBoard(markdown: string, idOrTitle: string, completedAt: string, note = ""): { markdown: string; task: LifeOpsTask } {
  const document = ensureTaskBoardSections(parseTaskBoard(markdown));
  const active = getSection(document, ACTIVE_SECTION);
  const completed = getSection(document, COMPLETED_SECTION);
  const blocks = parseTaskBlocks(active.lines, "active");
  const match = blocks.find((block) => taskMatchesRef(block.task, idOrTitle));
  if (!match) {
    throw new VaultApiError("未找到可完成的进行中任务", idOrTitle);
  }

  const completedBlock = markTaskBlockCompleted(match.block, completedAt, note);
  active.lines = [
    ...active.lines.slice(0, match.start),
    ...active.lines.slice(match.end)
  ];
  active.lines = trimOuterBlankLines(active.lines);
  completed.lines = insertBlockAtTop(completed.lines, completedBlock);

  const completedTask = {
    ...match.task,
    status: "completed" as LifeOpsTaskStatus,
    completedAt,
    updatedAt: completedAt,
    completionLog: [...match.task.completionLog, { completedAt, note: note.trim() }]
  };
  return { markdown: renderTaskBoard(document), task: completedTask };
}

export function buildTaskFromInput(input: LifeOpsTaskInput, now: Date, idFactory?: () => string): LifeOpsTask {
  const title = input.title.trim();
  if (!title) {
    throw new VaultApiError("任务标题不能为空");
  }
  if (input.startTime || input.endTime) {
    for (const value of [input.date, input.endDate]) {
      if (value && normalizeJournalDate(value.trim()) !== value.trim()) throw new VaultApiError("计划日期须为有效的年-月-日，不会改成同日安排。");
    }
  }
  const createdAt = now.toISOString();
  const date = normalizeDateString(input.date);
  const endDate = normalizeDateString(input.endDate);
  const dueDate = normalizeDateString(input.dueDate);
  const dueTime = normalizeTime(input.dueTime) || "";
  const task: LifeOpsTask = {
    id: idFactory?.() ?? stableTaskId(title, date, dueDate, input.project ?? "默认", input.category ?? "work", 0),
    title,
    status: "active",
    priority: input.priority ?? "medium",
    quadrant: input.quadrant ?? "important-not-urgent",
    category: input.category?.trim() || "work",
    ...(input.estimateMin === undefined ? {} : { estimateMin: input.estimateMin }),
    ...(input.ideaId ? { ideaId: input.ideaId } : {}),
    ...(input.learningTrackId ? { learningTrackId: input.learningTrackId } : {}),
    ...(input.habitPunishment ? { habitPunishment: input.habitPunishment } : {}),
    project: input.project?.trim() || "默认",
    date,
    endDate,
    time: normalizeTime(input.time) || "",
    ...(input.startTime === undefined ? {} : { startTime: input.startTime.trim() }),
    ...(input.endTime === undefined ? {} : { endTime: input.endTime.trim() }),
    dueDate,
    dueTime,
    repeatUnit: input.repeatUnit ?? "none",
    repeatInterval: Math.max(1, input.repeatInterval ?? 1),
    repeatUntil: normalizeDateString(input.repeatUntil) || "",
    parentTaskId: input.parentTaskId ?? "",
    note: input.note?.trim() || "",
    source: input.source ?? "lifeops-agent",
    sourceNotePath: input.sourceNotePath ?? "",
    createdAt,
    updatedAt: createdAt,
    completedAt: "",
    completionLog: [],
    sortOrder: input.sortOrder ?? now.getTime()
  };
  validateTaskSchedule(task);
  return task;
}

function parseTaskBoard(markdown: string): TaskBoardDocument {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const document: TaskBoardDocument = { preamble: [], sections: [] };
  let current: TaskBoardSection | null = null;
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = { title: heading[1].trim(), lines: [] };
      document.sections.push(current);
      continue;
    }
    if (current) {
      current.lines.push(line);
    } else {
      document.preamble.push(line);
    }
  }
  return document;
}

function ensureTaskBoardSections(document: TaskBoardDocument): TaskBoardDocument {
  const preambleText = document.preamble.join("\n").trim();
  if (!preambleText) {
    document.preamble = [TASK_BOARD_TITLE, "", TASK_BOARD_NOTICE, ""];
  }
  for (const section of TASK_SECTIONS) {
    if (!document.sections.some((item) => item.title === section)) {
      document.sections.push({ title: section, lines: [] });
    }
  }
  return document;
}

function renderTaskBoard(document: TaskBoardDocument): string {
  const lines = trimTrailingBlankLines(document.preamble.slice());
  for (const section of document.sections) {
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
    lines.push(`## ${section.title}`);
    lines.push(...trimTrailingBlankLines(section.lines.slice()));
    if (lines[lines.length - 1] !== "") {
      lines.push("");
    }
  }
  return `${trimTrailingBlankLines(lines).join("\n")}\n`;
}

function getSection(document: TaskBoardDocument, title: string): TaskBoardSection {
  const section = document.sections.find((item) => item.title === title);
  if (!section) {
    throw new VaultApiError("任务看板缺少区块", title);
  }
  return section;
}

function parseTaskBlocks(lines: string[], fallbackStatus: LifeOpsTaskStatus): ParsedTaskBlock[] {
  const blocks: ParsedTaskBlock[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!isTaskLine(lines[index])) continue;
    let end = index + 1;
    while (end < lines.length && !isTaskLine(lines[end])) {
      end += 1;
    }
    const block = lines.slice(index, end);
    blocks.push({
      task: parseTaskBlock(block, fallbackStatus, blocks.length),
      start: index,
      end,
      block
    });
    index = end - 1;
  }
  return blocks;
}

function parseTaskBlock(block: string[], fallbackStatus: LifeOpsTaskStatus, occurrence: number): LifeOpsTask {
  const taskLine = block[0] ?? "";
  const title = taskLine.replace(/^\s*-\s+\[[ xX]\]\s+/, "").trim();
  const metaLine = block.find((line) => line.includes("状态=") || line.includes("优先级=") || line.includes("象限=")) ?? "";
  const meta = parseMetaFields(metaLine);
  const status = parseStatus(meta.get("状态")) ?? (taskLine.includes("[x]") ? "completed" : fallbackStatus);
  const dateRange = meta.get("日期") ?? "";
  if (meta.get("计划开始") || meta.get("计划结束")) {
    const parts = dateRange.split(/\s*->\s*/);
    if (parts.length > 2 || parts.some(value => !value || normalizeJournalDate(value) !== value)) {
      throw new VaultApiError("任务看板的计划日期无法核对，原有内容已保留。");
    }
  }
  const { date, endDate } = parseDateRange(dateRange);
  const { dueDate, dueTime } = parseDue(meta.get("截止") ?? "");
  const repeat = parseRepeat(meta.get("重复") ?? "");
  const note = block
    .map((line) => line.match(/^\s*-\s*备注[:：]\s*(.+)$/)?.[1]?.trim() ?? "")
    .filter(Boolean)
    .join("\n");
  const completedAt = meta.get("完成") ?? "";
  const id = meta.get("ID") || stableTaskId(title, date, dueDate, meta.get("项目") ?? "默认", meta.get("分类") ?? "AI建议", occurrence);
  return {
    id,
    title,
    status,
    priority: parsePriority(meta.get("优先级")),
    quadrant: parseQuadrant(meta.get("象限")),
    category: meta.get("分类") ?? "AI建议",
    ...(meta.has("估计分钟") ? { estimateMin: Number(meta.get("估计分钟")) } : {}),
    ...(meta.has("想法ID") ? { ideaId: meta.get("想法ID")! } : {}),
    ...(meta.has("学习轨道") ? { learningTrackId: meta.get("学习轨道") as LifeOpsTask["learningTrackId"] } : {}),
    project: meta.get("项目") ?? "默认",
    date,
    endDate,
    time: meta.get("时间") ?? "",
    ...(meta.has("计划开始") ? { startTime: meta.get("计划开始")! } : {}),
    ...(meta.has("计划结束") ? { endTime: meta.get("计划结束")! } : {}),
    dueDate,
    dueTime,
    repeatUnit: repeat.unit,
    repeatInterval: repeat.interval,
    repeatUntil: repeat.until,
    parentTaskId: "",
    note,
    source: meta.get("来源") ?? "vault",
    sourceNotePath: "",
    createdAt: "",
    updatedAt: completedAt,
    completedAt,
    completionLog: completedAt ? [{ completedAt, note: "" }] : [],
    sortOrder: occurrence
  };
}

function parseMetaFields(line: string): Map<string, string> {
  const value = line.replace(/^\s*-\s*/, "").trim();
  const fields = new Map<string, string>();
  for (const part of value.split(/\s*·\s*/)) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const fieldValue = part.slice(separator + 1).trim();
    if (key) fields.set(key, fieldValue);
  }
  return fields;
}

function markTaskBlockCompleted(block: string[], completedAt: string, note: string): string[] {
  const next = block.slice();
  next[0] = next[0].replace(/^(\s*-\s+)\[[ xX]\]/, "$1[x]");
  const metaIndex = next.findIndex((line) => line.includes("状态=") || line.includes("优先级=") || line.includes("象限="));
  if (metaIndex === -1) {
    next.splice(1, 0, `  - 状态=completed · 完成=${completedAt}`);
  } else {
    next[metaIndex] = updateCompletionMeta(next[metaIndex], completedAt);
  }
  const trimmedNote = note.trim();
  if (trimmedNote) {
    next.push(`  - 完成备注：${trimmedNote}`);
  }
  return trimOuterBlankLines(next);
}

function updateCompletionMeta(line: string, completedAt: string): string {
  const prefix = line.match(/^(\s*-\s*)/)?.[1] ?? "  - ";
  const fields = parseMetaFields(line);
  fields.set("状态", "completed");
  fields.set("完成", completedAt);
  const preferredOrder = ["状态", "优先级", "象限", "分类", "项目", "日期", "时间", "截止", "重复", "完成", "ID", "来源"];
  const parts: string[] = [];
  for (const key of preferredOrder) {
    const value = fields.get(key);
    if (value !== undefined) {
      parts.push(`${key}=${value}`);
      fields.delete(key);
    }
  }
  for (const [key, value] of fields.entries()) {
    parts.push(`${key}=${value}`);
  }
  return `${prefix}${parts.join(" · ")}`;
}

function insertBlockAtTop(lines: string[], block: string[]): string[] {
  const existing = trimOuterBlankLines(lines);
  const cleanBlock = trimOuterBlankLines(block);
  if (existing.length === 0) return cleanBlock;
  return [...cleanBlock, "", ...existing];
}

function sectionStatus(section: string): LifeOpsTaskStatus {
  if (section === COMPLETED_SECTION) return "completed";
  if (section === ABANDONED_SECTION) return "abandoned";
  return "active";
}

function taskMatchesRef(task: LifeOpsTask, idOrTitle: string): boolean {
  const value = idOrTitle.trim();
  return task.id === value || task.title === value || normalizeMatchText(task.title) === normalizeMatchText(value);
}

function isTaskLine(line: string): boolean {
  return /^\s*-\s+\[[ xX]\]\s+/.test(line);
}

function parsePriority(value: string | undefined): LifeOpsTaskPriority {
  if (!value) return "medium";
  return LABEL_TO_PRIORITY[value.trim()] ?? "medium";
}

function parseQuadrant(value: string | undefined): LifeOpsTaskQuadrant {
  if (!value) return "important-not-urgent";
  return LABEL_TO_QUADRANT[value.trim()] ?? "important-not-urgent";
}

function parseStatus(value: string | undefined): LifeOpsTaskStatus | null {
  if (value === "active" || value === "completed" || value === "abandoned") return value;
  return null;
}

function parseDateRange(value: string): { date: string; endDate: string } {
  if (!value || value === "无日期") return { date: "", endDate: "" };
  const [start, end] = value.split(/\s*->\s*/);
  return {
    date: normalizeDateString(start) || "",
    endDate: normalizeDateString(end) || normalizeDateString(start) || ""
  };
}

function parseDue(value: string): { dueDate: string; dueTime: string } {
  const trimmed = value.trim();
  if (!trimmed) return { dueDate: "", dueTime: "" };
  const [date = "", time = ""] = trimmed.split(/\s+/);
  return {
    dueDate: normalizeDateString(date) || "",
    dueTime: normalizeTime(time) || ""
  };
}

function formatRepeat(task: LifeOpsTask): string {
  const unit = task.repeatUnit === "day" ? "天" : task.repeatUnit === "week" ? "周" : "月";
  const base = task.repeatInterval > 1 ? `每 ${task.repeatInterval} ${unit}` : `每${unit}`;
  return task.repeatUntil ? `${base}，至 ${task.repeatUntil}` : base;
}

function parseRepeat(value: string): { unit: LifeOpsTask["repeatUnit"]; interval: number; until: string } {
  const trimmed = value.trim();
  if (!trimmed) return { unit: "none", interval: 1, until: "" };
  const unit = trimmed.includes("天")
    ? "day"
    : trimmed.includes("周")
      ? "week"
      : trimmed.includes("月")
        ? "month"
        : "none";
  const interval = Number(trimmed.match(/每\s*(\d+)\s*[天周月]/)?.[1] ?? "1");
  const until = normalizeDateString(trimmed.match(/至\s*(\d{4}-\d{2}-\d{2})/)?.[1]) || "";
  return {
    unit,
    interval: Number.isFinite(interval) && interval > 0 ? interval : 1,
    until
  };
}

function normalizeDateString(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : "";
}

function normalizeTime(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  return /^\d{1,2}:\d{2}$/.test(trimmed) ? trimmed.padStart(5, "0") : "";
}

function stableTaskId(title: string, date: string, dueDate: string, project: string, category: string, occurrence: number): string {
  return `task-${hashText([title, date, dueDate, project, category, String(occurrence)].join("|"))}`;
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function tokenizeQuery(query: string): string[] {
  const normalized = query.toLowerCase();
  const tokens = normalized.split(/[\s,，。；;:：、]+/).map((item) => item.trim()).filter(Boolean);
  return tokens.length > 0 ? tokens : [normalized];
}

function scoreContent(content: string, terms: string[]): number {
  const haystack = content.toLowerCase();
  return terms.reduce((score, term) => score + countOccurrences(haystack, term), 0);
}

function countOccurrences(value: string, term: string): number {
  if (!term) return 0;
  let count = 0;
  let index = value.indexOf(term);
  while (index !== -1) {
    count += 1;
    index = value.indexOf(term, index + term.length);
  }
  return count;
}

function buildSnippet(content: string, terms: string[]): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  const lower = normalized.toLowerCase();
  const firstHit = terms
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, firstHit - 60);
  return normalized.slice(start, start + 180).trim();
}

function titleFromPath(path: string): string {
  return path.split("/").pop()?.replace(/\.md$/i, "") ?? path;
}

export function renderUserContextMarkdown(goals: VaultNoteRead, tasks: LifeOpsTask[], recentNotes: VaultNoteRead[]): string {
  const activeTasks = tasks.filter((task) => task.status === "active");
  const completedTasks = tasks.filter((task) => task.status === "completed").slice(0, 8);
  return [
    "# LifeOps Vault Context",
    "",
    "## Goals",
    goals.exists ? truncateText(goals.content, 4000) : `未找到目标文件：${goals.path}`,
    "",
    "## Tasks",
    activeTasks.length > 0 ? activeTasks.map(renderTaskContextLine).join("\n") : "- 当前没有进行中任务。",
    completedTasks.length > 0 ? "\n### Recently Completed\n" : "",
    completedTasks.length > 0 ? completedTasks.map(renderTaskContextLine).join("\n") : "",
    "",
    "## Recent Daily Notes",
    recentNotes
      .filter((note) => note.exists && note.content.trim())
      .map((note) => `### ${note.path}\n${truncateText(note.content, 1800)}`)
      .join("\n\n") || "- 最近没有可读取的日记。"
  ].filter((line) => line !== "").join("\n");
}

export function renderTaskContextLine(task: LifeOpsTask): string {
  const date = task.endDate && task.endDate !== task.date ? `${task.date} -> ${task.endDate}` : task.date || "无日期";
  const due = task.dueDate ? `；截止=${task.dueDate}${task.dueTime ? ` ${task.dueTime}` : ""}` : "";
  return `- ${task.title}（${task.status}；优先级=${PRIORITY_TO_LABEL[task.priority]}；象限=${QUADRANT_TO_LABEL[task.quadrant]}；日期=${date}${taskScheduleLabel(task) ? `；${taskScheduleLabel(task)}` : ""}${due}；项目=${task.project}；分类=${task.category}）`;
}

function truncateText(value: string, maxChars: number): string {
  const normalized = value.replace(/\n{3,}/g, "\n\n").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()}\n\n...[truncated ${normalized.length - maxChars} chars]`;
}

function toDateString(value: string | Date): string {
  if (value instanceof Date) return formatDate(value);
  const normalized = normalizeDateString(value);
  if (!normalized) {
    throw new VaultApiError("日期格式必须是 YYYY-MM-DD", value);
  }
  return normalized;
}

function mergeFolders(folders: FolderSettings = DEFAULT_SETTINGS.folders): FolderSettings {
  return { ...DEFAULT_SETTINGS.folders, ...folders };
}

function joinPath(...parts: string[]): string {
  return parts
    .flatMap((part) => part.split("/"))
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");
}

function trimOuterBlankLines(lines: string[]): string[] {
  return trimLeadingBlankLines(trimTrailingBlankLines(lines));
}

function trimLeadingBlankLines(lines: string[]): string[] {
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start += 1;
  return lines.slice(start);
}

function trimTrailingBlankLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end -= 1;
  return lines.slice(0, end);
}

function normalizeMatchText(text: string): string {
  return text.replace(/\s+/g, "").replace(/[，,。.!！?？:：;；、"'“”‘’]/g, "").trim();
}
