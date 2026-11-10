import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(resolve("src/dataFoundation/offlineRecovery.ts")).href;
let root: string;
let vault: string;
let backup: string;
let config: string;
const originalA = Buffer.from('\ufeff{"tasks":[{"id":"stable-task","parentTaskId":"parent","completionLog":["day1"]}]}\r\n');
const originalB = Buffer.from("# 看板\r\n- [ ] 保留原字节\r\n");
function run(body: string, prefix = "") {
  return spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "-e", `${prefix}
    const { OfflineRecovery, revisionHash } = await import(${JSON.stringify(moduleUrl)});
    const fs = await import('node:fs/promises');
    const options = ${config};
    ${body}`], { encoding: "utf8", timeout: 10000 });
}
function assertSuccess(result: ReturnType<typeof run>): void {
  expect(result.error).toBeUndefined(); expect(result.stderr).toBe(""); expect(result.status).toBe(0);
}
async function unlockThen(body: string): Promise<void> {
  const lock = JSON.parse(await fs.readFile(join(backup, ".lock.json"), "utf8"));
  assertSuccess(run(`const recovery = new OfflineRecovery(options); await recovery.releaseStaleLock(${JSON.stringify(lock.token)}); ${body}`));
}
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "lifeops-recovery-process-")));
  vault = join(root, "vault"); backup = join(root, "backups");
  await fs.mkdir(vault); await fs.writeFile(join(vault, "a.json"), originalA); await fs.writeFile(join(vault, "b.md"), originalB);
  config = JSON.stringify({ vaultRoot: vault, backupRoot: backup, allowedPaths: ["a.json", "b.md", "c.json"] });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const changes = `[
  { path: 'a.json', expectedHash: revisionHash(await fs.readFile(options.vaultRoot+'/a.json')), after: Buffer.from('{"tasks":[{"id":"stable-task","migration":"synthetic-v1"}]}') },
  { path: 'b.md', expectedHash: revisionHash(await fs.readFile(options.vaultRoot+'/b.md')), after: null },
  { path: 'c.json', expectedHash: null, after: Buffer.from('{"created":true}') }
]`;

describe("offline recovery across actual process termination", () => {
  it.each(["prepared", "after-write"])("recovers a SIGKILL at %s in a new process, without a Provider", async (stage) => {
    const result = run(`options.onStep = e => { if (e.stage === ${JSON.stringify(stage)}) process.kill(process.pid, 'SIGKILL'); };
      await new OfflineRecovery(options).apply('interrupted', 'synthetic-v1', ${changes});`);
    expect(result.signal).toBe("SIGKILL");
    const plan = JSON.parse(await fs.readFile(join(backup, "interrupted", "plan.json"), "utf8"));
    expect(plan.changes).toHaveLength(3); // All original bytes were frozen before any write.
    expect(Buffer.from(plan.changes[1].before.data, "base64")).toEqual(originalB);
    await unlockThen("await recovery.recover('interrupted');");
    expect(await fs.readFile(join(vault, "a.json"))).toEqual(originalA);
    expect(await fs.readFile(join(vault, "b.md"))).toEqual(originalB);
    await expect(fs.access(join(vault, "c.json"))).rejects.toThrow();
    assertSuccess(run("await new OfflineRecovery(options).recover('interrupted');"));
  });

  it("can be killed during recovery and safely recovered by a third process", async () => {
    assertSuccess(run(`await new OfflineRecovery(options).apply('applied', 'synthetic-v1', ${changes});`));
    const crash = run(`options.onStep = e => { if (e.stage === 'after-restore') process.kill(process.pid, 'SIGKILL'); };
      await new OfflineRecovery(options).recover('applied');`);
    expect(crash.signal).toBe("SIGKILL");
    await unlockThen("await recovery.recover('applied');");
    expect(await fs.readFile(join(vault, "a.json"))).toEqual(originalA);
    expect(await fs.readFile(join(vault, "b.md"))).toEqual(originalB);
    await expect(fs.access(join(vault, "c.json"))).rejects.toThrow();
  });

  it("publishes a complete recoverable lock even when killed before unlinking its staging link", async () => {
    const prefix = `import promises from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module';
      const originalUnlink = promises.unlink;
      promises.unlink = async (path, ...args) => {
        if (String(path).includes('.lock-payload-')) process.kill(process.pid, 'SIGKILL');
        return originalUnlink(path, ...args);
      }; syncBuiltinESMExports();`;
    const result = run("await new OfflineRecovery(options).snapshot('lock-window');", prefix);
    expect(result.signal).toBe("SIGKILL");
    const lockPath = join(backup, ".lock.json");
    expect((await fs.stat(lockPath)).nlink).toBe(2);
    expect(JSON.parse(await fs.readFile(lockPath, "utf8")).token).toMatch(/^[a-f0-9-]{36}$/);
    await unlockThen("await recovery.snapshot('lock-window');");
    expect(await fs.readFile(join(vault, "a.json"))).toEqual(originalA);
  });

  it("refuses recovery on a later human edit and preserves all files", async () => {
    const crash = run(`options.onStep = e => { if (e.stage === 'after-write' && e.path === 'b.md') process.kill(process.pid, 'SIGKILL'); };
      await new OfflineRecovery(options).apply('conflicted', 'synthetic-v1', ${changes});`);
    expect(crash.signal).toBe("SIGKILL");
    const changedA = await fs.readFile(join(vault, "a.json"));
    await fs.writeFile(join(vault, "b.md"), "later human edit");
    await unlockThen(`try { await recovery.recover('conflicted'); process.exit(4); } catch(e) { if(e.code !== 'recovery_required') throw e; }`);
    expect(await fs.readFile(join(vault, "a.json"))).toEqual(changedA);
    expect(await fs.readFile(join(vault, "b.md"), "utf8")).toBe("later human edit");
  });
});
