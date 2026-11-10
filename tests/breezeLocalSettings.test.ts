import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { migrateRealtimeVoiceSettings } from "../src/settingsMigration";
import { breezeLocalPaths, checkBreezeLocalInstallation } from "../src/breezeLocalConfig";
import type { RealtimeVoiceSettings } from "../src/types";

describe("Breeze settings migration", () => {
  it("asks an old local installation to configure its own paths", () => {
    const legacy = { ...DEFAULT_SETTINGS.realtimeVoice, ttsEngine: "breeze-local" as const, breeze: undefined };
    const next = migrateRealtimeVoiceSettings(legacy);
    expect(next.breeze).toEqual({ home: "", python: "", referenceAudio: "", referenceText: "" });
    expect(legacy.breeze).toBeUndefined();
    expect(migrateRealtimeVoiceSettings(next)).toEqual(next);
  });
  it("preserves a user's configured paths and reference text", () => {
    const config = { home: "/fictional/home", python: "/fictional/python", referenceAudio: "/fictional/reference.wav", referenceText: "纯虚构参考文字。" };
    const next = migrateRealtimeVoiceSettings({ ...DEFAULT_SETTINGS.realtimeVoice, ttsEngine: "breeze-local", breeze: config });
    expect(next.breeze).toEqual(config); expect(next.breeze).not.toBe(config);
  });
  it("keeps fresh nonlocal installations empty and tolerates malformed legacy fields", () => {
    expect(migrateRealtimeVoiceSettings(DEFAULT_SETTINGS.realtimeVoice).breeze?.home).toBe("");
    const next = migrateRealtimeVoiceSettings({ ...DEFAULT_SETTINGS.realtimeVoice, breeze: { home: 42 } } as unknown as RealtimeVoiceSettings);
    expect(next.breeze).toEqual({ home: "", python: "", referenceAudio: "", referenceText: "" });
  });
});

describe("Breeze local path check", () => {
  let root: string, settings: RealtimeVoiceSettings;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "lifeops-breeze-check-"));
    const python = join(root, "python-fixture"), referenceAudio = join(root, "reference.wav");
    await mkdir(join(root, "work", "breeze-model-4bit"), { recursive: true });
    await writeFile(python, "#!/bin/sh\necho 'Python 3.12.9'\n", { mode: 0o700 });
    await writeFile(referenceAudio, "fictional reference");
    settings = { ...DEFAULT_SETTINGS.realtimeVoice, ttsEngine: "breeze-local", breeze: { home: root, python, referenceAudio, referenceText: "纯虚构参考。" } };
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  it("accepts custom existing files and a runnable Python version", async () => {
    expect(breezeLocalPaths(settings)).toMatchObject(settings.breeze!);
    await expect(checkBreezeLocalInstallation(settings)).resolves.toBe("路径检查通过 · Python 3.12.9");
  });
  it("reports the missing setting without leaking filesystem errors", async () => {
    settings.breeze!.referenceAudio = join(root, "missing.wav");
    await expect(checkBreezeLocalInstallation(settings)).rejects.toThrow("未找到参考音频");
  });
  it("rejects a non-Python executable", async () => {
    await writeFile(settings.breeze!.python, "#!/bin/sh\necho 'fictional non-python output'\n", { mode: 0o700 });
    await expect(checkBreezeLocalInstallation(settings)).rejects.toThrow("Python 3");
  });
});
