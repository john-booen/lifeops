import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile, unlink, rename } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { TFile as MockFile, TFolder as MockFolder } from "obsidian";
import type { TFile } from "obsidian";

export class DiskVault {
  readonly writes: Array<{ kind: string; path: string }> = [];
  processCalls = 0;
  beforeProcess?: (file: TFile) => Promise<void>;
  readFailure?: Error;

  constructor(readonly root: string) {}
  getName(): string { return "Synthetic Test Vault"; }

  diskPath(path: string): string {
    const target = resolve(this.root, path);
    const child = relative(this.root, target);
    if (child === ".." || child.startsWith(`..${sep}`) || resolve(target) === resolve(this.root)) {
      throw new Error("Test path must be a file or folder inside its temporary root");
    }
    return target;
  }

  getAbstractFileByPath(path: string): TFile | InstanceType<typeof MockFolder> | null {
    const target = this.diskPath(path);
    if (!existsSync(target)) return null;
    const stat = statSync(target);
    const name = path.split("/").at(-1) ?? "";
    if (stat.isDirectory()) return Object.assign(new MockFolder(), {
      path, name, children: readdirSync(target).map(child => this.getAbstractFileByPath(`${path}/${child}`))
    });
    return Object.assign(new MockFile(), {
      path, name, basename: name.replace(/\.[^.]+$/, ""), extension: name.split(".").at(-1) ?? "",
      stat: { ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size }
    });
  }

  getFileByPath(path: string): TFile | null {
    const file = this.getAbstractFileByPath(path);
    return file instanceof MockFile ? file : null;
  }

  async read(file: TFile): Promise<string> {
    if (this.readFailure) throw this.readFailure;
    return readFile(this.diskPath(file.path), "utf8");
  }

  async cachedRead(file: TFile): Promise<string> { return this.read(file); }

  async createFolder(path: string): Promise<void> {
    await mkdir(this.diskPath(path));
    this.writes.push({ kind: "createFolder", path });
  }

  async create(path: string, content: string): Promise<TFile> {
    await writeFile(this.diskPath(path), content, { encoding: "utf8", flag: "wx" });
    this.writes.push({ kind: "create", path });
    return this.getFileByPath(path)!;
  }

  async modify(file: TFile, content: string): Promise<void> {
    await writeFile(this.diskPath(file.path), content, "utf8");
    this.writes.push({ kind: "modify", path: file.path });
  }

  async delete(file: TFile): Promise<void> { await unlink(this.diskPath(file.path)); this.writes.push({ kind: "delete", path: file.path }); }

  async rename(file: TFile, path: string): Promise<void> {
    if (existsSync(this.diskPath(path))) throw new Error("Destination already exists");
    const before = file.path;
    await rename(this.diskPath(before), this.diskPath(path));
    file.path = path;
    this.writes.push({ kind: "rename", path: before });
  }

  async process(file: TFile, updater: (content: string) => string): Promise<string> {
    this.processCalls += 1;
    const hook = this.beforeProcess;
    this.beforeProcess = undefined;
    await hook?.(file);
    // Read after the race hook, as Obsidian's process callback sees current bytes.
    const next = updater(await this.read(file));
    await writeFile(this.diskPath(file.path), next, "utf8");
    this.writes.push({ kind: "process", path: file.path });
    return next;
  }

  getMarkdownFiles(): TFile[] {
    const walk = (folder: string): string[] => readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
      const path = resolve(folder, entry.name);
      return entry.isDirectory() ? walk(path) : [relative(this.root, path).split(sep).join("/")];
    });
    return walk(this.root).filter((path) => path.endsWith(".md")).map((path) => this.getFileByPath(path)!);
  }

  async seed(path: string, content: string): Promise<void> {
    await mkdir(dirname(this.diskPath(path)), { recursive: true });
    await writeFile(this.diskPath(path), content, "utf8");
  }

  async bytes(path: string): Promise<string> { return readFile(this.diskPath(path), "utf8"); }
}
