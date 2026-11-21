import assert from "node:assert/strict";

export function nativeFixtureSeed(value) {
  const seed = structuredClone(value);
  // Older tracked fixtures predate external-vault settings; the plugin also defaults this field to [].
  seed.externalVaults ??= [];
  for (const name of ["ai", "embedding", "vision", "voice", "realtimeVoice"]) {
    assert.equal(seed[name]?.provider, "off", "Native fixture must not contact a real provider");
  }
  assert(Array.isArray(seed.externalVaults) && seed.externalVaults.length === 0, "Native fixture must not read an external vault");
  seed.setupComplete = true;
  seed.proactive = { ...seed.proactive, enabled: false };
  seed.phoneInboxEnabled = false;
  return seed;
}
