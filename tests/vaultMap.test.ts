import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
// @ts-expect-error Node-only mapping script is tested against actual isolated files.
import { mapVault, namingPattern } from "../scripts/map-vault.mjs";

let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; });

it("maps metadata and top-level keys while preserving source bytes and timestamps", async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "lifeops-vault-map-"));
  await mkdir(join(root, "日记"));
  const path = join(root, "日记/2026-11-07早.md");
  const content = "---\ndate: 2026-11-07\nsecret: value-only-secret\nnested:\n  hidden: keep-private\n---\nbody-only-secret";
  await writeFile(path, content);
  const before = await lstat(path);
  const mapped = await mapVault(root);
  expect(mapped.markdown).toContain("date（1）");
  expect(mapped.markdown).toContain("nested（1）");
  expect(mapped.markdown).toContain("YYYY-MM-DD 早.md");
  for (const privateValue of ["value-only-secret", "keep-private", "body-only-secret", "hidden"]) {
    expect(mapped.markdown).not.toContain(privateValue);
  }
  expect(mapped.folders[0].total).toBe(1);
  expect(createHash("sha256").update(await readFile(path)).digest("hex"))
    .toBe(createHash("sha256").update(content).digest("hex"));
  expect((await lstat(path)).mtimeMs).toBe(before.mtimeMs);
});

it("aggregates deep notes without displaying directories below four levels or following links", async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "lifeops-vault-map-"));
  await mkdir(join(root, "a/b/c/d/e"), { recursive: true });
  await writeFile(join(root, "a/b/c/d/e/note.md"), "private body");
  await symlink(join(root, "a"), join(root, "linked"));
  const mapped = await mapVault(root);
  expect(mapped.folders.map((folder: { path: string }) => folder.path)).toEqual([".", "a", "a/b", "a/b/c", "a/b/c/d"]);
  expect(mapped.folders[0].total).toBe(1);
  expect(mapped.skipped.links).toBe(1);
  expect(mapped.markdown).not.toContain("private body");
});

it("marks incomplete frontmatter without treating its apparent body keys as metadata", async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "lifeops-vault-map-"));
  await writeFile(join(root, "note.md"), "---\nprivate: value\nbody: other");
  const mapped = await mapVault(root);
  expect(mapped.skipped.incompleteFrontmatter).toBe(1);
  expect(mapped.markdown).not.toContain("private");
  expect(namingPattern("private-project-title.md")).toBe("自定义标题.md");
});

it("reads empty, BOM and CRLF headers and quoted keys without exporting values", async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "lifeops-vault-map-"));
  await writeFile(join(root, "empty.md"), "---\n---\nprivate body");
  await writeFile(join(root, "quoted.md"), "\uFEFF---\r\n'quoted:key': private-value\r\n---\r\nprivate body");
  const mapped = await mapVault(root);
  expect(mapped.skipped.incompleteFrontmatter).toBe(0);
  expect(mapped.markdown).toContain("quoted:key（1）");
  expect(mapped.markdown).not.toContain("private-value");
  expect(mapped.markdown).not.toContain("private body");
});
