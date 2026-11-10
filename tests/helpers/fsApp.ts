import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { readFile, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { App, TFolder, type TFile } from "obsidian";
import { DiskVault } from "./diskVault";

type Callback = (...args: unknown[]) => void;
interface FileEvent { name: string; callback: Callback }

export class FsVault extends DiskVault {
  private readonly listeners = new Map<string, Set<Callback>>();
  readonly adapter = {
    exists: async (path: string) => existsSync(this.diskPath(path)),
    read: async (path: string) => readFile(this.diskPath(path), "utf8"),
    readBinary: async (path: string) => {
      const bytes = await readFile(this.diskPath(path));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    write: async (path: string, value: string) => {
      const existing = this.getFileByPath(path);
      if (existing) await this.modify(existing, value);
      else await this.create(path, value);
    },
    mkdir: async (path: string) => { await this.createFolder(path); },
    remove: async (path: string) => { await rm(this.diskPath(path)); },
    rename: async (from: string, to: string) => { await rename(this.diskPath(from), this.diskPath(to)); },
    stat: async (path: string) => {
      const full = this.diskPath(path);
      if (!existsSync(full)) return null;
      const stat = statSync(full);
      return { type: stat.isDirectory() ? "folder" : "file", ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size };
    },
    list: async (path: string) => {
      const root = path ? this.diskPath(path) : this.root;
      const entries = readdirSync(root, { withFileTypes: true });
      return {
        files: entries.filter((entry) => entry.isFile()).map((entry) => join(path, entry.name)),
        folders: entries.filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name))
      };
    },
    getBasePath: () => this.root,
    getFullPath: (path: string) => this.diskPath(path)
  };

  on(name: string, callback: Callback): FileEvent {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(callback);
    this.listeners.set(name, listeners);
    return { name, callback };
  }

  offref(event: FileEvent): void { this.listeners.get(event.name)?.delete(event.callback); }

  private emit(name: string, ...args: unknown[]): void {
    for (const callback of this.listeners.get(name) ?? []) callback(...args);
  }

  getRoot(): TFolder {
    return Object.assign(new TFolder(), { path: "", name: basename(this.root), children: [] });
  }

  async create(path: string, content: string): Promise<TFile> {
    const file = await super.create(path, content);
    this.emit("create", file);
    return file;
  }

  async modify(file: TFile, content: string): Promise<void> {
    await super.modify(file, content);
    this.emit("modify", this.getFileByPath(file.path));
  }

  async process(file: TFile, updater: (content: string) => string): Promise<string> {
    const result = await super.process(file, updater);
    this.emit("modify", this.getFileByPath(file.path));
    return result;
  }

  async delete(file: TFile): Promise<void> {
    await super.delete(file);
    this.emit("delete", file);
  }

  async rename(file: TFile, path: string): Promise<void> {
    const oldPath = file.path;
    await super.rename(file, path);
    this.emit("rename", file, oldPath);
  }
}

export function createFsApp(root: string): App & { vault: FsVault } {
  const vault = new FsVault(root);
  const getFileCache = (file: TFile) => {
    const text = readFileSync(vault.diskPath(file.path), "utf8");
    const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1] ?? "";
    const frontmatter: Record<string, unknown> = {};
    for (const line of header.split(/\r?\n/)) {
      const match = /^([^\s:#]+):\s*(.*)$/.exec(line);
      if (!match) continue;
      try { frontmatter[match[1]] = JSON.parse(match[2]); }
      catch { frontmatter[match[1]] = match[2]; }
    }
    return { frontmatter, links: [], tags: [] };
  };
  return Object.assign(new App(), {
    vault,
    metadataCache: { getFileCache, getFirstLinkpathDest: (path: string) => vault.getFileByPath(path) ?? vault.getFileByPath(path + ".md") },
    workspace: { getLeavesOfType: () => [], getActiveFile: () => null, trigger: () => {} }
  }) as unknown as App & { vault: FsVault };
}
