function appendSection(text: string, heading: string, entry: string): string {
  let fence: string | undefined;
  let found = false;
  let offset = 0;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.trimEnd());
    if (marker) {
      const [, run, rest] = marker;
      if (!fence) fence = run;
      else if (run[0] === fence[0] && run.length >= fence.length && !rest.trim()) fence = undefined;
    } else if (!fence) {
      const title = /^ {0,3}#{1,2}[ \t]+(.+?)[ \t]*\r?\n?$/.exec(line)?.[1];
      if (title && found) break;
      if (title === heading && /^ {0,3}##\s/.test(line)) found = true;
    }
    offset += line.length;
  }
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

export function appendEveningEntry(text: string, heading: string, entry: string, original: string): string {
  const section = heading === "原话" || heading === "日记" ? "整理" : heading;
  return appendSection(appendSection(text, section, entry), "原话", journalOriginalBlock(original));
}
