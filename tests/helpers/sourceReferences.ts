import { isVaultPathExcluded } from "../../src/privacy";
import type { CapturedContext } from "../../src/sourceReferences";
export * from "../../src/sourceReferences";

export function contextGuardSourcePaths(contexts: readonly CapturedContext[]): string[] {
  return [...new Set(contexts.flatMap(context => context.blocks.map(block => block.path)))];
}

export function preparedContextSourcePaths(contexts: readonly CapturedContext[], prepared: string, excluded: string[] = []): string[] {
  const normalize = (text: string) => text.replace(/\n{3,}/g, "\n\n").trim();
  const text = normalize(prepared);
  return [...new Set(contexts.flatMap(context => context.blocks.filter(block =>
    !isVaultPathExcluded(block.path, excluded) && text.includes(normalize(block.fragment))).map(block => block.path)))];
}
