import { MarkdownBlocks } from "../../dataFoundation/markdownBlocks";

interface DiaryHeading {
  title: string;
  level: number;
  from: number;
  through: number;
  underline?: true;
}

function scanDiaryHeadings(text: string, allowFrontmatter: boolean) {
  const blocks = new MarkdownBlocks();
  const headings: DiaryHeading[] = [];
  let paragraph: { from: number; lines: string[] } | undefined;
  let blockContinuation = false;
  let offset = 0;
  for (const line of text.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/gu) ?? []) {
    const from = offset;
    offset += line.length;
    const body = (from === 0 && allowFrontmatter ? line.replace(/^\uFEFF/u, "") : line).trimEnd();
    if (blocks.skip(body, allowFrontmatter && from === 0) || !body.trim()) {
      paragraph = undefined;
      blockContinuation = false;
      continue;
    }
    const heading = /^ {0,3}(#{1,6})[ \t]+(.*)$/u.exec(body);
    const underline = /^ {0,3}(=+|-+)$/u.exec(body);
    if (heading) {
      const title = heading[2].replace(/[ \t]+#+$/u, "").trim();
      headings.push({ title, level: heading[1].length, from, through: offset });
      paragraph = undefined;
      blockContinuation = false;
    } else if (underline) {
      if (paragraph) headings.push({
        title: paragraph.lines.join(" "), level: underline[1][0] === "=" ? 1 : 2,
        from: paragraph.from, through: offset, underline: true
      });
      paragraph = undefined;
      blockContinuation = false;
    } else if (/^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/u.test(body)) {
      paragraph = undefined;
      blockContinuation = false;
    } else if (/^ {0,3}(?:[><]|(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$))/u.test(body)) {
      paragraph = undefined;
      blockContinuation = true;
    } else if (!blockContinuation && /^ {0,3}(?=\S)/u.test(body)) {
      paragraph ??= { from, lines: [] };
      paragraph.lines.push(body.trim());
    } else {
      paragraph = undefined;
    }
  }
  return { headings, complete: blocks.canAppend };
}

function appendSection(text: string, heading: string, entry: string, preserveUnsectionedDiary = false): string {
  const scanned = scanDiaryHeadings(text, true);
  const sections = scanned.headings.filter(row => row.level <= 2);
  const target = sections.findIndex(row => row.level === 2 && (row.title === heading || preserveUnsectionedDiary && row.title === "日记"));
  const found = target >= 0;
  const boundary = found ? sections[target + 1] : undefined;
  if (!boundary && !scanned.complete) throw Error("日记里有未闭合的属性、注释或代码块，请先核对原文再追加。");
  const offset = boundary?.from ?? text.length;
  const before = text.slice(0, offset), after = text.slice(offset);
  const separator = before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  if (preserveUnsectionedDiary && !found && !sections.some(row => row.level === 2 && row.title === "原话")) {
    return before + separator + entry + "\n";
  }
  return before + separator + (found ? "" : `## ${heading}\n\n`) + entry + "\n\n" + after;
}

export function journalOriginalBlock(source: string): string {
  let longest = 2;
  for (const run of source.matchAll(/~+/g)) longest = Math.max(longest, run[0].length);
  const fence = "~".repeat(longest + 1);
  return `${fence}\n${source}\n${fence}`;
}

export function journalDraftContent(content: string): string {
  // Draft headings are nested under their own section, including headings named 原话.
  const scanned = scanDiaryHeadings(content, false);
  if (!scanned.complete) throw Error("整理稿有未闭合的注释或代码块，请调整后再追加。");
  let draft = "", offset = 0;
  for (const heading of scanned.headings) {
    if (heading.level > 2) continue;
    const raw = content.slice(heading.from, heading.through);
    const nested = heading.underline
      ? "### " + heading.title + (/(?:\r\n|\n|\r)$/u.exec(raw)?.[0] ?? "")
      : raw.replace(/^( {0,3})#{1,2}(?=[ \t])/u, "$1###");
    draft += content.slice(offset, heading.from) + nested;
    offset = heading.through;
  }
  return draft + content.slice(offset);
}

export function appendEveningEntry(text: string, heading: string, entry: string, original?: string): string {
  const section = heading === "原话" || heading === "日记" ? "整理" : heading;
  const draft = appendSection(text, section, entry, original === undefined && heading === "日记");
  return original === undefined ? draft : appendSection(draft, "原话", journalOriginalBlock(original));
}
