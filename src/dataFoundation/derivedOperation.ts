import { randomUUID } from "node:crypto";
import type { StoreHost } from "../store/settingsSlice";
import { isGuardedOperationScope, readFactOperation, type FactOperationOptions } from "./factOperation";

/** Derived data shares file recovery and serialization, but creates no user
 * action Ledger or active memory. Read entry points wait for the same boundary. */
export async function runDerivedOperation<T>(store: StoreHost, execute: (scope: StoreHost) => Promise<T>, options?: FactOperationOptions): Promise<T> {
  if (!store.runFactOperation || isGuardedOperationScope(store)) return execute(store);
  return store.runFactOperation({ operationId: `derived:${randomUUID()}`, purpose: "derived" }, execute, async () => undefined, options);
}

export function guardDerivedMethods(prototype: object, names: readonly string[]): void {
  const target = prototype as Record<string, (this: StoreHost, ...args: unknown[]) => Promise<unknown>>;
  for (const name of names) {
    const original = target[name];
    if (typeof original !== "function") throw new Error(`Missing derived method: ${name}`);
    target[name] = function(this: StoreHost, ...args: unknown[]) {
      const options = name === "rebuildVectorIndex" ? {
        assertCurrent: typeof args[2] === "function" ? args[2] as () => void : undefined,
        onCommitted: typeof args[3] === "function" ? args[3] as () => void : undefined
      } : undefined;
      return runDerivedOperation(this, scope => original.apply(scope, args), options);
    };
  }
}

export function guardReadonlyDerivedMethods(prototype: object, names: readonly string[]): void {
  const target=prototype as Record<string,(this:StoreHost,...args:unknown[])=>Promise<unknown>>;
  for(const name of names){
    const original=target[name];
    if(typeof original!=="function")throw Error(`Missing derived read: ${name}`);
    target[name]=function(this:StoreHost,...args:unknown[]){return readFactOperation(this,()=>original.apply(this,args));};
  }
}
