import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeDiskPath } from "../src/dataFoundation/offlineRecovery.ts";

const outputRoot = fileURLToPath(new URL("../docs/vault-map/", import.meta.url));
const headerLimit = 128 * 1024;
const increment = (counts, key) => counts.set(key, (counts.get(key) ?? 0) + 1);
const escape = (value) => value.replace(/[\\`|<>]/g, (character) => "\\" + character).replace(/[\r\n]/g, " ");

export function namingPattern(name) {
  const stem = name.slice(0, -3);
  const suffix = /[早晚晨]$/.exec(stem)?.[0] ?? "";
  if (/^\d{4}-\d{2}-\d{2}(?:\s*[早晚晨])?$/.test(stem)) return "YYYY-MM-DD" + (suffix ? " " + suffix : "") + ".md";
  if (/^\d{4}年\d{1,2}月\d{1,2}日(?:\s*[早晚晨])?$/.test(stem)) return "YYYY年MM月DD日" + suffix + ".md";
  if (/^\d{8}(?:\s*[早晚晨])?$/.test(stem)) return "YYYYMMDD" + suffix + ".md";
  if (/^\d{4}[-_]\d{2}[-_]\d{2}/.test(stem)) return "YYYY-MM-DD <标题>.md";
  if (/^\d+$/.test(stem)) return "数字.md";
  return "自定义标题.md";
}

async function frontmatterKeys(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const beginning = Buffer.alloc(8);
    const first = await handle.read(beginning, 0, beginning.length, 0);
    if (!/^\uFEFF?---\r?\n/.test(beginning.subarray(0, first.bytesRead).toString("utf8"))) return { keys: [], incomplete: false };
    const chunks = [];
    let offset = 0;
    while (offset < headerLimit) {
      const buffer = Buffer.alloc(Math.min(1024, headerLimit - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      chunks.push(buffer.subarray(0, bytesRead));
      offset += bytesRead;
      const text = Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "");
      const ending = /^---\r?\n([\s\S]*?)^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(text);
      if (!ending) continue;
      const keys = new Set();
      for (const line of ending[1].split(/\r?\n/)) {
        const match = /^(?:"([^"\\]+)"|'((?:[^']|'')+)'|([^\s#'"{}[\]][^:]*?)):[ \t]*(?:.*)$/.exec(line);
        const key = match?.[1] ?? match?.[2]?.replace(/''/g, "'") ?? match?.[3]?.trim();
        if (key && key.length <= 100) keys.add(key);
      }
      return { keys: [...keys], incomplete: false };
    }
    return { keys: [], incomplete: true };
  } finally {
    await handle.close();
  }
}

export async function mapVault(vaultPath) {
  const root = resolve(vaultPath);
  await assertSafeDiskPath(root);
  if (!(await lstat(root)).isDirectory()) throw Error("库路径必须是目录");
  const folders = [];
  const skipped = { links: 0, incompleteFrontmatter: 0 };
  async function visit(folder, depth) {
    const entry = { path: folder || ".", depth, markdown: 0, total: 0, modified: null, keys: new Map(), patterns: new Map() };
    folders.push(entry);
    const children = await readdir(join(root, folder), { withFileTypes: true });
    for (const item of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name.startsWith(".")) continue;
      const path = join(folder, item.name);
      if (item.isSymbolicLink()) { skipped.links++; continue; }
      if (item.isDirectory()) {
        const child = await visit(path, depth + 1);
        entry.total += child.total;
        if (child.modified && (!entry.modified || child.modified > entry.modified)) entry.modified = child.modified;
      } else if (item.isFile() && /\.md$/i.test(item.name)) {
        const fullPath = join(root, path);
        const stat = await lstat(fullPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) { skipped.links++; continue; }
        entry.markdown++;
        entry.total++;
        const modified = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(stat.mtime);
        if (!entry.modified || modified > entry.modified) entry.modified = modified;
        increment(entry.patterns, namingPattern(item.name));
        const header = await frontmatterKeys(fullPath);
        if (header.incomplete) skipped.incompleteFrontmatter++;
        for (const key of header.keys) increment(entry.keys, key);
      }
    }
    return entry;
  }
  await visit("", 0);
  const visible = folders.filter((folder) => folder.depth <= 4);
  const top = (counts) => [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10)
    .map(([key, count]) => `${escape(key)}（${count}）`).join("、") || "无";
  const lines = [
    `# ${escape(basename(root))} 结构映射`, "",
    "统计可见目录。直属数量只计本层，含子目录数量统计全部层级。目录显示到第 4 层，修改日期取本目录树内 Markdown 的最近文件修改日期，按上海时区显示。", "",
    "| 目录树 | 直属 .md | 含子目录 .md | 最近修改日期 | frontmatter 顶层键前 10 | 命名模式前 10 |",
    "|---|---:|---:|---|---|---|",
    ...visible.map((folder) => `| ${"　".repeat(folder.depth)}${escape(folder.path)} | ${folder.markdown} | ${folder.total} | ${folder.modified ?? "无"} | ${top(folder.keys)} | ${top(folder.patterns)} |`),
    "", `跳过链接 ${skipped.links} 个，frontmatter 未闭合或超过读取上限 ${skipped.incompleteFrontmatter} 篇。`, ""
  ];
  return { markdown: lines.join("\n"), folders: visible, skipped };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw Error("用法 node scripts/map-vault.mjs <库路径>");
  const path = resolve(process.argv[2]);
  const { markdown, folders } = await mapVault(path);
  await assertSafeDiskPath(outputRoot);
  await mkdir(outputRoot, { recursive: true });
  const output = join(outputRoot, basename(path) + ".md");
  const stage = output + ".tmp-" + process.pid;
  let created = false;
  try {
    await writeFile(stage, markdown, { flag: "wx", mode: 0o600 });
    created = true;
    await rename(stage, output);
  } finally {
    if (created) await rm(stage, { force: true });
  }
  console.log(`结构映射已写入 · ${folders.length} 个可见目录 · ${folders[0].total} 篇 Markdown`);
}
