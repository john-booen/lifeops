/** Explicit, local-only transport rehearsal. Never accepts an existing vault or starts a background service. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, stat, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";

export async function createTransportFixture(binary) {
  assert(isAbsolute(binary) && (await stat(binary)).isFile(), "Provide a previously verified Syncthing executable");
  const root = await mkdtemp(join(tmpdir(), "lifeops-sync-proof-"));
  const peers = [], folderId = "lifeops-fictional-transport-v1";
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  const result = { root, fixtureOnly: true, actualSecondMac: false, actualAndroid: false, privateVaultConnected: false,
    loopbackOnly: true, externalDiscovery: false, externalRelays: false, checks: {}, exits: [] };
  const version = spawnSync(binary, ["--version"], { encoding: "utf8" }); assert.equal(version.status, 0);
  result.transportVersion = version.stdout.trim(); result.executableSha256 = hash(await readFile(binary));
  await writeFile(join(root, "TEST_VAULT_ONLY.md"), "内容全部为虚构数据。\n");
  async function freePort() {
    const server = createServer();
    await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return port;
  }
  async function request(peer, path, method = "GET", value) {
    const response = await fetch(`http://127.0.0.1:${peer.gui}${path}`, { method,
      headers: { "X-API-Key": peer.apiKey, ...(value === undefined ? {} : { "Content-Type": "application/json" }) },
      body: value === undefined ? undefined : JSON.stringify(value), signal: AbortSignal.timeout(5000) });
    assert(response.ok, `Fixture API ${method} ${path}: HTTP ${response.status}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  async function waitFor(check, label, timeout = 40_000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (await check()) return;
      await setTimeout(200);
    }
    throw Error(`Fixture observation timed out: ${label}`);
  }
  async function bytes(peer, path) {
    try { return await readFile(join(peer.vault, path)); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  async function write(peer, path, content) {
    const parts = path.split("/");
    assert(!isAbsolute(path) && parts.every(part => part && part !== "." && part !== ".."), "Relative fixture path required");
    await mkdir(join(peer.vault, ...parts.slice(0, -1)), { recursive: true });
    await writeFile(join(peer.vault, path), content);
  }
  async function transferred(from, to, path) {
    const expected = await bytes(from, path); assert(expected, "Fixture source missing");
    const digest = hash(expected);
    await request(from, `/rest/db/scan?folder=${folderId}`, "POST");
    await waitFor(async () => {
      const found = await bytes(to, path);
      return found !== null && found.length === expected.length && hash(found) === digest;
    }, path);
    return digest;
  }
  async function prepare(name) {
    const home = join(root, name, "profile"), vault = join(root, name, "vault");
    await mkdir(home, { recursive: true }); await mkdir(vault);
    const generate = spawnSync(binary, ["generate", "--home", home, "--no-port-probing"], {
      encoding: "utf8", env: { ...process.env, STNODEFAULTFOLDER: "1", GOMAXPROCS: "2" } });
    assert.equal(generate.status, 0, "Fixture generation failed");
    let xml = await readFile(join(home, "config.xml"), "utf8");
    assert(!/<folder\s[^>]*path="[^"]+"/u.test(xml.split("<defaults>")[0]), "Unexpected default folder");
    const gui = await freePort(), listen = await freePort();
    xml = xml.replace(/name="[^"]*" compression="metadata"/u, `name="fictional-${name}" compression="metadata"`)
      .replace("<address>127.0.0.1:8384</address>", `<address>127.0.0.1:${gui}</address>`)
      .replace("<listenAddress>default</listenAddress>", `<listenAddress>tcp://127.0.0.1:${listen}</listenAddress>`);
    for (const tag of ["globalAnnounceEnabled", "localAnnounceEnabled", "relaysEnabled", "startBrowser", "natEnabled", "crashReportingEnabled", "announceLANAddresses"]) {
      xml = xml.replace(`<${tag}>true</${tag}>`, `<${tag}>false</${tag}>`);
    }
    xml = xml.replace("<urAccepted>0</urAccepted>", "<urAccepted>-1</urAccepted>")
      .replace("<autoUpgradeIntervalH>12</autoUpgradeIntervalH>", "<autoUpgradeIntervalH>0</autoUpgradeIntervalH>");
    const apiKey = xml.match(/<apikey>([^<]+)<\/apikey>/u)?.[1]; assert(apiKey);
    await writeFile(join(home, "config.xml"), xml, { mode: 0o600 });
    const peer = { name, home, vault, gui, listen, apiKey, process: null, exit: null }; peers.push(peer);
    await write(peer, "TEST_VAULT_ONLY.md", "内容全部为虚构数据。\n");
    await write(peer, ".stignore", "/.obsidian\n/.git\n/.trash\n.DS_Store\n");
    await write(peer, `.obsidian/${name}-settings.json`, `fictional-local-settings-${name}`);
    return peer;
  }
  async function start(peer) {
    assert(!peer.process || peer.process.exitCode !== null, "Previous fixture process has not exited");
    const fd = openSync(join(root, peer.name, "process.log"), "a", 0o600);
    peer.process = spawn(binary, ["serve", "--home", peer.home, "--no-browser", "--no-restart", "--no-upgrade", "--no-port-probing"], {
      env: { ...process.env, GOMAXPROCS: "2" }, stdio: ["ignore", fd, fd] }); closeSync(fd);
    peer.exit = new Promise((resolve, reject) => { peer.process.once("error", reject); peer.process.once("exit", (code, signal) => resolve({ name: peer.name, code, signal })); });
    await waitFor(async () => {
      assert(peer.process.exitCode === null, "Fixture process terminated during startup");
      try { const s = await request(peer, "/rest/system/status"); peer.deviceId = s.myID; return !!s.myID; }
      catch { return false; }
    }, "fixture daemon ready");
    const config = await request(peer, "/rest/config");
    assert(config.options.listenAddresses.length === 1 && config.options.listenAddresses[0] === `tcp://127.0.0.1:${peer.listen}`);
    assert(!config.options.globalAnnounceEnabled && !config.options.localAnnounceEnabled && !config.options.relaysEnabled && !config.options.natEnabled);
  }
  async function stop(peer) {
    if (!peer.process || peer.process.exitCode !== null || peer.process.signalCode !== null) return;
    await request(peer, "/rest/system/shutdown", "POST");
    const timer = new AbortController();
    let exit;
    // Multiple TLS connections can take ten seconds to drain. Leave a bounded margin for normal exit.
    try { exit = await Promise.race([peer.exit, setTimeout(20_000, undefined, { signal: timer.signal })
      .then(() => { throw Error("Fixture did not exit after shutdown"); })]); }
    finally { timer.abort(); }
    result.exits.push(exit); assert.equal(exit.code, 0);
  }
  async function configure(peer, other, { paused = false } = {}) {
    const config = await request(peer, "/rest/config"); assert.equal(config.folders.length, 0);
    await request(peer, "/rest/config/devices", "POST", { ...config.defaults.device, deviceID: other.deviceId,
      name: `fictional-${other.name}`, addresses: [`tcp://127.0.0.1:${other.listen}`], autoAcceptFolders: false, paused });
    const template = config.defaults.folder.devices[0] ?? {};
    await request(peer, "/rest/config/folders", "POST", { ...config.defaults.folder,
      id: folderId, label: "LifeOps fictional transport", path: peer.vault, type: "sendreceive",
      rescanIntervalS: 2, fsWatcherEnabled: true, fsWatcherDelayS: 1,
      devices: peers.map(p => ({ ...template, deviceID: p.deviceId })) });
    assert.equal((await request(peer, "/rest/config/restart-required")).requiresRestart, false);
  }
  async function finish() {
    const shutdowns = await Promise.allSettled(peers.map(stop));
    const failed = shutdowns.filter(r => r.status === "rejected");
    if (failed.length) { result.shutdownErrors = failed.map(r => r.reason.message); result.passed = false; }
    await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2) + "\n");
    if (failed.length) throw new AggregateError(failed.map(r => r.reason), "Fixture processes need attention");
    return result;
  }
  return { root, result, peers, prepare, start, stop, configure, transferred, request, waitFor, bytes, write, finish };
}

export async function runTransportRehearsal(binary) {
  const fixture = await createTransportFixture(binary);
  const { result, prepare, start, stop, configure, transferred, request, waitFor, bytes, write } = fixture;
  try {
    const a = await prepare("executor"), b = await prepare("companion");
    await start(a); await start(b); assert.notEqual(a.deviceId, b.deviceId);
    await configure(a, b); await configure(b, a);
    await waitFor(async () => (await request(a, "/rest/system/connections")).connections[b.deviceId]?.connected === true, "paired TLS connection");
    result.checks.explicitPeerPairing = true;
    const tasks = "记录/虚构任务.json", original = JSON.stringify({ version: 1, tasks: [{ id: "fictional-a", title: "整理虚构蓝纸" }] });
    await write(a, tasks, original); await transferred(a, b, tasks);
    const requestPath = `输入/设备随手记/${randomUUID()}/${randomUUID()}.json`;
    await write(b, requestPath, JSON.stringify({ text: "明天核对虚构纸盒", marker: "fictional-only" }));
    await transferred(b, a, requestPath); result.checks.bidirectionalRecordsAndInput = true;
    const large = "附件/虚构大附件.bin", data = Buffer.alloc(80 * 1024 * 1024, 0x5a);
    await write(a, large, data); result.checks.largeFile = { bytes: data.length, sha256: await transferred(a, b, large) };
    assert.equal(await bytes(b, ".obsidian/executor-settings.json"), null);
    assert.equal(await bytes(a, ".obsidian/companion-settings.json"), null);
    assert.equal((await bytes(a, ".obsidian/executor-settings.json")).toString(), "fictional-local-settings-executor");
    result.checks.settingsExcluded = true;
    await stop(b);
    const offline = `输入/设备随手记/${randomUUID()}/${randomUUID()}.json`;
    await write(b, offline, JSON.stringify({ recordedDate: "2066-01-02", text: "离线虚构输入，保留录入日期" }));
    const revised = JSON.stringify({ version: 2, tasks: [{ id: "fictional-a", title: "整理虚构蓝纸", complete: true }] });
    await write(a, tasks, revised); assert.equal((await bytes(b, tasks)).toString(), original); assert.equal(await bytes(a, offline), null);
    await start(b); await transferred(b, a, offline); await transferred(a, b, tasks); result.checks.offlineRestart = true;
    const another = `输入/设备随手记/${randomUUID()}/${randomUUID()}.json`;
    await write(a, another, "fictional distinct device input"); await transferred(a, b, another);
    assert.equal((await bytes(a, requestPath)).toString(), (await bytes(b, requestPath)).toString());
    const records = await readdir(join(a.vault, "输入/设备随手记")); assert.equal(records.length, 3);
    result.checks.immutableDistinctInputsRetained = true;
    result.passed = true;
  } catch (error) { result.error = error.message; throw error; }
  finally {
    await fixture.finish();
    console.log(JSON.stringify(result));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert(args.length === 2 && args[0] === "--binary" && isAbsolute(args[1]), "Usage: --binary ABSOLUTE_VERIFIED_SYNCTHING_BINARY");
  await runTransportRehearsal(args[1]);
}
