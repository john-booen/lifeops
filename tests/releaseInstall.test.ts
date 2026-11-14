import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
// @ts-expect-error Release-only JavaScript is verified against isolated filesystem fixtures.
import { installPackage, restorePackage, waitForHeartbeat } from "../scripts/release-files.mjs";
// @ts-expect-error Release-only JavaScript is verified against isolated filesystem fixtures.
import { preparePluginPackage } from "../scripts/prepare-plugin-package.mjs";

let root: string;
let config: { vaultPath: string; pluginPath: string; backupRoot: string };
let version: string;
const packageBytes = "synthetic program";
const oldProgram = "synthetic old program";
const settings = '{"folders":{"aiReports":"自定义输出/AI"},"synthetic":true}';
const recoveryPath = "自定义输出/AI/Operations/write-recovery.json";
const vaultFile = (path: string) => join(config.vaultPath, path);
const pluginFile = (path: string) => join(config.pluginPath, path);
const read = (path: string) => readFile(path, "utf8");
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

async function put(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "lifeops-release-"));
  const vaultPath = join(root, "synthetic-vault");
  config = { vaultPath, pluginPath: join(vaultPath, ".obsidian/plugins/lifeops-assistant"), backupRoot: join(root, "backups") };
  version = JSON.parse(await read("manifest.json")).version;
  await put(pluginFile("main.js"), oldProgram);
  await put(pluginFile("manifest.json"), '{"id":"lifeops-assistant","version":"0.2.0"}');
  await put(pluginFile("styles.css"), ".old {}");
  await put(pluginFile("data.json"), settings);
  await put(pluginFile("mediapipe/face_landmarker.task"), "old reviewed resource");
  await put(pluginFile("mediapipe/local.txt"), "keep unrelated file");
  await mkdir(pluginFile("empty-folder"));
  await put(vaultFile("日记/用户笔记.md"), "synthetic diary");
  await put(vaultFile("任务/LifeOps任务库.json"), '{"tasks":[]}');
  await put(vaultFile("任务/任务看板.md"), "# 原任务看板\n");
  await put(vaultFile("LifeOps/Output/AI/日报.md"), "synthetic generated report");
  await put(vaultFile("自定义输出/AI/日报.md"), "synthetic generated report at configured path");
});

afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });

async function prepare() {
  const output = join(root, "package");
  const bundle = join(root, "synthetic-main.js");
  await put(bundle, packageBytes);
  await preparePluginPackage({ output, bundle });
  return output;
}

it("verifies backup, installs the package, and restores program files while preserving later data", async () => {
  const installed = await installPackage(config, version, await prepare());
  const backup = join(installed.backup, "vault");
  expect(await read(pluginFile("main.js"))).toBe(packageBytes);
  expect(installed.mainSha256).toBe(hash(packageBytes));
  expect(await read(pluginFile("data.json"))).toBe(settings);
  expect(await read(pluginFile("mediapipe/local.txt"))).toBe("keep unrelated file");
  await expect(lstat(pluginFile("mediapipe/face_landmarker.task"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await read(join(backup, "任务/LifeOps任务库.json"))).toBe('{"tasks":[]}');
  expect(await read(join(backup, "任务/任务看板.md"))).toBe("# 原任务看板\n");
  expect(await read(join(backup, "LifeOps/Output/AI/日报.md"))).toBe("synthetic generated report");
  expect(await read(join(backup, "自定义输出/AI/日报.md"))).toBe("synthetic generated report at configured path");
  await expect(lstat(join(backup, "日记/用户笔记.md"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await read(join(backup, ".obsidian/plugins/lifeops-assistant/data.json"))).toBe(settings);

  await put(pluginFile("data.json"), '{"synthetic":"settings saved after upgrade"}');
  await put(vaultFile("任务/LifeOps任务库.json"), '{"tasks":["synthetic new task"]}');
  await put(vaultFile("日记/用户笔记.md"), "synthetic later entry");
  const restored = await restorePackage(config, installed.backup);
  expect(restored).toMatchObject({ version: "0.2.0", mainSha256: hash(oldProgram), legacy: false });
  expect(await read(pluginFile("main.js"))).toBe(oldProgram);
  expect(await read(pluginFile("mediapipe/face_landmarker.task"))).toBe("old reviewed resource");
  expect((await lstat(pluginFile("empty-folder"))).isDirectory()).toBe(true);
  expect(await read(pluginFile("data.json"))).toBe('{"synthetic":"settings saved after upgrade"}');
  expect(await read(vaultFile("任务/LifeOps任务库.json"))).toBe('{"tasks":["synthetic new task"]}');
  expect(await read(vaultFile("日记/用户笔记.md"))).toBe("synthetic later entry");
});

it("aborts rollback before changing the plugin if any backed-up file is damaged", async () => {
  const installed = await installPackage(config, version, await prepare());
  await put(join(installed.backup, "vault/LifeOps/Output/AI/日报.md"), "corrupted");
  await expect(restorePackage(config, installed.backup)).rejects.toThrow("备份清单");
  expect(await read(pluginFile("main.js"))).toBe(packageBytes);
});

it("keeps the current program and the recovery journal when a save is pending", async () => {
  const output = await prepare();
  const pending = JSON.stringify({ version: 1, operationId: "fictional-save", status: "pending", entries: [] });
  const journal = vaultFile(recoveryPath);
  await put(journal, pending);
  await expect(installPackage(config, version, output)).rejects.toThrow("检查并恢复未完成操作");
  expect(await read(pluginFile("main.js"))).toBe(oldProgram);
  expect(await read(journal)).toBe(pending);
  await expect(lstat(config.backupRoot)).rejects.toMatchObject({ code: "ENOENT" });

  const committed = pending.replace('"pending"', '"committed"');
  await put(journal, committed);
  const installed = await installPackage(config, version, output);
  await put(journal, pending);
  await expect(restorePackage(config, installed.backup)).rejects.toThrow("检查并恢复未完成操作");
  expect(await read(pluginFile("main.js"))).toBe(packageBytes);
  expect(await read(journal)).toBe(pending);
  const restored = pending.replace('"pending"', '"rolled_back"');
  await put(journal, restored);
  await restorePackage(config, installed.backup);
  expect(await read(pluginFile("main.js"))).toBe(oldProgram);
  expect(await read(journal)).toBe(restored);
});

it("leaves an unreadable recovery journal and the installed package intact", async () => {
  const installed = await installPackage(config, version, await prepare());
  const malformed = JSON.stringify({ version: 2, operationId: "fictional-save", status: "committed", entries: [] });
  await put(vaultFile(recoveryPath), malformed);
  await expect(restorePackage(config, installed.backup)).rejects.toThrow("检查并恢复未完成操作");
  expect(await read(pluginFile("main.js"))).toBe(packageBytes);
  expect(await read(vaultFile(recoveryPath))).toBe(malformed);
});

it("preserves both verified backups when an installation retries in the same minute", async () => {
  const output = await prepare();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-14T18:30:00+08:00"));
  const first = await installPackage(config, version, output);
  await restorePackage(config, first.backup);
  const retry = await installPackage(config, version, output);
  expect(retry.backup).toBe(first.backup + "-1");
  for (const backup of [first.backup, retry.backup]) {
    expect(await read(join(backup, "vault/.obsidian/plugins/lifeops-assistant/main.js"))).toBe(oldProgram);
    expect(await read(join(backup, "manifest.txt"))).toContain(hash(oldProgram));
  }
});

it("leaves the old program in place when the new package is damaged", async () => {
  const output = await prepare();
  await put(join(output, "main.js"), "unexpected bytes");
  await expect(installPackage(config, version, output)).rejects.toThrow("Checksum mismatch");
  expect(await read(pluginFile("main.js"))).toBe(oldProgram);
  await expect(lstat(config.backupRoot)).rejects.toMatchObject({ code: "ENOENT" });
});

it("requires a fresh, successful heartbeat and checks the actual program again", async () => {
  const installed = await installPackage(config, version, await prepare());
  const path = vaultFile("LifeOps/Output/AI/System/heartbeat.json");
  const marker = { version, mainSha256: installed.mainSha256, loadedAt: new Date().toISOString(), ok: true, errors: [] as unknown[] };
  await put(path, JSON.stringify({ ...marker, loadedAt: "2000-01-01T00:00:00Z" }));
  await expect(waitForHeartbeat(config, installed, 10)).rejects.toThrow("未等到");
  await put(path, JSON.stringify({ ...marker, mainSha256: hash(oldProgram) }));
  await expect(waitForHeartbeat(config, installed, 10)).rejects.toThrow("未等到");
  await put(path, JSON.stringify({ ...marker, ok: false, errors: [{ type: "data" }] }));
  await expect(waitForHeartbeat(config, installed, 50)).rejects.toThrow("加载心跳报告错误");
  await put(path, JSON.stringify(marker));
  await expect(waitForHeartbeat(config, installed, 50)).resolves.toBeUndefined();
  await put(pluginFile("main.js"), "changed after startup");
  await expect(waitForHeartbeat(config, installed, 50)).rejects.toThrow("磁盘上的程序不一致");
});
