import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe("Gateway excluded from 0.2", () => {
  it.each(["", "synthetic-test-only"])("refuses direct startup before server creation, listening or Vault writes (secret=%j)", async secret => {
    const root = await mkdtemp(join(tmpdir(), "lifeops-gateway-excluded-")); roots.push(root);
    const guard = join(root, "guard.mjs");
    await writeFile(guard, `import http from 'node:http'; import net from 'node:net'; import fs from 'node:fs/promises';
const calls=[];
for(const [target,name] of [[http,'createServer'],[net.Server.prototype,'listen'],[fs,'mkdir'],[fs,'appendFile']]) target[name]=()=>{calls.push(name);throw new Error('Forbidden Gateway side effect: '+name)};
process.on('exit',()=>process.stdout.write(JSON.stringify({calls})));`);
    const child = spawnSync(process.execPath, ["--import", guard, resolve("gateway/server.mjs")], { encoding: "utf8", timeout: 5000, env: { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS, LIFEOPS_VAULT: root, LIFEOPS_GATEWAY_PORT: "0", LIFEOPS_SECRET: secret } });
    expect(child.error).toBeUndefined(); expect(child.status).not.toBe(0); expect(child.signal).toBeNull();
    expect(child.stderr).toContain("Gateway is Excluded from 0.2"); expect(JSON.parse(child.stdout)).toEqual({ calls: [] });
    expect(await readdir(root)).toEqual(["guard.mjs"]);
  });
  it("has no current server implementation or package entry", async () => {
    const server = await readFile("gateway/server.mjs", "utf8"), main = await readFile("src/main.ts", "utf8"), prepare = await readFile("scripts/prepare-plugin-package.mjs", "utf8");
    expect(server).not.toMatch(/createServer|\.listen\(|appendFile|LIFEOPS_SECRET/);
    expect(main).not.toMatch(/import[^\n]*gateway\/server|spawn[^\n]*gateway/);
    expect(prepare).not.toContain('"gateway/server.mjs"');
  });
});
