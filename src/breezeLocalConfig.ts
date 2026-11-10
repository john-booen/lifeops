import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { BreezeLocalSettings, RealtimeVoiceSettings } from "./types";

export interface BreezeLocalPaths extends BreezeLocalSettings { model: string; cache: string }

export function breezeLocalPaths(settings: RealtimeVoiceSettings): BreezeLocalPaths {
  const config = settings.breeze;
  if (!config || ![config.home, config.python, config.referenceAudio, config.referenceText].every(value => typeof value === "string" && value.trim())) {
    throw new Error("请先在设置中填写 Breeze 路径和参考文本。");
  }
  const paths = { home: config.home.trim(), python: config.python.trim(), referenceAudio: config.referenceAudio.trim(),
    referenceText: config.referenceText.trim(), model: join(config.home.trim(), "work", "breeze-model-4bit"), cache: join(config.home.trim(), "work", "breeze-hf-cache") };
  for (const [path, directory, label] of [[paths.home, true, "Breeze 目录"], [paths.python, false, "Python"],
    [paths.referenceAudio, false, "参考音频"], [paths.model, true, "本地模型目录"]] as const) {
    let valid = false;
    try { const stat = statSync(path); valid = directory ? stat.isDirectory() : stat.isFile(); } catch { /* Show only the setting name. */ }
    if (!valid) throw new Error(`未找到${label}，请检查设置。`);
  }
  return paths;
}

export async function checkBreezeLocalInstallation(settings: RealtimeVoiceSettings): Promise<string> {
  const paths = breezeLocalPaths(settings);
  const version = await new Promise<string>((resolve, reject) => {
    execFile(paths.python, ["--version"], { timeout: 10_000, maxBuffer: 4096, windowsHide: true }, (error, stdout, stderr) => {
      if (error) { reject(new Error("Python 无法运行，请检查路径和执行权限。")); return; }
      const text = (stdout || stderr).trim();
      const match = text.match(/^Python (3\.\d+\.\d+)/);
      if (!match) { reject(new Error("请选择可运行的 Python 3。")); return; }
      resolve(`Python ${match[1]}`);
    });
  });
  return `路径检查通过 · ${version}`;
}
