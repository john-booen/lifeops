export { fileRevision as contextSourceHash } from "./operationIdentity";

/** Request-local metadata, supplied by controlled file readers, never by parsing
 * user Markdown. Fragments live only while preparing this request. */
export type ContextSourceRecorder = (path: string, fragment: string, sourceHash?: string) => void;
export interface ContextSourceBlock { readonly path: string; readonly fragment: string; readonly sourceHash?: string }
export interface CapturedContext { readonly text: string; readonly blocks: readonly ContextSourceBlock[] }

export function isContextSourcePath(path: string): boolean {
  return typeof path === "string" && !!path && path === path.trim()
    && !/[\u0000-\u001f\u007f\\]/.test(path) && !/^(?:\/|~|[a-z][a-z\d+.-]*:)/i.test(path)
    && path.split("/").every(part => !!part && part !== "." && part !== "..");
}

export async function captureContextSources(build: (record: ContextSourceRecorder) => Promise<string>): Promise<CapturedContext> {
  const blocks: ContextSourceBlock[] = [];
  let open = true;
  const record: ContextSourceRecorder = (path, fragment, sourceHash) => {
    if (!open || !isContextSourcePath(path) || typeof fragment !== "string" || !fragment.trim()) return;
    blocks.push(Object.freeze({ path, fragment, ...(/^[a-f\d]{64}$/.test(sourceHash ?? "") ? { sourceHash } : {}) }));
  };
  try {
    const text = await build(record);
    return Object.freeze({ text, blocks: Object.freeze(blocks.slice()) });
  } finally { open = false; }
}

/** Optional diagnostics must never change a successful builder's behavior. */
export function recordContextSource(record: ContextSourceRecorder | undefined, path: string, fragment: string, sourceHash?: string): void {
  try { record?.(path, fragment, sourceHash); } catch { /* No IO, retries or content logging. */ }
}
