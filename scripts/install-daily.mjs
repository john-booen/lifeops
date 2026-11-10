import { installPackage, loadReleaseConfig, releaseVersion, waitForHeartbeat } from "./release-files.mjs";

const version = releaseVersion(process.argv.slice(2));
const config = await loadReleaseConfig();
const installed = await installPackage(config, version);
console.log("程序已复制，请正常打开目标库或重新启用插件。正在等待心跳。");
await waitForHeartbeat(config, installed);
console.log(`已加载 ${version} · 指纹 ${installed.mainSha256} · 心跳通过`);
