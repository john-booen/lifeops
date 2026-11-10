import { spawnSync } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let root: string;
let vault: string;
const markerName = ".lifeops-preserve-user-records";
const noteBytes = Buffer.from("# Synthetic preserved record\r\n\r\nKeep all bytes.\r\n", "utf8");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-rebuild-protection-"));
  vault = join(root, "test-vault");
  await mkdir(join(root, "scripts"));
  await copyFile(new URL("../scripts/rebuild-test-vault.mjs", import.meta.url), join(root, "scripts", "rebuild-test-vault.mjs"));
  await mkdir(join(vault, "journals"), { recursive: true });
  await writeFile(join(vault, "journals", "note.md"), noteBytes);
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

function run(...args: string[]) {
  const child = spawnSync(process.execPath, [join(root, "scripts", "rebuild-test-vault.mjs"), ...args], {
    cwd: root, encoding: "utf8", timeout: 10000
  });
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  expect(child.status).toBe(1);
  return child;
}

async function tree(folder: string): Promise<Record<string, Buffer | string>> {
  const result: Record<string, Buffer | string> = {};
  async function visit(current: string, prefix = "") {
    for (const name of (await readdir(current)).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const path = join(current, name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) result[relative] = `symlink:${await readlink(path)}`;
      else if (stat.isDirectory()) { result[relative] = "directory"; await visit(path, relative); }
      else result[relative] = await readFile(path);
    }
  }
  await visit(folder);
  return result;
}

describe("actual Test Vault rebuild entry point in temporary workspaces", () => {
  it.each(["file", "directory", "symlink", "dangling-symlink"])("preserves every byte when the marker is a %s", async kind => {
    const marker = join(vault, markerName);
    if (kind === "file") await writeFile(marker, "Preserve user records.\n");
    else if (kind === "directory") await mkdir(marker);
    else {
      const target = join(root, "marker-target");
      if (kind === "symlink") await writeFile(target, "Preserve this target too.\n");
      await symlink(target, marker);
    }
    const before = await tree(root);
    // A caller cannot bypass preservation by supplying a force argument.
    const child = run("--force");
    expect(child.stderr).toContain("Refusing to rebuild Test Vault:");
    expect(child.stderr).toContain(`${markerName} protects existing user records`);
    expect(await tree(root)).toEqual(before);
    expect(await readFile(join(vault, "journals", "note.md"))).toEqual(noteBytes);
  });

  it("fails closed when checking the marker returns an error other than absence", async () => {
    await rm(vault, { recursive: true });
    await writeFile(vault, noteBytes); // lstat of the marker now fails with ENOTDIR.
    const before = await tree(root);
    const child = run();
    expect(child.stderr).toContain("user-record protection could not be checked");
    expect(child.stderr).toContain("ENOTDIR");
    expect(await tree(root)).toEqual(before);
  });

  it("continues the original rebuild path when no preservation marker exists", async () => {
    const child = run();
    // No fixture is provided: deletion proceeds, then the original copy fails.
    expect(child.stderr).not.toContain("Refusing to rebuild Test Vault:");
    expect(child.stderr).toContain("ENOENT");
    expect(child.stderr).toContain(join(root, "fixtures", "test-vault"));
    await expect(lstat(vault)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
