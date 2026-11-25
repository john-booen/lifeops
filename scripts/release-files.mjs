import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, cp, lstat, mkdir, mkdtemp, open, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { assertSafeDiskPath } from "../src/dataFoundation/offlineRecovery.ts";
import { decodeFactRecovery, MAX_RECOVERY_BYTES } from "../src/dataFoundation/recoveryEncoding.ts";
import { FULL_PLUGIN_FILES } from "./plugin-package-upgrade.mjs";
import { assert, readRegularFile, sha256, verifyPluginPackage } from "./verify-plugin-package.mjs";
import {verifyDailyInstallPolicy} from './daily-install-policy.mjs';

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const pluginRelative = ".obsidian/plugins/lifeops-assistant";
const reportsRelative = "LifeOps/Output/AI";
const heartbeatRelative = reportsRelative + "/System/heartbeat.json";
const legacyMainSha256 = "fd68e2291f18a9f920cec2e84c4544b01d93a091150f4522d5847652d60758dc";
const versionPattern = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/;
const managedMirrors = new Map([["LifeOps任务库.json", "任务看板.md"], ["LifeOps打卡库.json", "打卡看板.md"]]);

export function releaseVersion(args) {
  assert(args.length === 1 && versionPattern.test(args[0]), "请提供一个有效的发布版本");
  return args[0];
}

export async function loadReleaseConfig() {
  const rehearsalConfig = process.env.LIFEOPS_REHEARSAL_CONFIG;
  const configPath = rehearsalConfig || process.env.LIFEOPS_PRIVATE_RELEASE_CONFIG;
  assert(configPath && isAbsolute(configPath), "请显式指定库外私人发布配置的绝对路径");
  assert(!inside(projectRoot, configPath), "私人发布配置不能放在代码仓库中");
  await assertSafeDiskPath(configPath);
  const values = await readJson(configPath);
  for (const key of ["vaultPath", "pluginPath", "backupRoot"]) {
    assert(typeof values[key] === "string" && isAbsolute(values[key]), "发布配置必须包含绝对路径");
    values[key] = resolve(values[key]);
  }
  const { vaultPath, pluginPath, backupRoot } = values;
  assert(pluginPath === join(vaultPath, pluginRelative), "插件路径与配置的库不匹配");
  assert(!inside(vaultPath, backupRoot) && !inside(backupRoot, vaultPath), "备份目录必须与目标库分离");
  await assertSafeDiskPath(vaultPath);
  await assertSafeDiskPath(pluginPath);
  await assertSafeDiskPath(backupRoot);
  assert((await lstat(join(vaultPath, ".obsidian"))).isDirectory(), "目标不是已配置的 Obsidian 库");
  if (rehearsalConfig) {
    const marker = await readRegularFile(join(vaultPath, "TEST_VAULT_ONLY.md"));
    assert(marker.toString("utf8").includes("内容全部为虚构数据"), "隔离演练必须使用全虚构测试库");
  }
  const settingsFile = join(pluginPath, "data.json");
  const reports = (await statIfPresent(settingsFile)) ? (await readJson(settingsFile))?.folders?.aiReports : undefined;
  const heartbeatPath = values.heartbeatPath || (reports ? reports + "/System/heartbeat.json" : heartbeatRelative);
  const rollbackHeartbeatPath = values.rollbackHeartbeatPath || heartbeatPath;
  for (const path of [heartbeatPath, rollbackHeartbeatPath]) {
    assert(typeof path === "string" && !isAbsolute(path) && !path.includes("\\")
      && path.split("/").every(part => part.trim() && !part.startsWith(".")), "心跳路径必须位于目标库内");
  }
  return { vaultPath, pluginPath, backupRoot, heartbeatPath, rollbackHeartbeatPath, dailyInstall: !rehearsalConfig };
}

function inside(parent, child) {
  const path = relative(parent, child);
  return path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path);
}

async function statIfPresent(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function readJson(path) {
  const bytes = await readRegularFile(path);
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("无法读取发布流程所需的 JSON 文件"); }
}

async function walk(root, folder, entries, managedOnly = false) {
  for (const item of await readdir(join(root, folder), { withFileTypes: true })) {
    const path = join(folder, item.name);
    if (managedOnly && (path === ".obsidian" || path === ".git" || entries.has(path))) continue;
    if (item.isDirectory()) {
      if (!managedOnly) entries.set(path, true);
      await walk(root, path, entries, managedOnly);
    } else if (!managedOnly || /^LifeOps.*\.json$/.test(item.name)) {
      assert(item.isFile(), "备份范围内发现链接或非常规文件");
      entries.set(path, false);
      const mirror = managedOnly ? managedMirrors.get(item.name) : undefined;
      if (mirror) {
        const mirrorPath = join(folder, mirror);
        const mirrorStat = await statIfPresent(join(root, mirrorPath));
        if (mirrorStat) {
          assert(mirrorStat.isFile(), "任务或打卡看板不是常规文件");
          entries.set(mirrorPath, false);
        }
      }
    }
  }
}

async function reportFolders(config) {
  const settingsFile = join(config.pluginPath, "data.json");
  const configuredReports = (await statIfPresent(settingsFile)) ? (await readJson(settingsFile))?.folders?.aiReports : undefined;
  const paths = [...new Set([configuredReports || reportsRelative, reportsRelative])];
  for (const path of paths) {
    assert(typeof path === "string" && path.split("/").every((part) => part && part !== "." && part !== "..")
      && !isAbsolute(path) && !path.includes("\\"), "AI 复盘目录必须是库内相对路径");
  }
  return paths;
}

async function settledRecoveryRevision(config, rollback = false) {
  const [folder] = await reportFolders(config);
  const path = join(config.vaultPath, folder, "Operations", "write-recovery.json");
  await assertSafeDiskPath(path);
  const stat = await statIfPresent(path);
  if (!stat) return JSON.stringify([path, null]);
  const message = "恢复记录无法安全核验。请使用当前版本检查并恢复未完成操作，再切换版本。";
  assert(stat.isFile() && stat.nlink === 1 && stat.size <= MAX_RECOVERY_BYTES, message);
  const raw = await readRegularFile(path);
  let document;
  try {
    const text = raw.toString("utf8");
    assert(raw.length <= MAX_RECOVERY_BYTES && Buffer.from(text).equals(raw), message);
    const wire = JSON.parse(text);
    assert(wire && [1, 2, 3].includes(wire.version) && !Object.hasOwn(wire, "schemaVersion")
      && ["committed", "rolled_back"].includes(wire.status)
      && typeof wire.operationId === "string" && wire.operationId && Array.isArray(wire.entries), message);
    assert(wire.version !== 3 || wire.ledgerUndo?.kind === "ledger-revert-v1", message);
    document = decodeFactRecovery(wire);
  } catch { throw new Error(message); }
  if (rollback) {
    // The retained settings define the old reader's permissions. A completed
    // journal is still unreadable if it names a new feature's external path.
    // Refuse before swapping code; never broaden permissions or delete a WAL.
    const settingsFile = join(config.pluginPath, "data.json");
    const settings = await statIfPresent(settingsFile) ? await readJson(settingsFile) : {};
    const roots = Object.values(settings.folders ?? {}).filter(value => typeof value === "string" && value);
    const paths = [...document.entries.map(entry => entry?.path), ...(document.ledgerUndo ? [document.ledgerUndo.path] : [])];
    assert(paths.every(path => typeof path === "string" && !path.includes("\\")
      && !/[\x00-\x1f]/u.test(path) && /\.(?:md|json|jsonl)$/u.test(path)
      && path.split("/").every(part => part && !part.startsWith("."))
      && roots.some(root => path.startsWith(root + "/"))),
    "旧版无法读取当前恢复记录，已保留当前程序和全部资料。请先用当前版本完成恢复记录整理，再回退。");
  }
  return JSON.stringify([path, sha256(raw)]);
}

async function backupEntries(config) {
  const entries = new Map();
  for (const path of [pluginRelative, ...await reportFolders(config)]) {
    const fullPath = join(config.vaultPath, path);
    await assertSafeDiskPath(fullPath);
    const stat = await statIfPresent(fullPath);
    if (!stat && path !== pluginRelative) continue;
    assert(stat?.isDirectory(), "插件或 AI 复盘目录不可读取");
    entries.set(path, true);
    await walk(config.vaultPath, path, entries);
  }
  await walk(config.vaultPath, "", entries, true);
  return entries;
}

async function fileRecord(root, path) {
  const fullPath = join(root, path);
  await assertSafeDiskPath(fullPath);
  const handle = await open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    assert(before.isFile() && before.nlink === 1, "备份范围内发现非常规文件");
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await lstat(fullPath);
    assert(["size", "mtimeMs", "ctimeMs", "ino", "dev"].every((key) => before[key] === after[key]),
      "备份期间文件发生变化，请关闭目标库后重试");
    return { path, size: before.size, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function inventory(root, entries) {
  const directories = [];
  const files = [];
  for (const path of [...entries.keys()].sort()) {
    if (entries.get(path)) directories.push(path);
    else files.push(await fileRecord(root, path));
  }
  return { directories, files };
}

async function readTree(root) {
  await assertSafeDiskPath(root);
  const entries = new Map();
  await walk(root, "", entries);
  return inventory(root, entries);
}

async function verifyBackup(config, directory) {
  await assertSafeDiskPath(directory);
  const manifest = await readJson(join(directory, "manifest.txt"));
  assert(manifest.vaultPath === config.vaultPath, "备份来自另一个库");
  const actual = await readTree(join(directory, "vault"));
  assert(JSON.stringify(actual) === JSON.stringify(manifest.inventory), "备份清单与文件大小或哈希不符");
  assert(actual.directories.includes(pluginRelative), "备份缺少插件目录");
  return actual;
}

function backupStamp(now) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

async function createBackup(config, version) {
  await mkdir(config.backupRoot, { recursive: true, mode: 0o700 });
  const base = join(config.backupRoot, `${version}-${backupStamp(new Date())}`);
  let directory = base;
  for (let retry = 1; ; retry++) {
    try {
      await mkdir(directory, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      directory = `${base}-${retry}`;
    }
  }
  try {
    const root = join(directory, "vault");
    const current = await inventory(config.vaultPath, await backupEntries(config));
    for (const path of current.directories) await mkdir(join(root, path), { recursive: true, mode: 0o700 });
    for (const { path } of current.files) {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(join(config.vaultPath, path), target, constants.COPYFILE_EXCL);
    }
    const snapshot = await readTree(root);
    assert(JSON.stringify(snapshot.files) === JSON.stringify(current.files), "备份副本与原文件哈希不一致");
    await writeFile(join(directory, "manifest.txt"), JSON.stringify({ vaultPath: config.vaultPath, inventory: snapshot }, null, 2),
      { flag: "wx", mode: 0o600, flush: true });
    await verifyBackup(config, directory);
    const latest = await inventory(config.vaultPath, await backupEntries(config));
    assert(JSON.stringify(latest) === JSON.stringify(current), "备份结束时目标库已变化，未安装");
    return { directory, snapshot };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function withReleaseLock(config, action) {
  await assertSafeDiskPath(config.pluginPath);
  const lockPath = join(dirname(config.pluginPath), ".lifeops-release.lock");
  const lock = await open(lockPath, "wx", 0o600);
  try {
    await lock.writeFile(String(process.pid));
    return await action();
  }
  finally { await lock.close(); await rm(lockPath); }
}

async function swapPlugin(pluginPath, prepare) {
  const work = await mkdtemp(join(dirname(pluginPath), ".lifeops-release-"));
  const stage = join(work, "next");
  const before = join(work, "previous");
  let keepWork = false;
  try {
    const result = await prepare(stage);
    const exists = await statIfPresent(pluginPath);
    if (exists) await rename(pluginPath, before);
    try { await rename(stage, pluginPath); }
    catch (error) {
      if (exists) {
        try { await rename(before, pluginPath); }
        catch { keepWork = true; throw new Error("安装目录恢复失败，已保留同目录的临时副本和已校验备份"); }
      }
      throw error;
    }
    return result;
  } finally {
    if (!keepWork) await rm(work, { recursive: true, force: true });
  }
}

async function removeRetiredResources(stage, contents) {
  for (const path of FULL_PLUGIN_FILES) {
    if (!contents.has(path)) await rm(join(stage, path), { force: true });
  }
  for (const path of ["mediapipe/wasm", "mediapipe", "native"]) {
    try { await rmdir(join(stage, path)); }
    catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error; }
  }
}

export async function installPackage(config, version, packageDir = join(projectRoot, "dist/release", version)) {
  const checkPolicy = async () => { if (config.dailyInstall) await verifyDailyInstallPolicy(process.env.LIFEOPS_DAILY_INSTALL_POLICY, version); };
  await checkPolicy();
  const { contents } = await verifyPluginPackage({ packageDir });
  assert(JSON.parse(contents.get("manifest.json").toString("utf8")).version === version, "安装包版本不符");
  const mainSha256 = sha256(contents.get("main.js"));
  return withReleaseLock(config, async () => {
    const recovery = await settledRecoveryRevision(config);
    const { directory: backup, snapshot } = await createBackup(config, version);
    console.log(`备份已读回校验 · ${backup}`);
    await swapPlugin(config.pluginPath, async (stage) => {
      await cp(join(backup, "vault", pluginRelative), stage, { recursive: true, errorOnExist: true, force: false });
      await removeRetiredResources(stage, contents);
      for (const [file, bytes] of contents) {
        const target = join(stage, file);
        await writeFile(target, bytes, { flush: true });
        assert((await readRegularFile(target)).equals(bytes), "暂存的安装包文件读回失败");
      }
      await verifyPluginSnapshot(config.pluginPath, snapshot, false);
      assert(await settledRecoveryRevision(config) === recovery, "版本切换期间恢复记录发生变化");
      await checkPolicy();
    });
    return { version, mainSha256, backup, startedAt: Date.now() };
  });
}

async function verifyPluginSnapshot(root, snapshot, keepSettings) {
  const prefix = pluginRelative + sep;
  const directories = snapshot.directories.filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length));
  const files = snapshot.files.filter(({ path }) => path.startsWith(prefix))
    .map((record) => ({ ...record, path: record.path.slice(prefix.length) }));
  const staged = await readTree(root);
  const matches = (list) => list.filter(({ path }) => !keepSettings || path !== "data.json");
  assert(JSON.stringify(staged.directories) === JSON.stringify(directories)
    && JSON.stringify(matches(staged.files)) === JSON.stringify(matches(files)), "插件目录与已校验的备份不一致");
}

export async function restorePackage(config, directory) {
  const backup = resolve(directory);
  assert(dirname(backup) === config.backupRoot, "请选择配置的备份根目录下的一份备份");
  return withReleaseLock(config, async () => {
    const snapshot = await verifyBackup(config, backup);
    const oldPlugin = join(backup, "vault", pluginRelative);
    const oldManifest = await readJson(join(oldPlugin, "manifest.json"));
    assert(oldManifest.id === "lifeops-assistant" && versionPattern.test(oldManifest.version), "备份中的插件身份有误");
    const mainSha256 = (await fileRecord(oldPlugin, "main.js")).sha256;
    const hasLivePlugin = await statIfPresent(config.pluginPath);
    const liveSettings = join(config.pluginPath, "data.json");
    const settings = await statIfPresent(liveSettings);
    const recovery = await settledRecoveryRevision(config, true);
    await swapPlugin(config.pluginPath, async (stage) => {
      await cp(oldPlugin, stage, { recursive: true, errorOnExist: true, force: false });
      if (settings) {
        const prior = await fileRecord(config.pluginPath, "data.json");
        await copyFile(liveSettings, join(stage, "data.json"));
        assert((await fileRecord(stage, "data.json")).sha256 === prior.sha256, "现有设置的读回复核失败");
      } else if (hasLivePlugin) await rm(join(stage, "data.json"), { force: true });
      await verifyPluginSnapshot(stage, snapshot, Boolean(hasLivePlugin));
      assert(await settledRecoveryRevision(config, true) === recovery, "版本切换期间恢复记录发生变化");
    });
    return { version: oldManifest.version, mainSha256, startedAt: Date.now(),
      legacy: oldManifest.version === "0.2.0" && mainSha256 === legacyMainSha256 };
  });
}

export async function waitForHeartbeat(config, expected, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  const path = join(config.vaultPath, config.heartbeatPath || heartbeatRelative);
  for (;;) {
    await assertSafeDiskPath(path);
    if ((await statIfPresent(path))?.mtimeMs >= expected.startedAt) {
      let heartbeat;
      try { heartbeat = await readJson(path); }
      catch (error) { if (error.code && error.code !== "ENOENT") throw error; }
      const loadedAt = Date.parse(heartbeat?.loadedAt);
      if (heartbeat?.version === expected.version && heartbeat?.mainSha256 === expected.mainSha256
        && loadedAt >= expected.startedAt && loadedAt <= Date.now()) {
        assert(heartbeat.ok === true && Array.isArray(heartbeat.errors) && heartbeat.errors.length === 0, "插件加载心跳报告错误");
        const program = await fileRecord(config.pluginPath, "main.js");
        assert(program.sha256 === expected.mainSha256, "心跳与磁盘上的程序不一致");
        return;
      }
    }
    const remaining = deadline - Date.now();
    assert(remaining > 0, "未等到版本和哈希一致的新心跳");
    await setTimeout(Math.min(500, remaining));
  }
}
