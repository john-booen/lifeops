import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const mode = process.argv[2] || "--all";
if (!["--all", "--staged", "--history"].includes(mode) || process.argv.length > 3) throw Error("无效的检查模式");
const git = (...args) => execFileSync("git", args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
const paths = (...args) => git(...args).toString("utf8").split("\0").filter(Boolean);
const sibling = resolve(dirname(root.replace(/\/$/, "")), "lifeops-private/sensitive-terms.txt");
const termsFile = process.env.LIFEOPS_SENSITIVE_TERMS_FILE || (existsSync(sibling) ? sibling : undefined);
if (mode === "--staged" && !termsFile) throw Error("请先配置代码库外的敏感词清单");
let terms = [];
if (termsFile) {
  const external = realpathSync(termsFile);
  const rel = relative(realpathSync(root), external);
  if (!isAbsolute(external) || !(rel === ".." || rel.startsWith("../"))) throw Error("敏感词清单必须在代码库外");
  terms = readFileSync(external,"utf8").split(/\r?\n/).map(x=>x.trim()).filter(x=>x && !x.startsWith("#"));
}
const homePath = new RegExp(["/", "Users", "/", "[a-zA-Z0-9._-]+/"].join(""));
const secret = /(?:-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----|\bsk-(?:proj-)?[a-zA-Z0-9_-]{20,}\b|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bLTAI[A-Za-z0-9]{16,}\b|\bgh[pousr]_[a-zA-Z0-9]{30,}\b|\bgithub_pat_[a-zA-Z0-9_]{30,}\b)/;
const forbidden = /^(?:docs\/(?:archive\/|plan\/|PROGRESS\.md|QUESTIONS_FOR_|CLAUDE)|fixtures\/real-provider\/|output\/|dist\/|test-vault\/|node_modules\/|prototypes\/)|(?:^|\/)(?:release\.config\.json|sensitive-terms\.txt|breeze-paths\.json|\.env(?:\.|$)|[^/]+\.(?:pem|key|log))$/i;
// Only the reviewed fictional images may bypass text scanning.
const reviewedImages = new Map([
  ["docs/images/lifeops-overview.png", "9e6d8c5f4596b3c199b44fcb22564550bc1b981c6c139b25acc37a8886baaa99"],
  ["tests/fixtures/trade-screenshots/crypto-open.png", "2b84f4a23a4f2db71483fa2ad17e0e5b174b997ef37279614ba5699205ab3d67"],
  ["tests/fixtures/trade-screenshots/equity-match.png", "6b78eba15f381e9ba33fa7cdb257ae31f8a25f8576d77ac04a3310ac2db3f783"],
  ["tests/fixtures/trade-screenshots/forex-missing-zone.png", "1db5531c73553f1784338394632603e2ea1f4a9cf3ef85dee79ab917619c76ce"],
  ["tests/fixtures/trade-screenshots/futures-mismatch.png", "edf0858380d1cbd99b285624a6f48cb4abbae0e5a16990ec4a1a10112decb6b9"]
]);
const failures = new Map();
function scanText(label, source) {
  if (homePath.test(source)) failures.set(label, "个人绝对路径");
  else if (secret.test(source)) failures.set(label, "密钥格式");
  else if (terms.some(term => label.includes(term) || source.includes(term))) failures.set(label, "命中敏感词");
}

function scan(path, blob) {
  if (forbidden.test(path)) { failures.set(path,"禁止文件"); return; }
  if (blob.includes(0) || /\.png$/i.test(path)) {
    if (reviewedImages.get(path) !== createHash("sha256").update(blob).digest("hex")) {
      failures.set(path, "未经批准的二进制文件");
    }
    return;
  }
  scanText(path, blob.toString("utf8"));
}
if (mode === "--history") {
  if (git("rev-parse", "--is-shallow-repository").toString("utf8").trim() === "true") {
    throw Error("历史检查需要完整 Git 历史");
  }
  const scanned = new Map();
  for (const revision of git("rev-list", "--all").toString("utf8").trim().split("\n").filter(Boolean)) {
    const metadata = git("show", "-s", "--no-notes", "--format=format:%an%n%ae%n%cn%n%ce%n%B", revision);
    scanText("commit " + revision, metadata.toString("utf8"));
    for (const entry of paths("ls-tree", "-r", "-z", revision)) {
      const separator = entry.indexOf("\t");
      const [, , hash] = entry.slice(0, separator).split(" ");
      const path = entry.slice(separator + 1);
      if (scanned.get(path)?.has(hash)) continue;
      const hashes = scanned.get(path) ?? new Set();
      hashes.add(hash);
      scanned.set(path, hashes);
      scan(path, git("cat-file", "blob", hash));
    }
  }
  const tags = git("for-each-ref", "--format=%(objecttype) %(objectname) %(refname)", "refs/tags").toString("utf8").trim();
  for (const ref of tags.split("\n").filter(Boolean)) {
    const [kind, hash, name] = ref.split(" ");
    const details = kind === "tag" ? git("cat-file", "tag", hash).toString("utf8") : "";
    scanText("tag " + hash, name + "\n" + details);
  }
} else {
  const selected = mode === "--staged" ? paths("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z") : paths("ls-files", "-z");
  for (const path of selected) {
    if (mode === "--all" && !existsSync(resolve(root, path))) continue;
    scan(path, mode === "--staged" ? git("show", ":" + path) : readFileSync(resolve(root, path)));
  }
}
for (const [path, reason] of failures) console.error(reason + ": " + (terms.some(term => path.includes(term)) ? "(路径已隐藏)" : path));
if (failures.size) process.exitCode = 1;
else console.log("公开边界检查通过" + (terms.length ? "（含本地敏感词）" : "（通用规则）"));
