import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";

const [path] = process.argv.slice(2);
if (process.argv.length !== 3 || !path) throw Error("用法：node scripts/vault-fingerprint.mjs <Vault 路径>");
const root = resolve(path);
if (!(await lstat(root)).isDirectory()) throw Error("Vault 必须是实际目录。");

const contents = createHash("sha256");
const modified = createHash("sha256");
let files = 0, symlinks = 0, bytes = 0n, latest = 0n;
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const version = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs].map(String).join(":");
const record = (path, type, stat, hash) => {
  contents.update(JSON.stringify([path, type, String(stat.size), hash]) + "\n");
  modified.update(JSON.stringify([path, type, String(stat.mtimeNs)]) + "\n");
  if (stat.mtimeNs > latest) latest = stat.mtimeNs;
};

async function walk(directory, prefix = "") {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => compare(left.name, right.name))) {
    const path = join(directory, entry.name);
    const relative = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.isDirectory()) { await walk(path, relative); continue; }
    const initial = await lstat(path, { bigint: true });
    if (initial.isSymbolicLink()) {
      const target = await readlink(path);
      if (version(await lstat(path, { bigint: true })) !== version(initial)) throw Error("链接在核对期间发生变化，请重新运行。");
      record(relative, "link", initial, createHash("sha256").update(target).digest("hex"));
      symlinks++;
      continue;
    }
    if (!initial.isFile()) throw Error("Vault 含有无法核对的特殊文件。");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat({ bigint: true });
      if (version(before) !== version(initial)) throw Error("文件在核对期间发生变化，请重新运行。");
      const hash = createHash("sha256");
      for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
      const after = await file.stat({ bigint: true });
      if (version(after) !== version(before) || version(await lstat(path, { bigint: true })) !== version(before)) {
        throw Error("文件在核对期间发生变化，请重新运行。");
      }
      record(relative, "file", before, hash.digest("hex"));
      files++;
      bytes += before.size;
    } finally { await file.close(); }
  }
}

await walk(root);
console.log(JSON.stringify({ files, symlinks, bytes: String(bytes), latestModifiedAt: latest ? new Date(Number(latest / 1_000_000n)).toISOString() : null,
  contentsSha256: contents.digest("hex"), modificationTimesSha256: modified.digest("hex") }));
