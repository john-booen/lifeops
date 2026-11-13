/** Keep provider-echoed tool result markup out of the visible answer, including split tags. */
export function createToolResultTextFilter(): (chunk: string, final?: boolean) => string {
  let hiding = false;
  let pending = "";
  return (chunk, final = false) => {
    pending += chunk;
    let visible = "";
    while (pending) {
      const tag = hiding ? "</result>" : "<result>";
      const found = pending.search(hiding ? /<\/result>/i : /<result>/i);
      if (found >= 0) {
        if (!hiding) visible += pending.slice(0, found);
        pending = pending.slice(found + tag.length);
        hiding = !hiding;
        continue;
      }
      const lastTag = pending.lastIndexOf("<");
      const keepFrom = !final && lastTag >= 0 && tag.startsWith(pending.slice(lastTag).toLowerCase()) ? lastTag : pending.length;
      if (!hiding) visible += pending.slice(0, keepFrom);
      pending = pending.slice(keepFrom);
      break;
    }
    return visible;
  };
}
