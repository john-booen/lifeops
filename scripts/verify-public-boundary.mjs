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
const secret = /(?:-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----|\bsk-(?:proj-)?[a-zA-Z0-9_-]{24,}\b|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[a-zA-Z0-9]{30,}\b|\bgithub_pat_[a-zA-Z0-9_]{30,}\b)/;
const forbidden = /^(?:docs\/(?:archive\/|plan\/|PROGRESS\.md|QUESTIONS_FOR_|CLAUDE)|fixtures\/real-provider\/|output\/|dist\/|test-vault\/|node_modules\/|prototypes\/)|(?:^|\/)(?:release\.config\.json|sensitive-terms\.txt|breeze-paths\.json|\.env(?:\.|$)|[^/]+\.(?:pem|key|log))$/i;
const failures = new Map();
function scan(path, blob) {
  if (forbidden.test(path)) { failures.set(path,"禁止文件"); return; }
  if (blob.includes(0)) {
    const signature = Buffer.from([137,80,78,71,13,10,26,10]);
    if (!/^tests\/fixtures\/trade-screenshots\/[-a-z]+\.png$/.test(path) || !blob.subarray(0,8).equals(signature)) failures.set(path,"未经批准的二进制文件");
    return;
  }
  const source = blob.toString("utf8");
  if (homePath.test(source)) failures.set(path, "个人绝对路径");
  else if (secret.test(source)) failures.set(path, "密钥格式");
  else if (terms.some(term => path.includes(term) || source.includes(term))) failures.set(path, "命中敏感词");
}
if (mode === "--history") {
  for (const revision of git("rev-list", "--all").toString("utf8").trim().split("\n").filter(Boolean)) {
    for (const path of paths("ls-tree", "-r", "--name-only", "-z", revision)) scan(path, git("show", revision + ":" + path));
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
