import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error Release-only JavaScript is verified by process and filesystem tests.
import { PACKAGE_FILES, RESOURCE_MANIFEST, verifyPluginPackage } from "../scripts/verify-plugin-package.mjs";
// @ts-expect-error Release-only JavaScript is verified by process and filesystem tests.
import { preparePluginPackage } from "../scripts/prepare-plugin-package.mjs";

let root: string, output: string;
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const manifest = { id: "lifeops-assistant", version: "0.1.0", isDesktopOnly: true };
async function put(path: string, bytes: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); }
async function updateChecksums() {
  const rows = await Promise.all((PACKAGE_FILES as string[]).map(async name => `${sha(await readFile(join(output, name)))}  ${name}`));
  await writeFile(join(output, "SHA256SUMS.txt"), `${rows.join("\n")}\n`);
}
async function verify() { return verifyPluginPackage({ root, packageDir: output }); }
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "lifeops-package-boundary-"))); output = join(root, "candidates/one");
  await put(join(root, "main.js"), 'const title="中文任务说明"; const task="TASK-20260928-01";');
  await put(join(root, "manifest.json"), JSON.stringify(manifest)); await put(join(root, "styles.css"), ".synthetic {}\n");
  const trusted = JSON.parse(await readFile("scripts/plugin-package-resources.json", "utf8"));
  for (const resource of trusted.files) {
    const bytes = `Synthetic runtime asset: ${resource.path}\n`;
    resource.sizeBytes = Buffer.byteLength(bytes); resource.sha256 = sha(bytes);
    await put(join(root, resource.source), bytes);
  }
  await put(join(root, "scripts/plugin-package-resources.json"), `${JSON.stringify(trusted, null, 2)}\n`);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("production package boundaries without a build or installation", () => {
  it("prepares and verifies only reviewed files, preserving ordinary Chinese and task IDs", async () => {
    const result = await preparePluginPackage({ root, output });
    expect(result.files).toBe(6); expect((await verify()).files).toBe(6);
    expect((await readdir(dirname(output))).sort()).toEqual(["one"]);
  });
  it("produces identical manifests and bytes from the same frozen inputs in two separate directories", async () => {
    const second = join(root, "candidates/two"); await preparePluginPackage({ root, output }); await preparePluginPackage({ root, output: second });
    for (const name of [...PACKAGE_FILES, "SHA256SUMS.txt"] as string[]) expect(await readFile(join(output, name))).toEqual(await readFile(join(second, name)));
  });
  it("keeps the final directory absent until a complete verified package is published", async () => {
    await preparePluginPackage({ root, output, onStage: async ({ stage }: { stage: string }) => {
      await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" }); expect((await readdir(stage)).length).toBeGreaterThan(0);
    } });
    expect((await verify()).files).toBe(6);
  });
  it.each(["inline map", "external map", "embedded sources", "token", "bearer", "private key", "Aliyun"])("rejects %s even with freshly recomputed package checksums", async kind => {
    await preparePluginPackage({ root, output });
    const bad: Record<string, string> = {
      "inline map": "//# sourceMappingURL=data:application/json;base64,e30=", "external map": "//# sourceMappingURL=main.js.map",
      "embedded sources": '{"sourcesContent":["synthetic only"]}', token: "sk-" + "Z".repeat(28), bearer: "Bearer " + "A".repeat(30),
      "private key": "-----BEGIN " + "PRIVATE KEY-----", Aliyun: "LTAI" + "B".repeat(20)
    };
    await writeFile(join(output, "main.js"), bad[kind]); await updateChecksums();
    const error = await verify().catch((value: Error) => value);
    expect(error).toBeInstanceOf(Error); expect(error.message).not.toContain(bad[kind]);
    expect(error.message).toMatch(/sourcemap|Credential-like/);
  });
  it("rejects a mobile-enabled manifest", async () => {
    await preparePluginPackage({ root, output }); await writeFile(join(output, "manifest.json"), JSON.stringify({ ...manifest, isDesktopOnly: false })); await updateChecksums();
    await expect(verify()).rejects.toThrow("desktop-only");
  });
  it.each(["openVideoAnalysis", "analyzeVideoSamples", "selected_video_samples", "lifeops-video-samples", "选择片段并预览"])("rejects the cancelled %s path even with valid checksums", async marker => {
    await preparePluginPackage({ root, output });
    await writeFile(join(output, "main.js"), `const cancelled = ${JSON.stringify(marker)};`);
    await updateChecksums();
    await expect(verify()).rejects.toThrow(/Cancelled file-video/);
  });
  it("rejects cancelled video styles even with valid checksums", async () => {
    await preparePluginPackage({ root, output });
    await writeFile(join(output, "styles.css"), ".lifeops-video-samples { display: grid; }");
    await updateChecksums();
    await expect(verify()).rejects.toThrow(/Cancelled file-video/);
  });
  it.each(["file", "directory", "symlink", "directory symlink", "fifo"])("rejects an unexpected %s in the package", async kind => {
    await preparePluginPackage({ root, output }); const path = join(output, "unexpected");
    if (kind === "file") await writeFile(path, "synthetic");
    if (kind === "directory") await mkdir(path);
    if (kind === "symlink") await symlink(join(root, "main.js"), path);
    if (kind === "directory symlink") await symlink(join(root, "scripts"), path);
    if (kind === "fifo") expect(spawnSync("mkfifo", [path]).status).toBe(0);
    await expect(verify()).rejects.toThrow(/Unexpected|Symbolic link|Non-regular/);
  });
  it.each(["resource manifest"])("rejects replaced %s despite recomputed checksums", async kind => {
    await preparePluginPackage({ root, output });
    await writeFile(join(output, RESOURCE_MANIFEST), "synthetic replacement"); await updateChecksums();
    await expect(verify()).rejects.toThrow(/Resource hash|resource manifest/);
  });
  it.each(["LICENSE"])("keeps %s mandatory and pinned after checksums are recomputed", async name => {
    await preparePluginPackage({ root, output });
    expect(await readFile(join(output, name))).toEqual(await readFile(join(root, name === "LICENSE" ? name : `assets/${name}`)));
    await writeFile(join(output, name), "replacement license text"); await updateChecksums();
    await expect(verify()).rejects.toThrow(/Resource hash/);
    await rm(join(output, name));
    await expect(verify()).rejects.toThrow(/Missing package file/);
  });
  it.each(["install", "LICENSE"])("installs the plugin license or refuses an existing different %s before program writes", async kind => {
    for (const name of ["install-plugin.mjs", "verify-plugin-package.mjs"]) await copyFile(join("scripts", name), join(root, "scripts", name));
    try { await copyFile("scripts/native-work-window-resource.mjs", join(root, "scripts/native-work-window-resource.mjs")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const vault = join(root, "test-vault"), plugin = join(vault, ".obsidian/plugins/lifeops-assistant");
    await put(join(vault, "TEST_VAULT_ONLY.md"), "LifeOps 0.2 Test Vault");
    await put(join(plugin, "main.js"), "original installed program");
    await put(join(plugin, "data.json"), "fictional settings stay");
    if (kind !== "install") await put(join(plugin, kind), "user-owned different license");
    const result = spawnSync(process.execPath, [join(root, "scripts/install-plugin.mjs"), "--target", vault], { cwd: root, encoding: "utf8" });
    expect(await readFile(join(plugin, "data.json"), "utf8")).toBe("fictional settings stay");
    if (kind === "install") {
      expect(result.stderr).toBe(""); expect(result.status).toBe(0);
      for (const name of ["LICENSE"]) expect(await readFile(join(plugin, name))).toEqual(await readFile(join(root, name === "LICENSE" ? name : `assets/${name}`)));
    } else {
      expect(result.status).not.toBe(0); expect(result.stderr).toContain("Different license file exists");
      expect(await readFile(join(plugin, "main.js"), "utf8")).toBe("original installed program");
      expect(await readFile(join(plugin, kind), "utf8")).toBe("user-owned different license");
    }
    await expect(lstat(join(vault, ".obsidian/app.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(vault, ".obsidian/community-plugins.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects duplicate checksum lines", async () => {
    await preparePluginPackage({ root, output }); const sums = await readFile(join(output, "SHA256SUMS.txt"), "utf8");
    await writeFile(join(output, "SHA256SUMS.txt"), sums + sums.split("\n")[0] + "\n"); await expect(verify()).rejects.toThrow("Duplicate");
  });
  it("does not replace or delete any existing output", async () => {
    await mkdir(output, { recursive: true }); await writeFile(join(output, "keep.txt"), "existing candidate");
    await expect(preparePluginPackage({ root, output })).rejects.toThrow("already exists"); expect(await readFile(join(output, "keep.txt"), "utf8")).toBe("existing candidate");
  });
  it("rejects concurrent preparation for the same destination", async () => {
    let ready!: () => void, release!: () => void; const started = new Promise<void>(resolve => { ready = resolve; }); const wait = new Promise<void>(resolve => { release = resolve; });
    const first = preparePluginPackage({ root, output, onStage: async () => { ready(); await wait; } }); await started;
    try { await expect(preparePluginPackage({ root, output })).rejects.toMatchObject({ code: "EEXIST" }); } finally { release(); }
    await first; expect((await verify()).files).toBe(6);
  });
  it("rejects a destination created during staging without deleting its contents", async () => {
    await expect(preparePluginPackage({ root, output, onStage: async () => { await mkdir(output); await writeFile(join(output, "keep.txt"), "other writer"); } })).rejects.toThrow("already exists");
    expect(await readFile(join(output, "keep.txt"), "utf8")).toBe("other writer"); expect(await readdir(dirname(output))).toEqual(["one"]);
  });
  it("does not publish when staged files are changed before final validation", async () => {
    await expect(preparePluginPackage({ root, output, onStage: async ({ stage }: { stage: string }) => { await writeFile(join(stage, "main.js"), "changed"); } })).rejects.toThrow("Checksum mismatch");
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" }); expect(await readdir(dirname(output))).toEqual([]);
  });
  it.each(["license", "source symlink"])("rejects unreviewed %s before publishing", async kind => {
    if (kind === "license") await writeFile(join(root, "LICENSE"), "tampered license");
    if (kind === "source symlink") { await rm(join(root, "main.js")); await symlink(join(root, "styles.css"), join(root, "main.js")); }
    await expect(preparePluginPackage({ root, output })).rejects.toThrow(/hash|version|Symbolic link/); await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("supports an explicit CLI output and verifier target without writing default dist", async () => {
    for (const name of ["prepare-plugin-package.mjs", "verify-plugin-package.mjs"]) await copyFile(join("scripts", name), join(root, "scripts", name));
    const prepared = spawnSync(process.execPath, [join(root, "scripts/prepare-plugin-package.mjs"), "--output", output], { cwd: root, encoding: "utf8" });
    expect(prepared.stderr).toBe(""); expect(prepared.status).toBe(0);
    const verified = spawnSync(process.execPath, [join(root, "scripts/verify-plugin-package.mjs"), "--package", output], { cwd: root, encoding: "utf8" });
    expect(verified.status).toBe(0); await expect(lstat(join(root, "dist"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("packages an explicit isolated bundle without reading or overwriting the development bundle", async () => {
    const bundle = join(root, "isolated-production.js"); await writeFile(bundle, "const isolatedProduction = true;");
    await writeFile(join(root, "main.js"), "//# sourceMappingURL=development-only.map");
    await preparePluginPackage({ root, output, bundle });
    expect(await readFile(join(output, "main.js"), "utf8")).toBe("const isolatedProduction = true;");
    expect(await readFile(join(root, "main.js"), "utf8")).toContain("development-only.map");
  });
  it("keeps development bundling separate from the production release command", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    expect(pkg.scripts["bundle:production"]).toBe("node esbuild.config.mjs production"); expect(pkg.scripts.bundle).toBe("node esbuild.config.mjs");
    expect(pkg.scripts["release:prepare"]).toContain("bundle:production"); expect(pkg.scripts["release:prepare"]).not.toContain("install");
  });
});
