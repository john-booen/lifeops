import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const installSource = await readFile(join(root, "scripts", "install-plugin.mjs"), "utf8");
const testVault = join(root, "test-vault");
const appConfig = join(testVault, ".obsidian", "app.json");
const enabledPlugins = join(testVault, ".obsidian", "community-plugins.json");

assert(!/install-plugin|install:test-vault|install:vault/.test(packageJson.scripts.build), "build must not install a plugin");
assert(packageJson.scripts.build.includes("typecheck"), "build must run typecheck");
assert(packageJson.scripts.build.includes("test"), "build must run tests");
assert(packageJson.scripts.build.includes("bundle"), "build must create the bundle");
assert(packageJson.scripts["install:test-vault"].includes("--target ./test-vault"), "Test Vault install target must be explicit");
assert(!packageJson.scripts["install:vault"], "Generic Vault install command must not exist");
assert(packageJson.scripts["release:prepare"], "Release preparation command must be separate");

for (const forbidden of [
  "DEFAULT_VAULT",
  "LIFEOPS_VAULT",
  "promptDelete",
  "community-plugins.json",
  "app.json"
]) {
  assert(!installSource.includes(forbidden), `Installer still contains forbidden side effect or fallback: ${forbidden}`);
}

const noTarget = spawnSync(process.execPath, [join(root, "scripts", "install-plugin.mjs")], {
  cwd: root,
  encoding: "utf8"
});
assert(noTarget.status !== 0, "Installer must reject a missing explicit target");

const wrongTarget = spawnSync(process.execPath, [join(root, "scripts", "install-plugin.mjs"), "--target", "."], {
  cwd: root,
  encoding: "utf8"
});
assert(wrongTarget.status !== 0, "Installer must reject a non-Test-Vault target");

const configBefore = await sha256(appConfig);
const pluginsBefore = await sha256(enabledPlugins);
const install = spawnSync(process.execPath, [
  join(root, "scripts", "install-plugin.mjs"),
  "--target",
  "./test-vault"
], { cwd: root, encoding: "utf8" });
assert(install.status === 0, install.stderr || "Explicit Test Vault installation failed");
assert(await sha256(appConfig) === configBefore, "Installer changed Test Vault app.json");
assert(await sha256(enabledPlugins) === pluginsBefore, "Installer changed Test Vault community-plugins.json");

console.log("Verified build/install boundary:");
console.log("- build has no install step");
console.log("- installer requires the project Test Vault explicitly");
console.log("- missing and non-Test-Vault targets are rejected");
console.log("- Obsidian app and enabled-plugin settings remain unchanged");

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
