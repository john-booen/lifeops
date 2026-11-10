import { describe, expect, it } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../src/defaults";
import {
  assertCredentialStorageAccepted,
  configuredCredentials,
  credentialStorageRiskMessage,
  redactSensitiveText,
  restrictCredentialFilePermissions
} from "../src/credentialSecurity";

describe("credential security", () => {
  it("requires explicit acceptance before a stored credential can be used", () => {
    expect(() => assertCredentialStorageAccepted(false, "secret-key")).toThrow("data.json");
    expect(() => assertCredentialStorageAccepted(false, "")).not.toThrow();
    expect(() => assertCredentialStorageAccepted(true, "secret-key")).not.toThrow();
    expect(credentialStorageRiskMessage()).toContain("备份或同步");
  });

  it("redacts configured keys and common authorization forms from errors", () => {
    const secret = "provider-secret-123456";
    const redacted = redactSensitiveText(
      `request failed apiKey=${secret} Authorization: Bearer abcdefghijklmnop sk-abcdefghijklmnop`,
      [secret]
    );

    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain("abcdefghijklmnop");
    expect(redacted).toContain("[REDACTED]");
  });

  it("collects configured credentials without duplicates or empty values", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.ai.apiKey = "same-key";
    settings.embedding.apiKey = "same-key";
    settings.realtimeVoice.apiKey = "voice-key";

    expect(configuredCredentials(settings)).toEqual(["same-key", "voice-key"]);
  });

  it("restricts plugin credential storage to the current operating-system user", async () => {
    const folder = await mkdtemp(join(tmpdir(), "lifeops-credential-test-"));
    const path = join(folder, "data.json");
    try {
      await writeFile(path, "{}", { mode: 0o644 });
      await restrictCredentialFilePermissions(path);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
