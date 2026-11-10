import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { preparePluginPackage } from "./prepare-plugin-package.mjs";
import { projectRoot, releaseVersion } from "./release-files.mjs";
import { assert } from "./verify-plugin-package.mjs";

const version = releaseVersion(process.argv.slice(2));
const readProjectFile = (path) => readFile(join(projectRoot, path), "utf8");
const [manifest, pkg, versions] = await Promise.all(
  ["manifest.json", "package.json", "versions.json"].map(async (file) => JSON.parse(await readProjectFile(file)))
);
assert(manifest.version === version && pkg.version === version, "发布版本与插件清单或 package.json 不一致");
assert(versions[version] === manifest.minAppVersion, "versions.json 缺少本版本或最低 Obsidian 版本不一致");

run("typecheck");
run("test");
if (version !== "0.3.0-alpha.1") {
  process.env.LIFEOPS_EVAL_GATE = version;
  run("eval");
  delete process.env.LIFEOPS_EVAL_GATE;
}
run("verify:secrets");

const releaseRoot = join(projectRoot, "dist/release");
await mkdir(releaseRoot, { recursive: true });
const scratch = await mkdtemp(join(releaseRoot, ".build-"));
try {
  const bundle = join(scratch, "main.js");
  run("bundle:production", "--", "--outfile", bundle);
  const result = await preparePluginPackage({
    output: join(releaseRoot, version),
    bundle,
    onStage: async ({ stage }) => {
      const main = await readFile(join(stage, "main.js"), "utf8");
      const pathLiterals = /\/Users\/[^"'\x60\r\n]+/g;
      const migrationPaths = (await readProjectFile("src/settingsMigration.ts")).match(pathLiterals) ?? [];
      for (const path of main.match(pathLiterals) ?? []) {
        const index = migrationPaths.indexOf(path);
        assert(index >= 0, "生产包包含迁移例外之外的个人路径");
        migrationPaths.splice(index, 1);
      }
      assert(!["TEST_VAULT_ONLY.md", "fixtures/test-vault", "TEST_VAULT_INFO.json"].some((marker) => main.includes(marker)),
        "生产包包含测试库数据标记");
    }
  });
  console.log(`发布包已核对 · ${result.packageDir} · ${result.files} 个文件`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}

function run(...args) {
  const result = spawnSync("npm", ["run", ...args], { cwd: projectRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  assert(result.status === 0, `${args[0]} 未通过，发布准备已停止`);
}
