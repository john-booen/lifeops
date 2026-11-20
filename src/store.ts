import { App } from "obsidian";
import { applyAgentSlice, type AgentSliceApi } from "./store/agentSlice";
import { applyHabitSlice, type HabitSliceApi } from "./store/habitSlice";
import { applySettingsSlice, type SettingsSliceApi } from "./store/settingsSlice";
import { applySourceSlice, type SourceSliceApi } from "./store/sourceSlice";
import { applyTaskSlice, type TaskSliceApi } from "./store/taskSlice";
import { applyObservationSlice, type ObservationSliceApi } from "./store/observationSlice";
import { applyVoiceSlice, type VoiceSliceApi } from "./store/voiceSlice";
import { applyProjectSlice, type ProjectSliceApi } from "./store/projectSlice";
import { applyTradingSlice, type TradingSliceApi } from "./store/tradingSlice";
import type { LifeOpsSettings } from "./types";
import { activeFactOperation, assertOperationClaimAllowed, guardedOperationIdentity, guardedOperationOwner, runFactOperation, type FactOperationIdentity, type FactOperationOptions } from "./dataFoundation/factOperation";
import type { OperationClaimInput, OperationUndoDescriptor } from "./dataFoundation/operationLedger";
import type { StoreHost } from "./store/settingsSlice";
import { guardPersonalMemorySourceContexts } from "./personalMemoryContext";

export type { VaultStats } from "./store/settingsSlice";

export interface StoreExecutionPolicy {
  canWriteFacts(): boolean;
  assertWriteAllowed(identity?: { operationId: string }, target?: { path: string; kind: "file" | "folder" }): Promise<void>;
}

export class LifeOpsStore {
  constructor(readonly app: App, readonly settings: LifeOpsSettings, private readonly executionPolicy?: StoreExecutionPolicy) {}

  enforcesDeviceExecution(): boolean { return Boolean(this.executionPolicy); }

  canWriteFacts(): boolean { return this.executionPolicy?.canWriteFacts() ?? true; }

  async assertFactWritesAllowed(): Promise<void> { await this.executionPolicy?.assertWriteAllowed(); }

  async assertFileWriteAllowed(path: string, kind: "file" | "folder" = "file"): Promise<void> {
    // A rejected live save still needs a content-preserving retained directory for rollback.
    // This grants no file write and no new operation to the original Store.
    const retained = (this as unknown as StoreHost).path(this.settings.folders.aiReports, "Operations", "Retained");
    if (kind === "folder" && (path === retained || path.startsWith(retained + "/"))
      && activeFactOperation(this as unknown as StoreHost)) return;
    await this.executionPolicy?.assertWriteAllowed(guardedOperationIdentity(this as unknown as StoreHost), { path, kind });
  }

  async runFactOperation<T>(identity: FactOperationIdentity, execute: (store: StoreHost) => Promise<T>, finalize: (result: T, undo?: OperationUndoDescriptor) => Promise<void>, options: FactOperationOptions = {}): Promise<T> {
    if (!this.executionPolicy) return runFactOperation(this as unknown as StoreHost, identity, execute, finalize, options);
    await this.executionPolicy?.assertWriteAllowed(identity);
    return runFactOperation(this as unknown as StoreHost, identity, execute, finalize, { ...options,
      assertBeforeCommit: async () => {
        await options.assertBeforeCommit?.();
        await this.executionPolicy?.assertWriteAllowed(identity);
      }
    });
  }

  async assertOperationClaimAllowed(input?: OperationClaimInput): Promise<void> {
    await this.executionPolicy?.assertWriteAllowed(input);
    await assertOperationClaimAllowed(this as unknown as StoreHost);
  }

  operationLedgerLockKey(): object {
    return (guardedOperationOwner(this as unknown as StoreHost)?.app ?? this.app).vault;
  }
}

export interface LifeOpsStore extends SettingsSliceApi, TaskSliceApi, HabitSliceApi, AgentSliceApi, SourceSliceApi, ObservationSliceApi, VoiceSliceApi, ProjectSliceApi, TradingSliceApi {}

applySettingsSlice(LifeOpsStore);
applyTaskSlice(LifeOpsStore);
applyHabitSlice(LifeOpsStore);
applyAgentSlice(LifeOpsStore);
applySourceSlice(LifeOpsStore);
applyObservationSlice(LifeOpsStore);
applyVoiceSlice(LifeOpsStore);
applyProjectSlice(LifeOpsStore);
applyTradingSlice(LifeOpsStore);
guardPersonalMemorySourceContexts(LifeOpsStore.prototype);
