import { createHash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { lstat, readFile, readdir, unlink, writeFile } from "node:fs/promises";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const testVault = resolve(root, "test-vault");
const pluginDir = join(testVault, ".obsidian", "plugins", "lifeops-assistant");
const requiredFiles = [
  "TEST_VAULT_ONLY.md",
  "TEST_VAULT_INFO.json",
  ".obsidian/app.json",
  ".obsidian/community-plugins.json",
  ".obsidian/plugins/lifeops-assistant/data.json",
  ".obsidian/plugins/lifeops-assistant/main.js",
  ".obsidian/plugins/lifeops-assistant/manifest.json",
  ".obsidian/plugins/lifeops-assistant/styles.css",
  "LifeOps/Goals/Tasks/LifeOps任务库.json",
  "LifeOps/Goals/Tasks/任务看板.md",
  "LifeOps/Goals/Habits/LifeOps打卡库.json",
  "LifeOps/Journal/2026/08/2026-08-23早.md",
  "LifeOps/Knowledge/Ideas/测试知识.md",
  "LifeOps/Output/AI/Memory/personal-memory.json"
];

assert(testVault === resolve(root, "test-vault"), "Test Vault target is not the workspace test-vault directory");
assert(testVault.startsWith(`${root}${sep}`), "Test Vault escaped the workspace");

for (const relativePath of requiredFiles) {
  const path = join(testVault, relativePath);
  assert((await lstat(path)).isFile(), `Missing required fixture: ${relativePath}`);
}

const allPaths = await collectPaths(testVault);
assert(allPaths.every((entry) => !entry.stat.isSymbolicLink()), "Test Vault must not contain symbolic links");

const appConfig = await readJson(join(testVault, ".obsidian", "app.json"));
assert(appConfig.promptDelete === true, "Test Vault must keep Obsidian delete confirmation enabled");

const enabledPlugins = await readJson(join(testVault, ".obsidian", "community-plugins.json"));
assert(Array.isArray(enabledPlugins) && enabledPlugins.includes("lifeops-assistant"), "LifeOps plugin is not enabled in Test Vault");

const settings = await readJson(join(pluginDir, "data.json"));
assert(settings.ai?.provider === "off" && settings.ai?.apiKey === "", "Text Provider must be off with no key");
assert(settings.embedding?.provider === "off" && settings.embedding?.apiKey === "", "Embedding Provider must be off with no key");
assert(settings.voice?.provider === "off" && settings.voice?.apiKey === "", "Voice Provider must be off with no key");
assert(settings.realtimeVoice?.provider === "off" && settings.realtimeVoice?.apiKey === "", "Realtime voice must be off with no key");
assert(settings.vision?.provider === "off", "Vision Provider must be off");
assert(settings.vision?.cameraEnabled === false && settings.vision?.cameraMode === "off", "Camera must be off");
assert(settings.vision?.screenEnabled === false, "Background screen capture must be off");
assert(settings.proactive?.enabled === false, "Proactive runtime must be off");
assert(settings.gateway?.sharedSecret === "", "Test fixture must not contain a Gateway secret");

const info = await readJson(join(testVault, "TEST_VAULT_INFO.json"));
for (const file of ["main.js", "manifest.json", "styles.css"]) {
  const sourceHash = await sha256(join(root, file));
  const installedHash = await sha256(join(pluginDir, file));
  assert(sourceHash === installedHash, `${file} in Test Vault is not the current workspace artifact`);
  assert(info.pluginArtifacts?.[file] === sourceHash, `${file} hash is missing from TEST_VAULT_INFO.json`);
}

for (const entry of allPaths.filter(({ stat }) => stat.isFile())) {
  if (!/\.(?:md|json|txt)$/i.test(entry.path)) continue;
  const content = await readFile(entry.path, "utf8");
  assert(!content.includes("/Obsidian Vault"), `Formal Vault path found in ${entry.path}`);
  // A key prefix must not be the trailing "sk-" inside an ordinary "task-" ID.
  assert(!/(?:(?<![A-Za-z0-9])sk-|Bearer\s+)[A-Za-z0-9_-]{16,}/.test(content), `Possible API key found in ${entry.path}`);
}

const writeProbe = join(testVault, ".env-01-write-probe");
await writeFile(writeProbe, "test-vault-only\n", "utf8");
assert((await readFile(writeProbe, "utf8")) === "test-vault-only\n", "Test Vault write probe failed");
await unlink(writeProbe);

console.log(`Verified isolated Test Vault: ${testVault}`);
console.log(`Required fixtures: ${requiredFiles.length}`);
console.log("Providers, camera, screen, embedding, voice, proactive runtime: OFF");
console.log("Plugin artifacts match current workspace files");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function collectPaths(folder) {
  const entries = [];
  for (const name of await readdir(folder)) {
    const path = join(folder, name);
    const stat = await lstat(path);
    entries.push({ path, stat });
    if (stat.isDirectory()) entries.push(...await collectPaths(path));
  }
  return entries;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
