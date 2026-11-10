import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../../src/defaults";
import { LifeOpsStore } from "../../src/store";
import type { StoreHost } from "../../src/store/settingsSlice";
import { AgentRuntime } from "../../src/agentRuntime";
import { ProjectJobRunner } from "../../src/projectJobRunner";
import { ProjectJobRepository } from "../../src/projectJobRepository";
import { DiskVault } from "./diskVault";
export async function facade(root: string, vault?: DiskVault, refresh: () => Promise<void> = async () => {}, loaded: () => boolean = () => true) {
  const disk = vault ?? new DiskVault(root);
  const store = new LifeOpsStore({ vault: disk } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  if (!vault) await store.initializeVault();
  const runtime = new AgentRuntime({ store, refreshViews: refresh });
  const runner = new ProjectJobRunner(store, runtime, () => new Date("2026-10-05T03:00:00.000Z"), () => { if (!loaded()) throw Error("Synthetic old bundle unloaded"); });
  return { store, vault: disk, runner, repository: new ProjectJobRepository(store) };
}
