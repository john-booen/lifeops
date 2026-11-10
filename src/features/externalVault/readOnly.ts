import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isVaultPathExcluded } from "../../privacy";
import { isContextSourcePath } from "../../sourceReferences";

export interface ExternalVaultSettings { path: string; name: string; folders: string[] }
export interface ExternalMarkdownFile { path: string; mtime: number; size: number }
export const EXTERNAL_READ_LIMIT = 256_000;

function allowedRelativePath(path: string): boolean {
  return isContextSourcePath(path) && path.split("/").every(part => !part.startsWith("."));
}

export function normalizeExternalVault(value: unknown): ExternalVaultSettings {
  const config = value as Partial<ExternalVaultSettings> | undefined;
  const name = typeof config?.name === "string" ? config.name.trim() : "";
  const path = typeof config?.path === "string" ? config.path.trim() : "";
  if (!name || !/^[\p{L}\p{N}_-]{1,48}$/u.test(name) || ["all", "local"].includes(name)
    || !path || !isAbsolute(path) || /[\u0000-\u001f]/.test(path) || !Array.isArray(config?.folders)) {
    throw Error("请填写外部库名称、绝对路径和要读取的目录。");
  }
  const folders = [...new Set(config.folders.map(folder => typeof folder === "string" ? folder.trim().replace(/\/$/, "") : ""))].sort();
  if (!folders.length || folders.some(folder => !allowedRelativePath(folder))) throw Error("外部库目录须为安全的相对路径。");
  return { name, path: resolve(path), folders };
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const within = (path: string, folder: string) => path === folder || path.startsWith(folder + "/");
function denied(): never { throw Error("外部资料库为只读，无法写入。"); }

export class ReadOnlyExternalVault {
  readonly config: ExternalVaultSettings;
  readonly create = denied;
  readonly write = denied;
  readonly modify = denied;
  readonly append = denied;
  readonly delete = denied;
  readonly rename = denied;
  readonly mkdir = denied;
  readonly remove = denied;
  readonly trash = denied;

  constructor(config: ExternalVaultSettings, private readonly excluded: string[] = []) {
    this.config = normalizeExternalVault(config);
  }

  allows(path: string): boolean {
    return allowedRelativePath(path) && this.config.folders.some(folder => within(path, folder))
      && !isVaultPathExcluded(path, this.excluded) && !isVaultPathExcluded("external-vault/" + this.config.name + "/" + path, this.excluded);
  }

  private async root(): Promise<string> {
    if (!(await lstat(this.config.path)).isDirectory()) throw Error("外部库需要是实际目录。");
    return realpath(this.config.path);
  }

  private async exactPath(root: string, path: string): Promise<string> {
    if (!this.allows(path)) throw Error("外部路径已排除或超出已选择目录。");
    const absolute = join(root, ...path.split("/"));
    if (await realpath(absolute) !== absolute) throw Error("外部库不读取符号链接。");
    return absolute;
  }

  async listMarkdown(): Promise<ExternalMarkdownFile[]> {
    const root = await this.root();
    const files = new Map<string, ExternalMarkdownFile>();
    const visit = async (relative: string): Promise<void> => {
      if (!this.allows(relative)) return;
      let absolute: string;
      try { absolute = await this.exactPath(root, relative); } catch (error) { if (missing(error)) return; throw error; }
      const info = await lstat(absolute);
      if (!info.isDirectory()) return;
      for (const entry of await readdir(absolute, { withFileTypes: true })) {
        const child = relative + "/" + entry.name;
        if (!this.allows(child)) continue;
        if (entry.isDirectory()) await visit(child);
        else if (entry.isFile() && child.endsWith(".md")) {
          const current = await lstat(await this.exactPath(root, child));
          if (current.isFile()) files.set(child, { path: child, mtime: current.mtimeMs, size: current.size });
        }
      }
    };
    for (const folder of this.config.folders) await visit(folder);
    return [...files.values()].sort((left, right) => left.path.localeCompare(right.path, "zh-CN"));
  }

  async read(path: string, maxBytes = EXTERNAL_READ_LIMIT): Promise<string> {
    if (!path.endsWith(".md") || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > EXTERNAL_READ_LIMIT) throw Error("外部文件或读取上限无效。");
    const root = await this.root();
    const absolute = await this.exactPath(root, path);
    const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const [snapshot, current] = await Promise.all([file.stat({ bigint: true }), lstat(absolute, { bigint: true })]);
      if (!snapshot.isFile() || snapshot.dev !== current.dev || snapshot.ino !== current.ino
        || await this.exactPath(root, path) !== absolute || snapshot.size > BigInt(maxBytes)) {
        throw Error("外部笔记超出读取上限或来源已经变化。");
      }
      const bytes = Buffer.alloc(Number(snapshot.size));
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await file.stat({ bigint: true });
      if (offset !== bytes.length || snapshot.mtimeNs !== after.mtimeNs || snapshot.size !== after.size) throw Error("外部笔记正在变化，请重试。");
      return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    } finally { await file.close(); }
  }
}
