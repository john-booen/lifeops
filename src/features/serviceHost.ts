import type { StoreHost } from "../store/settingsSlice";
import type { FactOperationOptions } from "../dataFoundation/factOperation";

export interface LocalOperationHost {
  saveLocalOperation(name: string, args: Record<string, unknown>, execute: (store: StoreHost) => Promise<unknown>, options?: FactOperationOptions): Promise<void>;
  refreshViews(): Promise<void>;
  onTaskOverload?(taskId: string, reason: string): void;
}
