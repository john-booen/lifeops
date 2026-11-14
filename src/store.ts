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
import { assertOperationClaimAllowed, guardedOperationOwner, runFactOperation, type FactOperationIdentity, type FactOperationOptions } from "./dataFoundation/factOperation";
import type { OperationUndoDescriptor } from "./dataFoundation/operationLedger";
import type { StoreHost } from "./store/settingsSlice";
import { guardPersonalMemorySourceContexts } from "./personalMemoryContext";

export type { VaultStats } from "./store/settingsSlice";

export class LifeOpsStore {
  constructor(readonly app: App, readonly settings: LifeOpsSettings) {}

  runFactOperation<T>(identity: FactOperationIdentity, execute: (store: StoreHost) => Promise<T>, finalize: (result: T, undo?: OperationUndoDescriptor) => Promise<void>, options?: FactOperationOptions): Promise<T> {
    return runFactOperation(this as unknown as StoreHost, identity, execute, finalize, options);
  }

  assertOperationClaimAllowed(): Promise<void> {
    return assertOperationClaimAllowed(this as unknown as StoreHost);
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
