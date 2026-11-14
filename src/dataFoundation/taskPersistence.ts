import { createHash } from "node:crypto";
import { defaultTaskBoard, formatVaultTaskBlock, parseVaultTasks } from "../vaultApi";
import type { LifeOpsTask } from "../types";
import type { StoreHost, TaskDatabase } from "../store/settingsSlice";
import { jsonDataContract, parseJsonData, serializeJsonData } from "./jsonDataGuard";
import { validateTaskSchedule } from "../taskSchedule";
import { isLearningTrackId } from "../features/learning/model";

export const taskReadSnapshot = Symbol("lifeops-task-read-snapshot");
export interface TaskReadSnapshot { json: string | null; mirror: string | null; source?: "json" | "mirror" }
export interface TaskMirrorRevision { version: 1; sha256: string }
function digest(text: string): string { return createHash("sha256").update(text, "utf8").digest("hex"); }
export function validateTaskMirrorRevision(database: TaskDatabase): void {
  const value = database.taskMirror;
  if (value !== undefined && (!value || value.version !== 1 || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256))) conflict();
}
function checkMirrorRevision(database: TaskDatabase, mirror: string | null): void {
  validateTaskMirrorRevision(database);
  if (database.taskMirror && mirror !== null && digest(mirror) !== database.taskMirror.sha256) conflict();
}
const queues = new WeakMap<object, Promise<unknown>>();
export class TaskConflictError extends Error {
  readonly code = "LIFEOPS_TASK_CONFLICT";
  constructor() {
    super("任务记录或看板发生了变化，已停止覆盖。原有内容已保留，请先核对两份记录再继续。");
    this.name = "TaskConflictError";
  }
}
function conflict(): never { throw new TaskConflictError(); }
export async function readTaskFile(store: StoreHost, path: string): Promise<string | null> {
  return store.getFile(path) ? store.readPath(path) : null;
}
export function validateTaskRecords(tasks: LifeOpsTask[]): void {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (!task || typeof task !== "object" || typeof task.id !== "string" || !task.id.trim()
      || ids.has(task.id) || typeof task.title !== "string" || !task.title.trim() || /[\r\n]/.test(task.title)
      || [task.id, task.category, task.project, task.source].some(value => typeof value === "string" && /[\r\n·]/.test(value))
      || !["active", "completed", "abandoned"].includes(task.status)
      || task.ideaId !== undefined && (typeof task.ideaId !== "string" || !/^idea-[a-z0-9-]{12,80}$/.test(task.ideaId))
      || task.learningTrackId !== undefined && !isLearningTrackId(task.learningTrackId)
      || (task.completionLog !== undefined && (!Array.isArray(task.completionLog)
        || task.completionLog.some(item => !item || typeof item.completedAt !== "string" || typeof item.note !== "string")))) conflict();
    ids.add(task.id);
    validateTaskSchedule(task);
  }
}
async function serialize<T>(store: StoreHost, work: () => Promise<T>): Promise<T> {
  const key = store.app?.vault ?? store;
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  queues.set(key, next);
  try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}
function sectionTasks(tasks: LifeOpsTask[], status: string): LifeOpsTask[] {
  return tasks.filter(task => task.status === status).slice().sort((a,b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id.localeCompare(b.id));
}
const statuses: Record<string, string> = { "进行中": "active", "已完成": "completed", "放弃": "abandoned" };
function comparable(tasks: LifeOpsTask[]): string {
  // Compare only what the projection can express, using the same renderer/parser
  // on both sides. JSON-only metadata never comes back from the projection.
  return JSON.stringify(tasks.map(({sortOrder, ...task}) => task).sort((a,b)=>a.id.localeCompare(b.id)));
}
function generatedTasks(tasks: LifeOpsTask[]): LifeOpsTask[] {
  return parseVaultTasks(Object.entries(statuses).map(([heading,status])=>`## ${heading}\n${sectionTasks(tasks,status).map(formatVaultTaskBlock).join("\n")}`).join("\n"));
}
export function assertTaskMirrorMatches(mirror: string | null, tasks: LifeOpsTask[]): void {
  if (mirror === null) return;
  const parsed = parseVaultTasks(mirror);
  validateTaskRecords(parsed);
  // Before the mirror gained this field, JSON could already hold an estimate.
  const estimatesInMirror = new Set(parsed.filter(task => task.estimateMin !== undefined).map(task => task.id));
  const projected = generatedTasks(tasks.map(task => estimatesInMirror.has(task.id) ? task : { ...task, estimateMin: undefined }));
  if (comparable(parsed) !== comparable(projected)) conflict();
}

function parseTaskMirror(original: string | null) {
  const lines = (original ?? defaultTaskBoard()).replace(/\r\n/g,"\n").split("\n");
  const sections: Array<{ heading: string; title: string; lines: string[] }> = [];
  const preamble: string[] = [];
  let section: typeof sections[number] | undefined;
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) { section = {heading:line,title:heading[1],lines:[]}; sections.push(section); }
    else if (section) section.lines.push(line);
    else preamble.push(line);
  }
  const extras = new Map<string,string[]>();
  for (const current of sections.filter(s=>Object.hasOwn(statuses,s.title))) {
    let block: string[] = [];
    const finish = () => {
      if (!block.length) return;
      const task = parseVaultTasks(`## ${current.title}\n${block.join("\n")}`)[0];
      if (!task) conflict();
      // Keep indented legacy completion remarks and extension lines verbatim.
      const retained = block.slice(1).filter(line => line.trim() && !/^\s*-\s*(?:状态=|优先级=|象限=|备注[:：])/.test(line));
      const known = new Set(["状态","优先级","象限","分类","估计分钟","想法ID","学习轨道","项目","日期","时间","计划开始","计划结束","截止","重复","完成","ID","来源"]);
      const meta = block.find(line => /状态=|优先级=|象限=/.test(line));
      if (meta) {
        const seen = new Set<string>();
        for (const field of meta.replace(/^\s*-\s*/, "").split(/\s*·\s*/)) {
          const separator = field.indexOf("=");
          if (separator < 1) conflict();
          const key = field.slice(0,separator).trim();
          if (seen.has(key)) conflict();
          seen.add(key);
          if (!known.has(key)) retained.push(`  - 兼容字段：${field}`);
        }
      }
      extras.set(task.id, retained);
      block = [];
    };
    for (const line of current.lines) {
      if (/^\s*-\s+\[[ xX]\]\s+/.test(line)) { finish(); block.push(line); }
      else {
        if (line.trim() && (!block.length || !/^\s+\S/.test(line))) conflict();
        if (block.length) block.push(line);
      }
    }
    finish();
  }
  return { sections, preamble, extras };
}

export function renderTaskMirror(tasks: LifeOpsTask[], original: string | null, restoreFrom?: string | null): string {
  const { sections, preamble, extras } = parseTaskMirror(original);
  if (restoreFrom) {
    for (const [id, lines] of parseTaskMirror(restoreFrom).extras) if (!extras.has(id)) extras.set(id, lines);
  }
  for (const title of Object.keys(statuses)) if (!sections.some(s=>s.title===title)) sections.push({heading:`## ${title}`,title,lines:[]});
  if (sections.filter(s=>Object.hasOwn(statuses,s.title)).length !== 3) conflict();
  const output = [...preamble];
  for (const current of sections) {
    output.push(current.heading);
    if (!Object.hasOwn(statuses,current.title)) { output.push(...current.lines); continue; }
    for (const task of sectionTasks(tasks,statuses[current.title])) {
      output.push(formatVaultTaskBlock(task));
      output.push(...(extras.get(task.id) ?? []));
    }
    output.push("");
  }
  return output.join("\n").replace(/\n*$/, "\n");
}
async function replace(store: StoreHost, path: string, before: string | null, after: string | null): Promise<void> {
  const current = await readTaskFile(store,path);
  if (current !== before) conflict();
  if (before === after) return;
  const file = store.getFile(path);
  if (after === null) {
    if (file) await store.app.vault.delete(file);
  } else if (file) {
    await store.app.vault.process(file, text => {
      if (text !== before) conflict();
      const contract = jsonDataContract(path,store.settings.folders);
      if (contract) { parseJsonData(text,path,contract); parseJsonData(after,path,contract); }
      return after;
    });
  } else {
    await store.ensureFolder(path.split("/").slice(0,-1).join("/"));
    await store.app.vault.create(path,after);
  }
  if (await readTaskFile(store,path) !== after) conflict();
}
export function planTaskDatabaseWrite(store: StoreHost, database: TaskDatabase, restoreMirrorExtrasFrom?: string | null) {
  const snapshot = database[taskReadSnapshot];
  if (!snapshot) conflict();
  validateTaskRecords(database.tasks);
  const contract = jsonDataContract(store.taskDbPath(),store.settings.folders);
  const before: TaskDatabase = snapshot.json === null ? { tasks: [] } : parseJsonData(snapshot.json,store.taskDbPath(),contract) as TaskDatabase;
  // Legacy Markdown remains readable, but adopting it requires a backed-up migration.
  if (snapshot.json === null && parseVaultTasks(snapshot.mirror ?? "").length) conflict();
  checkMirrorRevision(before,snapshot.mirror);
  if (!before.taskMirror) assertTaskMirrorMatches(snapshot.mirror,before.tasks);
  const mirror = renderTaskMirror(database.tasks,snapshot.mirror,restoreMirrorExtrasFrom);
  const revision: TaskMirrorRevision = {version:1,sha256:digest(mirror)};
  const json = serializeJsonData({ ...database, taskMirror: revision }, { compact: true });
  parseJsonData(json,store.taskDbPath(),contract);
  return { snapshot, json, mirror, revision };
}

export async function persistTaskDatabase(store: StoreHost, database: TaskDatabase): Promise<void> {
  await serialize(store,async()=>{
    const { snapshot, json, mirror, revision } = planTaskDatabaseWrite(store, database);
    if (await readTaskFile(store,store.taskDbPath()) !== snapshot.json
      || await readTaskFile(store,store.taskMirrorPath()) !== snapshot.mirror) conflict();
    let wroteJson = false;
    let wroteMirror = false;
    try {
      wroteJson = true; await replace(store,store.taskDbPath(),snapshot.json,json);
      wroteMirror = true; await replace(store,store.taskMirrorPath(),snapshot.mirror,mirror);
      if (await readTaskFile(store,store.taskDbPath()) !== json) conflict();
    } catch (error) {
      // Conditional compensation; never undo a later edit. Crash recovery of full
      // compound actions is a separate WRITE task, not a claim of this coordinator.
      let recoveryFailed = false;
      const restore = async (path: string, expected: string, previous: string | null) => {
        if (await readTaskFile(store,path) === previous) return;
        await replace(store,path,expected,previous);
      };
      if (wroteMirror) await restore(store.taskMirrorPath(),mirror,snapshot.mirror).catch(()=>{ recoveryFailed = true; });
      if (wroteJson) await restore(store.taskDbPath(),json,snapshot.json).catch(()=>{ recoveryFailed = true; });
      if (recoveryFailed) throw new TaskConflictError();
      throw error;
    }
    database.taskMirror = revision;
    database[taskReadSnapshot] = {json,mirror};
  });
}
export async function persistTaskMirror(store: StoreHost, tasks: LifeOpsTask[]): Promise<void> {
  const database = await store.readTaskDb({readOnly:true});
  // Reuse the versioned pair writer so a regenerated mirror updates its recorded hash.
  if (JSON.stringify(database.tasks) !== JSON.stringify(tasks)) conflict();
  const snapshot = database[taskReadSnapshot]!;
  checkMirrorRevision(database,snapshot.mirror);
  if (!database.taskMirror) assertTaskMirrorMatches(snapshot.mirror,database.tasks);
  if (renderTaskMirror(tasks,snapshot.mirror) === snapshot.mirror) return;
  await persistTaskDatabase(store,database);
}
