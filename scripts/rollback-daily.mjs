import { loadReleaseConfig, restorePackage, waitForHeartbeat } from "./release-files.mjs";
import { assert } from "./verify-plugin-package.mjs";

const [directory, ...extra] = process.argv.slice(2);
assert(directory && extra.length === 0, "请提供一份已校验备份的目录");
const config = await loadReleaseConfig();
const restored = await restorePackage(config, directory);
console.log(`已恢复程序 ${restored.version} · 指纹 ${restored.mainSha256}。请正常打开目标库或重新启用插件。`);
if (restored.legacy) console.log("这份 0.2.0 程序没有心跳功能。请打开旧版 LifeOps 面板确认运行。");
else {
  await waitForHeartbeat({ ...config, heartbeatPath: config.rollbackHeartbeatPath }, restored);
  console.log("回退心跳通过");
}
