import { createHash } from "node:crypto";
import type { DataAdapter, PluginManifest } from "obsidian";
import { expect, it, vi } from "vitest";
import { captureReleaseHeartbeat } from "../src/releaseHeartbeat";

const manifest = { dir: ".obsidian/plugins/lifeops-assistant", version: "0.3.0-alpha.1" } as PluginManifest;
function fakeAdapter() {
  const bytes = new Uint8Array([0, 255, 10, 20]);
  const folders = new Set<string>();
  const files = new Map<string, string>();
  const readBinary = vi.fn(async () => bytes.buffer);
  const adapter = {
    readBinary,
    exists: async (path: string) => folders.has(path),
    mkdir: async (path: string) => { folders.add(path); },
    write: async (path: string, body: string) => { files.set(path, body); }
  } as unknown as DataAdapter;
  return { adapter, files, folders, readBinary, sha256: createHash("sha256").update(bytes).digest("hex") };
}

it("captures the plugin's own binary and publishes its version, hash and startup result", async () => {
  const { adapter, files, folders, readBinary, sha256 } = fakeAdapter();
  const report = captureReleaseHeartbeat(adapter, manifest, () => true);
  expect(files.size).toBe(0);
  await report([]);
  expect(readBinary).toHaveBeenCalledWith(`${manifest.dir}/main.js`);
  expect(folders.has("LifeOps/Output/AI/System")).toBe(true);
  const marker = JSON.parse(files.get("LifeOps/Output/AI/System/heartbeat.json")!);
  expect(marker).toMatchObject({ version: manifest.version, mainSha256: sha256, ok: true, errors: [] });
  expect(new Date(marker.loadedAt).toISOString()).toBe(marker.loadedAt);
  await report(["data"]);
  expect(JSON.parse(files.get("LifeOps/Output/AI/System/heartbeat.json")!))
    .toMatchObject({ ok: false, errors: [{ type: "data", message: "资料初始化失败" }] });
});

it("does not write a heartbeat from an unloaded instance", async () => {
  const { adapter, files, folders } = fakeAdapter();
  let current = true;
  const report = captureReleaseHeartbeat(adapter, manifest, () => current);
  current = false;
  await report([]);
  expect(folders.size).toBe(0);
  expect(files.size).toBe(0);
});

it("uses the configured report folder and never follows a relative escape", async () => {
  const { adapter, files } = fakeAdapter();
  let reports = "虚构旧目录/报告";
  const report = captureReleaseHeartbeat(adapter, manifest, () => true, () => reports);
  await report([]);
  expect(files.has("虚构旧目录/报告/System/heartbeat.json")).toBe(true);
  expect(files.has("LifeOps/Output/AI/System/heartbeat.json")).toBe(false);
  reports = "../越界";
  await report([]);
  expect(files.has("../越界/System/heartbeat.json")).toBe(false);
  expect(files.has("LifeOps/Output/AI/System/heartbeat.json")).toBe(true);
});
