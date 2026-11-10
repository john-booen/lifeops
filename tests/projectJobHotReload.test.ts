import { build } from "esbuild";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
it("two separately bundled modules share late-save ownership until the old bundle has truly settled", async () => {
  const root = await mkdtemp(join(tmpdir(), "lifeops-job-hot-reload-"));
  try {
    const stub = join(root, "shared-obsidian.mjs");
    await build({ entryPoints: [resolve("tests/helpers/obsidianFileMock.ts")], outfile: stub, platform: "node", format: "esm", target: "node22", logLevel: "silent" });
    const bundles = [join(root, "old.mjs"), join(root, "new.mjs")];
    for (const outfile of bundles) await build({ entryPoints: [resolve("tests/helpers/projectJobReloadFacade.ts")], outfile, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
      plugins: [{ name: "shared-host", setup(builder) { builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: stub, external: true })); } }] });
    const first = await import(/* @vite-ignore */ pathToFileURL(bundles[0]).href), second = await import(/* @vite-ignore */ pathToFileURL(bundles[1]).href);
    let release!: () => void, entered!: () => void, loaded = true;
    const gate = new Promise<void>(resolve => release = resolve), started = new Promise<void>(resolve => entered = resolve);
    await mkdir(join(root, "vault"));
    const old = await first.facade(join(root, "vault"), undefined, async () => { entered(); await gate; }, () => loaded);
    const pending = old.runner.startConfirmed(await old.runner.prepare([{ title: "纯虚构跨包任务甲" }, { title: "纯虚构跨包任务乙" }], "创建任务：纯虚构跨包安排"));
    const settled = pending.catch((error: unknown) => error); await started;
    loaded = false; old.runner.stopForHostUnload();
    const fresh = await second.facade(join(root, "vault"), old.vault);
    expect(fresh.runner.constructor).not.toBe(old.runner.constructor);
    const before = old.vault.writes.length;
    await expect(fresh.runner.resume(await fresh.repository.load())).rejects.toThrow("仍在结算");
    expect(old.vault.writes.length).toBe(before);
    release(); await settled;
    expect((await fresh.store.readTaskDb()).tasks).toHaveLength(1);
    const inspected = await fresh.runner.inspect(); expect(inspected.canResume).toBe(true);
    const result = await fresh.runner.resume(inspected.snapshot);
    expect(result.snapshot.document.job.status).toBe("completed"); expect(result.snapshot.document.job.generation).toBe(2);
    expect((await fresh.store.readTaskDb()).tasks).toHaveLength(2);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);
