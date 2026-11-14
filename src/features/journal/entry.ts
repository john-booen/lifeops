import { MarkdownBlocks } from "../../dataFoundation/markdownBlocks";

function appendSection(text: string, heading: string, entry: string): string {
  const blocks = new MarkdownBlocks();
  let found = false;
  let offset = 0;
  for (const line of text.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/gu) ?? []) {
    const body = line.trimEnd();
    if (!blocks.skip(body, offset === 0)) {
      const title = /^ {0,3}#{1,2}[ \t]+(.+)$/u.exec(body)?.[1];
      if (title && found) break;
      if (title === heading && /^ {0,3}##\s/u.test(body)) found = true;
    }
    offset += line.length;
  }
  if (!blocks.canAppend) throw Error("日记里有未闭合的属性、注释或代码块，请先核对原文再追加。");
  const before = text.slice(0, offset), after = text.slice(offset);
  const separator = before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
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
  const blocks = new MarkdownBlocks();
  const draft = content.split(/(\r\n|\n|\r)/u).map((line, index) => {
    if (index % 2 || blocks.skip(line, false)) return line;
    return line.replace(/^( {0,3})#{1,2}(?=[ \t])/u, "$1###");
  }).join("");
  if (!blocks.canAppend) throw Error("整理稿有未闭合的注释或代码块，请调整后再追加。");
  return draft;
}

export function appendEveningEntry(text: string, heading: string, entry: string, original: string): string {
  const section = heading === "原话" || heading === "日记" ? "整理" : heading;
  return appendSection(appendSection(text, section, entry), "原话", journalOriginalBlock(original));
}
