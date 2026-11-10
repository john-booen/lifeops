import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

export async function isolatedProviderConfig(): Promise<string> {
  const path = process.env.LIFEOPS_EVAL_PROVIDER_CONFIG;
  if (!path || !isAbsolute(path) || basename(path) !== "data.json") {
    throw Error("请显式指定虚构隔离库的 LIFEOPS_EVAL_PROVIDER_CONFIG");
  }
  const config = await realpath(path);
  const plugin = dirname(config), plugins = dirname(plugin), dot = dirname(plugins);
  if (basename(plugin) !== "lifeops-assistant" || basename(plugins) !== "plugins" || basename(dot) !== ".obsidian") {
    throw Error("评测配置必须来自虚构 Obsidian 隔离库");
  }
  const marker = join(dirname(dot), "TEST_VAULT_ONLY.md");
  if (!(await lstat(marker)).isFile() || !(await readFile(marker, "utf8")).includes("内容全部为虚构数据")) {
    throw Error("没有找到全虚构隔离库标记");
  }
  return config;
}
