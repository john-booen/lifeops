/** Recognize block syntax whose contents should stay out of LifeOps records. */
export class MarkdownBlocks {
  private frontmatter = false;
  private fence?: string;
  private comment?: "-->" | "%%";

  get canAppend(): boolean {
    return !this.frontmatter && !this.fence && !this.comment;
  }

  skip(raw: string, firstLine: boolean): boolean {
    const line = firstLine ? raw.replace(/^\uFEFF/u, "") : raw;
    if (firstLine && line.trimEnd() === "---") {
      this.frontmatter = true;
      return true;
    }
    if (this.frontmatter) {
      if (/^(?:---|\.\.\.)[ \t]*$/u.test(line)) this.frontmatter = false;
      return true;
    }
    if (this.comment) {
      if (line.includes(this.comment)) this.comment = undefined;
      return true;
    }
    if (!this.fence) {
      const opener = /^\s*(<!--|%%)/u.exec(line);
      if (opener) {
        const close = opener[1] === "<!--" ? "-->" : "%%";
        if (!line.includes(close, opener[0].length)) this.comment = close;
        return true;
      }
    }
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (marker) {
      const [, run, rest] = marker;
      if (!this.fence) this.fence = run;
      else if (run[0] === this.fence[0] && run.length >= this.fence.length && !rest.trim()) this.fence = undefined;
      return true;
    }
    return Boolean(this.fence);
  }
}
