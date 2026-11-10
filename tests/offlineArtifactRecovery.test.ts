import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OfflineRecovery, revisionHash } from "../src/dataFoundation/offlineRecovery";

let root: string, vaultRoot: string, backupRoot: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "lifeops-artifacts-")));
  vaultRoot = join(root, "vault"); backupRoot = join(root, "backups");
  await mkdir(vaultRoot); await mkdir(backupRoot);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const mode = async (path = "helper") => (await stat(join(vaultRoot, path))).mode & 0o7777;
const plan = async () => JSON.parse(await readFile(join(backupRoot, "upgrade", "plan.json"), "utf8"));
function engine(paths = ["helper"], extra = {}) {
  return new OfflineRecovery(Object.assign({ vaultRoot, backupRoot, allowedPaths: paths },
    { artifactStorage: { maxTotalBytes: 128 * 1024 * 1024 } }, extra));
}
const update = (before: Buffer | null, after: Buffer | null, path = "helper", beforeMode = 0o600, afterMode = 0o500) =>
  ({ path, expectedHash: revisionHash(before), expectedMode: before === null ? null : beforeMode,
    after, ...(after === null ? {} : { mode: afterMode }) });
async function original() {
  const data = Buffer.from("fictional executable");
  await writeFile(join(vaultRoot, "helper"), data); await chmod(join(vaultRoot, "helper"), 0o600);
  return data;
}

describe("bounded binary artifact recovery", () => {
  it("treats identical bytes with a new executable mode as a change and restores the original mode", async () => {
    const data = await original();
    const update = { path: "helper", expectedHash: revisionHash(data), expectedMode: 0o600, after: data, mode: 0o500 };
    await engine().apply("upgrade", "full-package-v2", [update]);
    expect(await mode()).toBe(0o500);
    expect(await plan()).toMatchObject({ version: 2, storage: "sha256-blob-v1", changes: [{ before: { mode: 0o600 }, after: { mode: 0o500 } }] });
    await engine().recover("upgrade");
    expect(await mode()).toBe(0o600);
  });

  it("stores one private hash blob for identical before/after bytes and rejects default v1 access", async () => {
    const data = await original();
    await engine().apply("upgrade", "full-package-v2", [{ path: "helper", expectedHash: revisionHash(data), expectedMode: 0o600, after: data, mode: 0o500 }]);
    const saved = await plan();
    expect(saved.version).toBe(2);
    expect(saved.changes[0].before).toEqual({ hash: revisionHash(data), size: data.length, mode: 0o600 });
    expect(await readFile(join(backupRoot, "upgrade", "blobs", `${revisionHash(data)}.bin`))).toEqual(data);
    expect((await stat(join(backupRoot, "upgrade", "blobs", `${revisionHash(data)}.bin`))).mode & 0o7777).toBe(0o600);
    await expect(new OfflineRecovery({ vaultRoot, backupRoot, allowedPaths: ["helper"] }).recover("upgrade")).rejects.toMatchObject({ code: "invalid_backup" });
  });

  it.each([0o000, 0o100, 0o4600, NaN, 1.5])("rejects unreadable or unsafe mode %s before publishing a plan", async value => {
    const data = await original();
    await expect(engine().apply("upgrade", "full-package-v2", [update(data, data, "helper", 0o600, value)]))
      .rejects.toMatchObject({ code: "invalid_plan" });
    expect(await mode()).toBe(0o600); expect(await readFile(join(vaultRoot, "helper"))).toEqual(data);
    expect(await readdir(backupRoot)).toEqual([]);
  });

  it("includes both modes in repeated-request identity", async () => {
    const data = await original();
    await engine().apply("upgrade", "full-package-v2", [update(data, data)]);
    await expect(engine().apply("upgrade", "full-package-v2", [update(data, data, "helper", 0o600, 0o644)]))
      .rejects.toMatchObject({ code: "batch_id_reused" });
    expect(await mode()).toBe(0o500);
    expect(await engine().apply("upgrade", "full-package-v2", [update(data, data)])).toMatchObject({ status: "applied" });
  });

  it("guards retained files without backing up their bytes, including an entirely unchanged package", async () => {
    const data = await original();
    await engine().apply("upgrade", "full-package-v2", [update(data, data, "helper", 0o600, 0o600)]);
    expect((await plan()).changes).toEqual([]); expect((await plan()).retained).toHaveLength(1);
    expect(await readdir(join(backupRoot, "upgrade", "blobs"))).toEqual([]);
    await chmod(join(vaultRoot, "helper"), 0o644);
    await expect(engine().recover("upgrade")).rejects.toMatchObject({ code: "recovery_required" });
    expect(await mode()).toBe(0o644);
  });

  it("preflights a later mode-only conflict across all files before rollback writes anything", async () => {
    const data = await original(), next = Buffer.from("new fictional bytes");
    await engine(["helper", "new"]).apply("upgrade", "full-package-v2", [update(data, next), update(null, next, "new")]);
    await chmod(join(vaultRoot, "new"), 0o600);
    await expect(engine(["helper", "new"]).recover("upgrade")).rejects.toMatchObject({ code: "recovery_required" });
    expect(await readFile(join(vaultRoot, "helper"))).toEqual(next); expect(await mode()).toBe(0o500);
    expect(await mode("new")).toBe(0o600);
  });

  it("restores deleted executable bytes and mode while removing only its own newly added file", async () => {
    const data = await original(); await chmod(join(vaultRoot, "helper"), 0o500);
    const tool = engine(["helper", "new"]);
    await tool.apply("upgrade", "full-package-v2", [update(data, null, "helper", 0o500), update(null, data, "new")]);
    await writeFile(join(vaultRoot, "unknown"), "later fictional content");
    await tool.recover("upgrade");
    expect(await readFile(join(vaultRoot, "helper"))).toEqual(data); expect(await mode()).toBe(0o500);
    await expect(stat(join(vaultRoot, "new"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(vaultRoot, "unknown"), "utf8")).toBe("later fictional content");
  });

  it("recovers a rename-before-state crash window, then explicitly completes exact after-images", async () => {
    const data = await original(), next = Buffer.from("fictional replacement");
    await engine().apply("upgrade", "full-package-v2", [update(data, next)]);
    const saved = await plan();
    await writeFile(join(backupRoot, "upgrade", "state.json"), JSON.stringify({ version: 1, fingerprint: saved.fingerprint, status: "applying" }));
    expect(await engine().complete("upgrade", "full-package-v2")).toMatchObject({ status: "applied" });
    await engine().recover("upgrade"); expect(await mode()).toBe(0o600);
  });

  it.each(["missing", "bytes", "extra", "symlink", "hardlink"])("refuses %s blob before any rollback write", async kind => {
    const data = await original(), next = Buffer.from("fictional new image");
    await engine().apply("upgrade", "full-package-v2", [update(data, next)]);
    const blob = join(backupRoot, "upgrade", "blobs", `${revisionHash(data)}.bin`);
    if (kind === "missing") await rm(blob);
    if (kind === "bytes") await writeFile(blob, "corrupt");
    if (kind === "extra") await writeFile(join(backupRoot, "upgrade", "blobs", "unexpected.bin"), "extra");
    if (kind === "symlink" || kind === "hardlink") {
      await rm(blob); const other = join(root, "other"); await writeFile(other, data);
      if (kind === "symlink") await symlink(other, blob); else await link(other, blob);
    }
    await expect(engine().recover("upgrade")).rejects.toThrow();
    expect(await readFile(join(vaultRoot, "helper"))).toEqual(next); expect(await mode()).toBe(0o500);
  });

  it("checks all blobs again after a hook, including an unused before-image", async () => {
    const data = await original(), next = Buffer.from("fictional new image");
    const tool = engine(["helper"], { onStep: async ({ stage }: { stage: string }) => {
      if (stage === "before-write") await writeFile(join(backupRoot, "upgrade", "blobs", `${revisionHash(data)}.bin`), "damaged");
    } });
    await expect(tool.apply("upgrade", "full-package-v2", [update(data, next)])).rejects.toMatchObject({ code: "recovery_required" });
    expect(await readFile(join(vaultRoot, "helper"))).toEqual(data); expect(await mode()).toBe(0o600);
  });

  it("never auto-restores using a newly fingerprinted, altered plan", async () => {
    const data = await original(), next = Buffer.from("fictional new image");
    const tool = engine(["helper"], { onStep: async ({ stage }: { stage: string }) => {
      if (stage !== "before-write") return;
      const saved = await plan(), c = saved.changes[0]; [c.before, c.after] = [c.after, c.before];
      const { fingerprint: _old, ...payload } = saved;
      saved.fingerprint = revisionHash(Buffer.from(JSON.stringify(payload)));
      await writeFile(join(backupRoot, "upgrade", "plan.json"), JSON.stringify(saved));
      await writeFile(join(backupRoot, "upgrade", "state.json"), JSON.stringify({ version: 1, fingerprint: saved.fingerprint, status: "applying" }));
    } });
    await expect(tool.apply("upgrade", "full-package-v2", [update(data, next)])).rejects.toMatchObject({ code: "recovery_required" });
    expect(await readFile(join(vaultRoot, "helper"))).toEqual(data); expect(await mode()).toBe(0o600);
  });

  it("bounds unique before/after bytes and keeps the metadata small for large binary images", async () => {
    const before = Buffer.alloc(12 * 1024 * 1024, 65), after = Buffer.alloc(12 * 1024 * 1024, 66);
    await writeFile(join(vaultRoot, "helper"), before); await chmod(join(vaultRoot, "helper"), 0o600);
    await expect(engine(["helper"], { artifactStorage: { maxTotalBytes: 20 * 1024 * 1024 } })
      .apply("too-large", "full-package-v2", [update(before, after)])).rejects.toMatchObject({ code: "artifact_limit_exceeded" });
    expect((await readFile(join(vaultRoot, "helper"))).equals(before)).toBe(true);
    await engine().apply("upgrade", "full-package-v2", [update(before, after)]);
    expect((await readFile(join(backupRoot, "upgrade", "plan.json"))).length).toBeLessThan(2000);
    await engine().recover("upgrade"); expect((await readFile(join(vaultRoot, "helper"))).equals(before)).toBe(true);
  }, 60_000);

  it("keeps snapshot APIs and v1 plans outside the explicit artifact format", async () => {
    const data = await original();
    const legacy = new OfflineRecovery({ vaultRoot, backupRoot, allowedPaths: ["helper"] });
    await legacy.apply("legacy", "original-v1", [{ path: "helper", expectedHash: revisionHash(data), after: data }]);
    await expect(engine().recover("legacy")).rejects.toMatchObject({ code: "invalid_backup" });
    await expect(engine().snapshot("snapshot")).rejects.toMatchObject({ code: "unsupported_artifact_operation" });
    await expect(engine().restore("legacy", "restored")).rejects.toMatchObject({ code: "unsupported_artifact_operation" });
  });
});
