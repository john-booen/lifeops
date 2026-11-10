export interface VaultFolderAccess {
  exists(path: string): boolean;
  create(path: string): Promise<void>;
}

export function isFolderAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && /folder already exists/i.test(error.message);
}

export async function ensureFolderHierarchy(
  folderPath: string,
  access: VaultFolderAccess
): Promise<void> {
  if (!folderPath || folderPath === ".") return;

  const parts = folderPath.split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (access.exists(current)) continue;

    try {
      await access.create(current);
    } catch (error) {
      // The Vault index can briefly lag behind the filesystem during startup,
      // or another initialization can create the same folder concurrently.
      if (access.exists(current) || isFolderAlreadyExistsError(error)) continue;
      throw error;
    }
  }
}
