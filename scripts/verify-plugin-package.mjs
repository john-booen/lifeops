import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RESOURCE_MANIFEST = "RESOURCE-MANIFEST.json";
export const LICENSE_PATHS = Object.freeze(["LICENSE"]);
export const RESOURCE_PATHS = [...LICENSE_PATHS];
export const PACKAGE_FILES = ["main.js", "manifest.json", "styles.css", RESOURCE_MANIFEST, ...RESOURCE_PATHS].sort();
const allowedFiles = new Set([...PACKAGE_FILES, "SHA256SUMS.txt"]);
const allowedDirectories = new Set();
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const secretPatterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["provider token", /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/],
  ["Aliyun AccessKey", /(?:^|[^A-Za-z0-9])LTAI[A-Za-z0-9]{16,}/],
  ["literal bearer token", /\bBearer\s+[A-Za-z0-9._~+\/-]{24,}/]
];
export function assert(condition, message) { if (!condition) throw new Error(message); }
export function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
export async function readRegularFile(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    assert(before.isFile() && before.size <= 64 * 1024 * 1024, "Package input must be a bounded regular file");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    assert(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, "Package input changed while being read");
    return bytes;
  } finally { await handle.close(); }
}
export async function readSourceFile(root, path) {
  assert(!path.includes("..") && !path.startsWith("/"), "Invalid package source path");
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    assert(!(await lstat(current)).isSymbolicLink(), `Symbolic link in package source: ${path}`);
  }
  return readRegularFile(current);
}
export async function readTrustedResources(root, checkInstalled = false) {
  const bytes = await readSourceFile(root, "scripts/plugin-package-resources.json");
  const manifest = JSON.parse(bytes.toString("utf8"));
  assert(manifest.schemaVersion === 1 && Array.isArray(manifest.files), "Invalid trusted resource manifest");
  const paths = manifest.files.map(file => file.path);
  assert(paths.length === RESOURCE_PATHS.length && new Set(paths).size === paths.length && RESOURCE_PATHS.every(path => paths.includes(path)), "Trusted resource manifest has an invalid file list");
  for (const file of manifest.files) {
    const source = "LICENSE";
    assert(file.source === source && /^[a-f0-9]{64}$/.test(file.sha256) && Number.isSafeInteger(file.sizeBytes) && file.sizeBytes > 0, "Invalid trusted resource entry");
  }
  return { bytes, manifest };
}
export async function collectPackageFiles(packageDir) {
  const rootStat = await lstat(packageDir);
  assert(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "Package directory must not be a symbolic link");
  const files = [];
  async function visit(folder) {
    for (const entry of await readdir(folder)) {
      const path = join(folder, entry); const name = relative(packageDir, path).split("\\").join("/");
      const stat = await lstat(path);
      assert(!stat.isSymbolicLink(), `Symbolic link in package: ${name}`);
      if (stat.isDirectory()) {
        assert(allowedDirectories.has(name), `Unexpected package directory: ${name}`); await visit(path);
      } else {
        assert(stat.isFile(), `Non-regular package entry: ${name}`);
        assert(allowedFiles.has(name), `Unexpected package file: ${name}`); files.push(name);
      }
    }
  }
  await visit(packageDir);
  for (const name of allowedFiles) assert(files.includes(name), `Missing package file: ${name}`);
  return files.sort();
}
export async function verifyPluginPackage({ root = sourceRoot, packageDir = join(root, "dist", "lifeops-assistant") } = {}) {
  const names = await collectPackageFiles(packageDir);
  const contents = new Map();
  for (const name of names) contents.set(name, await readSourceFile(packageDir, name));
  const rootManifest = JSON.parse((await readSourceFile(root, "manifest.json")).toString("utf8"));
  const packageManifest = JSON.parse(contents.get("manifest.json").toString("utf8"));
  assert(packageManifest.id === "lifeops-assistant", "Package manifest has the wrong plugin id");
  assert(packageManifest.version === rootManifest.version, "Package manifest version differs from workspace manifest");
  assert(packageManifest.isDesktopOnly === true, "Package must be desktop-only");
  for (const [name, bytes] of contents) {
    if (name !== "LICENSE" && !/\.(?:js|json|md|css|txt)$/.test(name)) continue;
    const content = bytes.toString("utf8");
    assert(!/sourceMappingURL\s*=|["']sourcesContent["']\s*:/.test(content), `Development sourcemap in package: ${name}`);
    for (const [label, pattern] of secretPatterns) assert(!pattern.test(content), `Credential-like ${label} in package: ${name}`);
  }
  const main = contents.get("main.js").toString("utf8");
  const cancelledVideoMarkers = ["openVideoAnalysis", "analyzeVideoSamples", "selected_video_samples", "lifeops-video-", "选择片段并预览"];
  for (const name of ["main.js", "styles.css"]) {
    const content = contents.get(name).toString("utf8");
    for (const marker of cancelledVideoMarkers) assert(!content.includes(marker), `Cancelled file-video runtime leaked into package: ${name}`);
  }
  for (const forbidden of ["pollScreenObserver", "captureScreenObservationSample", "transcribeWithTingwu", "LifeOps gateway listening", "LifeOps offline recovery:"]) assert(!main.includes(forbidden), `Excluded 0.2 runtime leaked into package: ${forbidden}`);
  const trusted = await readTrustedResources(root);
  assert(contents.get(RESOURCE_MANIFEST).equals(trusted.bytes), "Package resource manifest differs from reviewed source");
  for (const resource of trusted.manifest.files) {
    const bytes = contents.get(resource.path);
    assert(bytes.length === resource.sizeBytes && sha256(bytes) === resource.sha256, `Resource hash differs from reviewed source: ${resource.path}`);
  }
  const checksums = new Map();
  for (const line of contents.get("SHA256SUMS.txt").toString("utf8").trim().split("\n")) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    assert(match && PACKAGE_FILES.includes(match[2]), "Invalid package checksum entry");
    assert(!checksums.has(match[2]), `Duplicate package checksum: ${match[2]}`);
    checksums.set(match[2], match[1]);
  }
  assert(checksums.size === PACKAGE_FILES.length, "Checksum list does not match package contents");
  for (const name of PACKAGE_FILES) assert(checksums.get(name) === sha256(contents.get(name)), `Checksum mismatch: ${name}`);
  return {
    packageDir,
    files: names.length,
    bytes: [...contents.values()].reduce((sum, value) => sum + value.length, 0),
    contents
  };
}
export function parseOutput(args, flag, fallback) {
  if (args.length === 0) return fallback;
  assert(args.length === 2 && args[0] === flag && args[1].trim(), `Usage: ${flag} /absolute/or/relative/package-directory`);
  return resolve(args[1]);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packageDir = parseOutput(process.argv.slice(2), "--package", join(sourceRoot, "dist", "lifeops-assistant"));
  const result = await verifyPluginPackage({ packageDir });
  console.log(`Verified local plugin package: ${result.files} allowlisted files, ${result.bytes} bytes`);
  console.log("Desktop, sourcemap, credential patterns, resource pins, checksums and excluded-runtime checks passed");
}
