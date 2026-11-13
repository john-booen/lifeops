import { lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, PACKAGE_FILES, RESOURCE_MANIFEST, readRegularFile, readSourceFile, readTrustedResources, sha256, verifyPluginPackage } from "./verify-plugin-package.mjs";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function absent(path) {
  try { await lstat(path); throw new Error("Package output already exists; choose a new --output directory"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
export async function preparePluginPackage({ root = sourceRoot, output = join(root, "dist", "lifeops-assistant"), bundle, onStage } = {}) {
  const target = resolve(output);
  await absent(target);
  const trusted = await readTrustedResources(root, true);
  const contents = new Map();
  for (const name of ["manifest.json", "styles.css"]) contents.set(name, await readSourceFile(root, name));
  contents.set("main.js", bundle ? await readRegularFile(resolve(bundle)) : await readSourceFile(root, "main.js"));
  for (const resource of trusted.manifest.files) {
    const bytes = await readSourceFile(root, resource.source);
    assert(bytes.length === resource.sizeBytes && sha256(bytes) === resource.sha256, `Source resource hash differs from reviewed manifest: ${resource.path}`);
    contents.set(resource.path, bytes);
  }
  contents.set(RESOURCE_MANIFEST, trusted.bytes);
  await mkdir(dirname(target), { recursive: true });
  assert(!(await lstat(dirname(target))).isSymbolicLink(), "Package output parent must not be a symbolic link");
  const lockPath = `${target}.prepare.lock`;
  const lock = await open(lockPath, "wx", 0o600);
  let stage;
  try {
    await absent(target);
    stage = await mkdtemp(`${target}.stage-`);
    for (const [name, bytes] of contents) {
      await mkdir(dirname(join(stage, name)), { recursive: true });
      await writeFile(join(stage, name), bytes, { flag: "wx" });
    }
    await writeFile(join(stage, "SHA256SUMS.txt"), `${PACKAGE_FILES.map(name => `${sha256(contents.get(name))}  ${name}`).join("\n")}\n`, { flag: "wx" });
    await onStage?.({ stage, output: target });
    const result = await verifyPluginPackage({ root, packageDir: stage });
    await absent(target);
    await rename(stage, target);
    stage = undefined;
    return { ...result, packageDir: target };
  } finally {
    // Only this invocation's unpublished staging directory and lock are removed.
    if (stage) await rm(stage, { recursive: true, force: true });
    await lock.close(); await rm(lockPath);
  }
}
export function prepareOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index] === "--output" ? "output" : args[index] === "--bundle" ? "bundle" : "";
    assert(key && !options[key] && args[index + 1] && !args[index + 1].startsWith("--"), "Usage: [--output NEW_DIRECTORY] [--bundle MAIN_JS_FILE]");
    options[key] = resolve(args[index + 1]);
  }
  return options;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await preparePluginPackage(prepareOptions(process.argv.slice(2)));
  console.log(`Prepared verified local plugin package: ${result.packageDir}`);
  console.log(`Packaged runtime/checksum files: ${result.files}; bytes: ${result.bytes}`);
  console.log("Local package prepared. Nothing was published.");
}
