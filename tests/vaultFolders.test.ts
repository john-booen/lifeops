import { describe, expect, it, vi } from "vitest";
import { ensureFolderHierarchy } from "../src/vaultFolders";

describe("vault folder initialization", () => {
  it("creates a missing folder hierarchy in order", async () => {
    const folders = new Set<string>();
    const create = vi.fn(async (path: string) => {
      folders.add(path);
    });

    await ensureFolderHierarchy("LifeOps/Output/AI/Memory", {
      exists: (path) => folders.has(path),
      create
    });

    expect(create.mock.calls.map(([path]) => path)).toEqual([
      "LifeOps",
      "LifeOps/Output",
      "LifeOps/Output/AI",
      "LifeOps/Output/AI/Memory"
    ]);
  });

  it("treats an already-existing folder error as an idempotent startup race", async () => {
    const create = vi.fn(async () => {
      throw new Error("Folder already exists.");
    });

    await expect(ensureFolderHierarchy("LifeOps/Output", {
      exists: () => false,
      create
    })).resolves.toBeUndefined();
  });

  it("does not hide unrelated folder creation failures", async () => {
    await expect(ensureFolderHierarchy("LifeOps/Output", {
      exists: () => false,
      create: async () => {
        throw new Error("permission denied");
      }
    })).rejects.toThrow("permission denied");
  });
});
