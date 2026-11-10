import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolvePlatformCapabilities } from "../src/platformCapabilities";

const testDir = dirname(fileURLToPath(import.meta.url));

describe("platform capabilities", () => {
  it("declares the plugin as desktop-only", () => {
    const manifest = JSON.parse(readFileSync(resolve(testDir, "../manifest.json"), "utf8"));
    expect(manifest.isDesktopOnly).toBe(true);
  });

  it("enables the macOS desktop core", () => {
    const capabilities = resolvePlatformCapabilities({
      isDesktopApp: true,
      platform: "darwin",
      hasNodeRuntime: true,
      hasElectronBridge: true
    });
    expect(capabilities).toMatchObject({
      coreVault: true
    });
    expect(capabilities.limitations).toEqual([]);
  });

  it("marks mobile as unsupported", () => {
    const capabilities = resolvePlatformCapabilities({
      isDesktopApp: false,
      platform: "ios",
      hasNodeRuntime: false,
      hasElectronBridge: false
    });
    expect(capabilities.coreVault).toBe(false);
    expect(capabilities.limitations[0]).toContain("移动端不加载插件");
  });
});
