import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";
import { collectSessionHotwords } from "../src/voice/sessionHotwords";
vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, TFolder: class {}, Notice: class {},
  normalizePath: (s: string) => s.replace(/\\/g, "/").replace(/\/{2,}/g, "/"),
  parseYaml: JSON.parse, stringifyYaml: JSON.stringify }));
const { LifeOpsStore } = await import("../src/store");
const { createFsApp } = await import("./helpers/fsApp");
let root: string, store: StoreHost;
const now = new Date("2067-11-21T04:00:00Z");
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
  root = await mkdtemp(join(tmpdir(), "lifeops-hotword-fragments-"));
  const settings = structuredClone(DEFAULT_SETTINGS); settings.ai.provider = "off";
  settings.privacy = { excludedVaultPrefixes: [], plaintextCredentialStorageAccepted: false };
  store = new LifeOpsStore(createFsApp(root), settings) as unknown as StoreHost; await store.initializeVault();
});
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });

it("keeps full fictional names and object words when the segmenter divides them into single characters", async () => {
  await store.createTask({ title: "和虚构人物陆辰整理蓝色纸盒", date: "2067-11-21" });
  await store.createTask({ title: "给林小葵送蓝色样品盒", date: "2067-11-21" });
  const words = await collectSessionHotwords(store, undefined, now);
  expect(words).toEqual(expect.arrayContaining(["陆辰", "林小葵", "样品盒", "纸盒"]));
  expect(words).not.toContain("林"); expect(words.length).toBeLessThanOrEqual(50);
  expect(new Set(words).size).toBe(words.length);
});
it("preserves manual priority and the existing fifty-word limit", async () => {
  await store.createTask({ title: "给林小葵送蓝色样品盒", date: "2067-11-21" });
  const manual = Array.from({ length: 50 }, (_, i) => `虚构手填词${String(i).padStart(2, "0")}`);
  expect(await collectSessionHotwords(store, manual.join("\n"), now)).toEqual(manual);
});
it("does not join names across punctuation or whitespace, or change an existing Latin token", async () => {
  await store.createTask({ title: "给林，小葵送纸盒", date: "2067-11-21" });
  await store.createTask({ title: "陆 辰与EVALBOX核对", date: "2067-11-21" });
  const words = await collectSessionHotwords(store, undefined, now);
  expect(words).not.toContain("林小葵"); expect(words).not.toContain("陆辰"); expect(words).toContain("EVALBOX");
});
it("keeps excluded source records and credential-bearing titles out of automatic words", async () => {
  store.settings.ai.apiKey = "test-only-hotword-credential";
  await store.createTask({ title: "林小葵 test-only-hotword-credential", date: "2067-11-21" });
  expect(await collectSessionHotwords(store, undefined, now)).not.toContain("林小葵");
  await store.createTask({ title: "陆辰整理纸盒", date: "2067-11-21" });
  store.settings.privacy = { ...store.settings.privacy, excludedVaultPrefixes: [store.taskDbPath()] };
  expect(await collectSessionHotwords(store, "虚构手填", now)).toEqual(["虚构手填"]);
});
