import { createHash } from "node:crypto";
import { normalizeJournalDate } from "./date";

export type LegacyJournalLayoutPreview = {
  eligible: true;
  path: string;
  date: string;
  beforeHash: string;
  afterHash: string;
  removedPrefixBytes: number;
  content: string;
} | { eligible: false; reason: string };

const EMPTY_MORNING_HEADINGS = ["今日主题", "晨间计划", "待办", "已完成", "打卡", "健康", "交易", "灵感", "日记"];

/** Exact, pure preview. The first byte after the final heading's newline belongs
 * to the original body, including any leading blank lines; never trim/reformat it. */
export function previewLegacyJournalLayout(path: string, content: string): LegacyJournalLayoutPreview {
  const name = path.split("/").at(-1) ?? "";
  const match = /^(\d{4}-\d{2}-\d{2})早\.md$/.exec(name);
  if (!match || normalizeJournalDate(match[1]) !== match[1]) {
    return { eligible: false, reason: "只支持文件名日期有效且标明早间的旧日记；其他日期或时段保持原样。" };
  }
  const headings = [`# ${match[1]}早`, ...EMPTY_MORNING_HEADINGS.map(heading => `## ${heading}`)];
  for (const newline of ["\n", "\r\n"]) {
    const prefix = headings.join(newline + newline) + newline;
    if (!content.startsWith(prefix)) continue;
    const body = content.slice(prefix.length);
    if (!body.trim()) return { eligible: false, reason: "旧模板后没有可保留的日记正文，未进行整理。" };
    return { eligible: true, path, date: match[1], beforeHash: hash(content), afterHash: hash(body),
      removedPrefixBytes: Buffer.byteLength(prefix, "utf8"), content: body };
  }
  return { eligible: false, reason: "未完整匹配允许移除的空晨间模板，或其中含有内容；原文保持不变。" };
}

function hash(content: string): string { return createHash("sha256").update(content, "utf8").digest("hex"); }
