import type { StoreHost } from "./store/settingsSlice";

export type LocalRecordKind = "morning" | "evening" | "trading-review";

export interface LocalRecordNoteInput {
  kind: LocalRecordKind;
  date: string;
}

/** Resolve before entering a write operation, so opening a note stays read-only. */
export function localRecordNotePath(store: StoreHost, input: LocalRecordNoteInput): string {
  if (!input || !["morning", "evening", "trading-review"].includes(input.kind)) {
    throw new Error("请选择晨间日记、晚间日记或交易复盘。");
  }
  assertDate(input.date);
  const folder = input.kind === "trading-review"
    ? store.settings.folders.tradingReviews : store.settings.folders.dailyRoot;
  assertRelativePath(folder);
  const path = input.kind === "trading-review"
    ? store.tradingReviewPath(input.date)
    : store.dailyNotePath(input.date, input.kind === "morning" ? "早" : "晚");
  assertRelativePath(path);
  const operations = store.path(store.settings.folders.aiReports, "Operations");
  if (!path.startsWith(`${folder}/`) || !path.endsWith(".md") || path.startsWith(`${operations}/`)) {
    throw new Error("记录目录不正确，请先检查日记和交易复盘的保存位置。");
  }
  return path;
}

/** New files must be created through AgentRuntime.executeLocalOperation. */
export async function ensureLocalRecordNote(
  store: StoreHost,
  input: LocalRecordNoteInput
): Promise<{ path: string; created: boolean }> {
  const path = localRecordNotePath(store, input);
  if (store.getFile(path)) return { path, created: false };
  if (input.kind === "trading-review") {
    await store.ensureFile(path, manualTradingReview(input.date));
  } else {
    await store.ensureDailyNote(input.date, input.kind === "morning" ? "早" : "晚");
  }
  return { path, created: true };
}

function assertDate(value: string): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("请选择有效日期，格式为 YYYY-MM-DD。");
  }
  const [year, month, day] = value.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) {
    throw new Error("这个日期不存在，请重新选择。");
  }
}

function assertRelativePath(value: string): void {
  if (typeof value !== "string" || !value.trim() || /[\\:\x00-\x1f\x7f]/.test(value)
    || value.split("/").some(part => !part || part.startsWith("."))) {
    throw new Error("记录目录不正确，请选择仓库内的普通文件夹。");
  }
}

function manualTradingReview(date: string): string {
  return [
    `# ${date} 交易复盘`, "",
    "## 今日交易", "",
    "## 使用的模型与入场依据", "",
    "## 实际操作与结果", "",
    "## 做得好的地方", "",
    "## 需要改进的地方", "",
    "## 下一次提醒", ""
  ].join("\n");
}
