import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
// @ts-expect-error The pure fixture helper does not launch a native app.
import { nativeFixtureSeed } from "../scripts/eval/native-fixture.mjs";

it("accepts the tracked older fixture without enabling any provider or external vault", () => {
  const source = JSON.parse(readFileSync("fixtures/test-vault/.obsidian/plugins/lifeops-assistant/data.json", "utf8"));
  const seed = nativeFixtureSeed(source);
  expect(seed.externalVaults).toEqual([]); expect(seed.proactive.enabled).toBe(false);
  expect(["ai", "embedding", "vision", "voice", "realtimeVoice"].every(name => seed[name].provider === "off")).toBe(true);
  expect(source.externalVaults).toBeUndefined();
});
it("refuses configured providers or external sources in a remote native fixture", () => {
  const source = JSON.parse(readFileSync("fixtures/test-vault/.obsidian/plugins/lifeops-assistant/data.json", "utf8"));
  expect(() => nativeFixtureSeed({ ...source, ai: { provider: "custom" } })).toThrow("real provider");
  expect(() => nativeFixtureSeed({ ...source, externalVaults: [{ path: "fictional-forbidden" }] })).toThrow("external vault");
});
