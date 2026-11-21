import assert from "node:assert/strict";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

export const MOSS_TRIAL_ENDPOINT = "wss://api.mosi.cn/v1/realtime";
export const MOSS_TRIAL_MODEL = "moss-live-1.0-2026-11-02";

async function regular(path, limit) {
  assert.equal(await realpath(path), path, "Trial files cannot use symbolic links");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat(); assert(stat.isFile() && stat.size <= limit, "Invalid trial file size or type");
    return await file.readFile();
  } finally { await file.close(); }
}

/** No provider can be contacted before all audio hashes and both consent flags are checked. */
export async function readMossTrialFixture(fixture, configFile) {
  assert(isAbsolute(fixture) && isAbsolute(configFile), "Explicit absolute trial paths required");
  const root = resolve(fixture); assert.equal(await realpath(root), root, "Trial root cannot use symbolic links");
  assert((await regular(join(root, "TEST_VAULT_ONLY.md"), 8192)).toString("utf8").includes("内容全部为虚构数据"), "Fictional vault marker required");
  const settingsFile = join(root, ".obsidian/plugins/lifeops-assistant/data.json");
  assert.equal(resolve(configFile), settingsFile, "Credentials must stay in this fictional vault's plugin settings");
  const settings = JSON.parse((await regular(settingsFile, 256 * 1024)).toString("utf8")), config = settings.mossLiveTrial;
  assert(config && typeof config === "object", "Dedicated MOSS trial configuration required");
  assert.equal(config.endpoint, MOSS_TRIAL_ENDPOINT, "Only the official MOSS trial endpoint is supported");
  assert(["moss-live-1.0", MOSS_TRIAL_MODEL].includes(config.model), "Unsupported MOSS trial model");
  assert(typeof config.apiKey === "string" && config.apiKey.length <= 2048 && !/[\r\n]/u.test(config.apiKey), "Invalid trial credential");
  const maxSessionSeconds = config.maxSessionSeconds ?? 60;
  assert(Number.isInteger(maxSessionSeconds) && maxSessionSeconds >= 15 && maxSessionSeconds <= 90, "Trial session must be limited to 15–90 seconds");
  const manifest = JSON.parse((await regular(join(root, "cases.json"), 64 * 1024)).toString("utf8"));
  assert(manifest.fictional === true && manifest.provenance === "synthetic-speech" && manifest.format === "pcm16-16000-mono", "Synthetic PCM provenance required");
  assert(Array.isArray(manifest.samples) && manifest.samples.length >= 1 && manifest.samples.length <= 4, "Use one to four bounded speech samples");
  const samples = [], ids = new Set(); let seconds = 0;
  for (const row of manifest.samples) {
    assert(typeof row.id === "string" && /^[a-z][a-z0-9-]{0,39}$/u.test(row.id) && !ids.has(row.id), "Unique safe sample identity required"); ids.add(row.id);
    assert(typeof row.text === "string" && row.text.includes("虚构") && row.text.length <= 500, "Fictional speech text required");
    assert(row.after === undefined || row.after === "reply_audio", "Unsupported sample scheduling");
    assert(samples.length > 0 || row.after === undefined, "The first sample cannot wait for a prior reply");
    assert(Array.isArray(row.expectedAny) && row.expectedAny.length >= 1 && row.expectedAny.length <= 4
      && row.expectedAny.every(group => Array.isArray(group) && group.length >= 1 && group.length <= 6
        && group.every(value => typeof value === "string" && value.length > 0 && value.length <= 100)), "Explicit recognition alternatives required");
    assert(typeof row.pcmSha256 === "string" && /^[a-f0-9]{64}$/u.test(row.pcmSha256), "PCM revision required");
    const pcm = await regular(join(root, row.id + ".pcm"), 15 * 32_000);
    assert(pcm.length > 0 && pcm.length % 2 === 0, "Invalid input PCM size");
    assert.equal(createHash("sha256").update(pcm).digest("hex"), row.pcmSha256, "PCM revision changed");
    const duration = pcm.length / 32_000; seconds += duration;
    const replyExpectedAny = row.replyExpectedAny ?? row.expectedAny, replyMustNotInclude = row.replyMustNotInclude ?? [];
    assert(Array.isArray(replyExpectedAny) && replyExpectedAny.length >= 1 && replyExpectedAny.length <= 4
      && replyExpectedAny.every(group => Array.isArray(group) && group.length >= 1 && group.length <= 6
        && group.every(value => typeof value === "string" && value.length > 0 && value.length <= 100)), "Explicit reply facts required");
    assert(Array.isArray(replyMustNotInclude) && replyMustNotInclude.length <= 8
      && replyMustNotInclude.every(value => typeof value === "string" && value.length > 0 && value.length <= 100), "Invalid obsolete reply values");
    samples.push({ id: row.id, text: row.text, expectedAny: row.expectedAny, replyExpectedAny, replyMustNotInclude,
      after: row.after, pcmSha256: row.pcmSha256, seconds: duration, pcm });
  }
  assert(seconds <= 30, "Trial input cannot exceed thirty seconds");
  const missing = [];
  if (!config.apiKey.trim()) missing.push("moss_api_key");
  if (config.syntheticAudioDisclosureAccepted !== true) missing.push("synthetic_audio_disclosure");
  if (config.plaintextCredentialStorageAccepted !== true) missing.push("credential_storage_consent");
  if (config.authorizationOrigin !== "wss://api.mosi.cn") missing.push("moss_service_authorization");
  return { root, config: { ...config, maxSessionSeconds }, samples, preflight: {
    ready: missing.length === 0, missing, endpoint: MOSS_TRIAL_ENDPOINT, model: config.model,
    connectionsLimit: 1, maxSessionSeconds, inputSeconds: seconds,
    samples: samples.map(({ id, pcmSha256, seconds }) => ({ id, pcmSha256, seconds })),
    microphone: false, physicalPlayback: false, dailyVault: false, originalVault: false, toolWrites: false
  } };
}
