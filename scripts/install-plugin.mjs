import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {LICENSE_PATHS,readTrustedResources,readSourceFile,sha256} from "./verify-plugin-package.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const targetArg = readTargetArgument(process.argv.slice(2));
const vault = resolve(process.cwd(), targetArg);
const expectedTestVault = resolve(root, "test-vault");

if (vault !== expectedTestVault) {
  throw new Error(`Refusing non-project Test Vault target: ${vault}`);
}

const markerPath = join(vault, "TEST_VAULT_ONLY.md");
const marker = await readFile(markerPath, "utf8").catch(() => "");
if (!marker.includes("LifeOps 0.2 Test Vault")) {
  throw new Error(`Refusing unmarked Test Vault target: ${vault}`);
}
if (!(await lstat(join(vault, ".obsidian"))).isDirectory()) {
  throw new Error(`Missing .obsidian directory in Test Vault: ${vault}`);
}

const pluginDir = join(vault, ".obsidian", "plugins", "lifeops-assistant");
const trusted=await readTrustedResources(root,true);
const licenses=[];
for(const path of LICENSE_PATHS){
  const resource=trusted.manifest.files.find(file=>file.path===path),bytes=await readSourceFile(root,resource.source);
  if(bytes.length!==resource.sizeBytes||sha256(bytes)!==resource.sha256)throw Error("License source differs from its reviewed pin");
  for(const parent of[vault,join(vault,".obsidian"),join(vault,".obsidian/plugins"),pluginDir,dirname(join(pluginDir,path))]){
    try{const stat=await lstat(parent);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error("License target parent must be a regular directory");}
    catch(error){if(error.code!=="ENOENT")throw error;}
  }
  let exists=false;
  try{const target=join(pluginDir,path),stat=await lstat(target);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||![0o600,0o644].includes(stat.mode&0o777)||sha256(await readSourceFile(pluginDir,path))!==resource.sha256)throw Error("Different license file exists; use a backed-up reviewed package upgrade");exists=true;}
  catch(error){if(error.code!=="ENOENT")throw error;}
  licenses.push({path,bytes,exists});
}
await mkdir(pluginDir, { recursive: true });

for (const file of ["main.js", "manifest.json", "styles.css"]) {
  await copyFile(join(root, file), join(pluginDir, file));
}

for(const license of licenses)if(!license.exists)await writeFile(join(pluginDir,license.path),license.bytes,{flag:"wx",mode:0o600});

console.log(`Installed LifeOps plugin artifacts into isolated Test Vault: ${pluginDir}`);
console.log("Obsidian app settings and enabled-plugin settings were not modified.");

function readTargetArgument(args) {
  const targetIndex = args.indexOf("--target");
  const value = targetIndex >= 0 ? args[targetIndex + 1]?.trim() : "";
  if (!value) {
    throw new Error("Explicit --target is required. Use: npm run install:test-vault");
  }
  return value;
}
