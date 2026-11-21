import assert from "node:assert/strict";
import { constants } from "node:fs";
import { open, realpath, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { MOSS_TRIAL_ENDPOINT, MOSS_TRIAL_MODEL, readMossTrialFixture } from "./moss-live-fixture.mjs";

async function read(path, limit) {
  assert.equal(await realpath(path), path, "Synthetic input cannot use symbolic links");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const stat = await file.stat(); assert(stat.isFile() && stat.size <= limit, "Invalid synthetic input"); return await file.readFile(); }
  finally { await file.close(); }
}
const inside = (parent, path) => { const part = relative(parent, path); return part && !part.startsWith("..") && !isAbsolute(part); };

export async function prepareMossTrial(sourcePath, outputPath, syntheticOnly) {
  assert(syntheticOnly === true && isAbsolute(sourcePath) && isAbsolute(outputPath), "Explicit fictional synthetic inputs and absolute paths required");
  const source = await realpath(sourcePath), parent = await realpath(dirname(outputPath)), output = join(parent, basename(outputPath));
  const temporaryRoots = [await realpath(tmpdir())];
  try { temporaryRoots.push(await realpath("/tmp")); } catch { /* The system's tmpdir is sufficient on other platforms. */ }
  assert(temporaryRoots.some(root => inside(root, output)) && /^lifeops-moss-fictional-[a-zA-Z0-9-]+$/u.test(basename(output)), "Output must be a new named fictional directory under system temporary storage");
  assert(!inside(source, output) && source !== output, "Source and output must be separate");
  assert((await read(join(source, "TEST_VAULT_ONLY.md"), 8192)).toString("utf8").includes("内容全部为虚构数据"), "Fictional source marker required");
  const previous = JSON.parse((await read(join(source, "cases.json"), 64 * 1024)).toString("utf8"));
  const sourceCases = Array.isArray(previous) ? previous : previous.samples;
  assert(Array.isArray(sourceCases) && sourceCases.length >= 1 && sourceCases.length <= 4, "Use one to four fixed synthetic samples");
  const samples = [], audio = new Map(); let seconds = 0;
  const equivalentTimes = { "四点": ["四点", "4点", "16:00"], "九点十五分": ["九点十五分", "9点15分", "09:15", "9:15"] };
  for (const row of sourceCases) {
    assert(typeof row.id === "string" && /^[a-z][a-z0-9-]{0,39}$/u.test(row.id) && !audio.has(row.id), "Unique safe sample identity required");
    assert(typeof row.text === "string" && row.text.includes("虚构"), "Synthetic fictional speech text required");
    const bytes = await read(join(source, row.id + ".pcm"), 15 * 32000), hash = createHash("sha256").update(bytes).digest("hex");
    assert(bytes.length > 0 && bytes.length % 2 === 0 && hash === row.pcmSha256, "Synthetic PCM revision changed");
    seconds += bytes.length / 32000;
    const expectedAny = row.expectedAny ?? row.expected?.map(value => equivalentTimes[value] ?? [value]);
    assert(Array.isArray(expectedAny) && expectedAny.length > 0, "Expected recognition facts required");
    const replyMustNotInclude = row.replyMustNotInclude ?? (row.id === "correction" && row.text.includes("不是三点，改成四点") ? ["三点", "3点", "15:00"] : []);
    samples.push({ id: row.id, text: row.text, expectedAny, replyExpectedAny: row.replyExpectedAny ?? expectedAny,
      replyMustNotInclude, pcmSha256: hash, ...(row.after ? { after: row.after } : {}) }); audio.set(row.id, bytes);
  }
  assert(seconds <= 30, "Bounded comparison accepts at most thirty seconds of input");
  // mkdir without recursive is intentional: an existing target is never overwritten.
  await mkdir(output, { mode: 0o700 });
  await writeFile(join(output, "TEST_VAULT_ONLY.md"), "内容全部为虚构数据。仅复制明确标记的合成PCM，不录麦克风、不读私人记录。\n", { flag: "wx", mode: 0o600 });
  for (const [id, bytes] of audio) await writeFile(join(output, id + ".pcm"), bytes, { flag: "wx", mode: 0o600 });
  await writeFile(join(output, "cases.json"), JSON.stringify({ fictional: true, provenance: "synthetic-speech", format: "pcm16-16000-mono", samples }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const plugin = join(output, ".obsidian/plugins/lifeops-assistant"); await mkdir(plugin, { recursive: true, mode: 0o700 });
  const configFile = join(plugin, "data.json");
  await writeFile(configFile, JSON.stringify({ mossLiveTrial: { endpoint: MOSS_TRIAL_ENDPOINT, model: MOSS_TRIAL_MODEL,
    apiKey: "", syntheticAudioDisclosureAccepted: false, plaintextCredentialStorageAccepted: false,
    authorizationOrigin: "", maxSessionSeconds: 60 } }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const { preflight } = await readMossTrialFixture(output, configFile);
  return { fixture: output, configFile, ...preflight, sourceAudioUnchanged: true, providerRequests: 0 };
}

async function main() {
  const args = process.argv.slice(2);
  assert(args.length === 5 && args[0] === "--from" && args[2] === "--output" && args[4] === "--synthetic-only", "Use --from <fictional synthetic PCM fixture> --output <new temporary fictional directory> --synthetic-only");
  console.log(JSON.stringify(await prepareMossTrial(resolve(args[1]), resolve(args[3]), true)));
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(() => {
  console.error("Synthetic MOSS fixture preparation was rejected. Source and existing output files were not removed or overwritten."); process.exitCode = 1;
});
