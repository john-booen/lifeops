import { copyFile, cp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const fixtureRoot = join(root, "fixtures", "test-vault");
const testVault = join(root, "test-vault");
const pluginDir = join(testVault, ".obsidian", "plugins", "lifeops-assistant");

assertSafeTestVaultTarget(root, testVault);
await assertTestVaultRebuildAllowed(testVault);

await rm(testVault, { recursive: true, force: true });
await cp(fixtureRoot, testVault, { recursive: true, errorOnExist: false });
await mkdir(pluginDir, { recursive: true });

const pluginArtifacts = {};
for (const file of ["main.js", "manifest.json", "styles.css"]) {
  const source = join(root, file);
  const destination = join(pluginDir, file);
  await copyFile(source, destination);
  pluginArtifacts[file] = await sha256(source);
}

const codeBaseline = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
  cwd: root,
  encoding: "utf8"
}).trim();
await writeFile(join(testVault, "TEST_VAULT_INFO.json"), `${JSON.stringify({
  fixtureVersion: "lifeops-0.2-env-01-v1",
  codeBaseline,
  sourceFixture: relative(root, fixtureRoot),
  pluginArtifacts
}, null, 2)}\n`, "utf8");

console.log(`Rebuilt isolated Test Vault: ${testVault}`);
console.log(`Code baseline: ${codeBaseline}`);

function assertSafeTestVaultTarget(workspaceRoot, target) {
  const expected = resolve(workspaceRoot, "test-vault");
  if (resolve(target) !== expected) {
    throw new Error(`Refusing unexpected Test Vault target: ${target}`);
  }
  if (!target.startsWith(`${resolve(workspaceRoot)}${sep}`) || target === resolve(workspaceRoot)) {
    throw new Error(`Refusing target outside workspace: ${target}`);
  }
}

async function assertTestVaultRebuildAllowed(target) {
  const marker = join(target, ".lifeops-preserve-user-records");
  try {
    // lstat also protects directories and dangling symbolic links used as markers.
    await lstat(marker);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw new Error("Refusing to rebuild Test Vault: user-record protection could not be checked.", { cause: error });
  }
  throw new Error(`Refusing to rebuild Test Vault: ${marker} protects existing user records.`);
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
