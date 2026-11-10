export interface ProjectHistorySelection {
  projectId: string;
  entryOffset?: number;
  entryLimit?: number;
  entryId?: string;
  entryField?: "text" | "nextStep";
  textOffset?: number;
  maxChars?: number;
  historyRevision?: string;
}
const fields = ["projectId", "entryOffset", "entryLimit", "entryId", "entryField", "textOffset", "maxChars", "historyRevision"] as const;
function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw Error("项目历史分页须使用有效范围内的整数，请按上一页的读取位置继续。");
  return value;
}
function exactId(value: unknown): string {
  if (typeof value !== "string" || !value || value !== value.trim()) throw Error("请提供查询返回的准确项目或记录ID，不能按名称猜测。");
  return value;
}
/** The old query/limit summary remains compatible. History has explicit,
 * disjoint record-list and saved-field modes; no write or migration occurs. */
export function parseProjectHistorySelection(args: Record<string, unknown>): ProjectHistorySelection | undefined {
  if (!fields.some(field => Object.hasOwn(args, field))) return undefined;
  if (Object.keys(args).some(key => !fields.includes(key as typeof fields[number]))) throw Error("准确项目历史读取不能混入搜索或其它查询字段。");
  const projectId = exactId(args.projectId);
  const historyRevision = args.historyRevision;
  if (historyRevision !== undefined && (typeof historyRevision !== "string" || !/^[a-f\d]{64}$/.test(historyRevision))) throw Error("项目历史版本无效，请重新读取第一页。");
  const selection: ProjectHistorySelection = { projectId, ...(historyRevision ? { historyRevision: historyRevision as string } : {}) };
  if (Object.hasOwn(args, "entryId")) {
    if (Object.hasOwn(args, "entryOffset") || Object.hasOwn(args, "entryLimit")) throw Error("单条保存正文不能混用记录列表分页。");
    const entryId = exactId(args.entryId), entryField = args.entryField ?? "text";
    if (entryField !== "text" && entryField !== "nextStep") throw Error("保存字段只支持text或nextStep。");
    Object.assign(selection, { entryId, entryField, textOffset: integer(args.textOffset, 0, 0, Number.MAX_SAFE_INTEGER), maxChars: integer(args.maxChars, 4000, 500, 18000) });
  } else {
    if (Object.hasOwn(args, "textOffset") || Object.hasOwn(args, "maxChars") || Object.hasOwn(args, "entryField")) throw Error("读取保存文本页须提供准确entryId。");
    Object.assign(selection, { entryOffset: integer(args.entryOffset, 0, 0, Number.MAX_SAFE_INTEGER), entryLimit: integer(args.entryLimit, 5, 1, 10) });
  }
  if ((selection.entryOffset || selection.textOffset) && !selection.historyRevision) throw Error("继续读取项目历史须带第一页的historyRevision，避免把不同版本拼在一起。");
  return selection;
}
