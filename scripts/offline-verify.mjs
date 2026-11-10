import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const guard = join(root, "scripts", "offline-network-guard.cjs");
const nodeOptions = [process.env.NODE_OPTIONS, `--require=${guard}`].filter(Boolean).join(" ");
const environment = {
  ...process.env,
  LIFEOPS_OFFLINE_VERIFY: "1",
  NODE_OPTIONS: nodeOptions
};

const guardSelfTest = spawnSync(process.execPath, [
  "-e",
  "require('node:net').connect(443, 'example.com')"
], { cwd: root, env: environment, encoding: "utf8" });
if (guardSelfTest.status === 0 || !`${guardSelfTest.stderr}${guardSelfTest.stdout}`.includes("blocked external TCP")) {
  throw new Error("Offline network guard self-test failed");
}

const steps = [
  ["TypeScript", "npm", ["run", "typecheck"]],
  ["Vitest", "npm", ["test"]],
  ["Gateway syntax", process.execPath, ["--check", "gateway/server.mjs"]],
  ["Swift Companion", "npm", ["run", "build:companion"]],
  ["Plugin bundle", "npm", ["run", "bundle"]],
  ["Test Vault rebuild", "npm", ["run", "test-vault:rebuild"]],
  ["Test Vault boundary", "npm", ["run", "verify:build-boundary"]],
  ["Test Vault fixture", "npm", ["run", "test-vault:verify"]],
  ["Package prepare", process.execPath, ["scripts/prepare-plugin-package.mjs"]],
  ["Package verify", "npm", ["run", "verify:package"]],
  ["Credential boundary", "npm", ["run", "verify:secrets"]],
  ["Current docs", "npm", ["run", "verify:docs"]],
  ["Historical docs", "npm", ["run", "verify:history-docs"]]
];

console.log("LifeOps offline verification");
console.log("External TCP/fetch: blocked; local Unix sockets and loopback: allowed");
for (const [name, command, args] of steps) {
  console.log(`\n[${name}]`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: environment,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new Error(`${name} failed with exit code ${result.status ?? "unknown"}`);
  }
}

console.log(`\nLifeOps offline verification passed: ${steps.length}/${steps.length} steps`);
console.log("No real Provider or external network connection was allowed.");
