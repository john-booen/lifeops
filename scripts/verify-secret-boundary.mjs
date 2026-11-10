import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skippedDirectories = new Set([".git", "node_modules", "dist", "test-vault", "output", ".playwright-cli", ".lifeops-test-backups", "coverage"]);
const textExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".css", ".html", ".yml", ".yaml", ".toml", ".txt", ".sh"]);
const secretPatterns = [
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "OpenAI-style secret", pattern: /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/ },
  { name: "Aliyun AccessKey", pattern: /(?:^|[^A-Za-z0-9])LTAI[A-Za-z0-9]{16,}/ },
  { name: "literal bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]{24,}/ }
];

const files = await collectTextFiles(root);
const findings = [];
for (const path of files) {
  const content = await readFile(path, "utf8");
  for (const check of secretPatterns) {
    if (check.pattern.test(content)) findings.push(`${relative(root, path)}: ${check.name}`);
  }
}

if (findings.length > 0) {
  throw new Error(`Potential credential material found:\n${findings.join("\n")}`);
}

console.log(`Verified credential boundary across ${files.length} workspace text files`);
console.log("No private keys, real-looking Provider tokens, or literal bearer credentials found");

async function collectTextFiles(folder) {
  const output = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const path = resolve(folder, entry.name);
    if (entry.isDirectory()) output.push(...await collectTextFiles(path));
    else if (entry.isFile() && textExtensions.has(extname(entry.name).toLowerCase())) output.push(path);
  }
  return output.sort();
}
