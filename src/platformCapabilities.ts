export interface PlatformCapabilityInput {
  isDesktopApp: boolean;
  platform: string;
  hasNodeRuntime: boolean;
  hasElectronBridge: boolean;
}

export interface PlatformCapabilities {
  desktopRuntime: boolean;
  macOS: boolean;
  coreVault: boolean;
  limitations: string[];
}

export function resolvePlatformCapabilities(input: PlatformCapabilityInput): PlatformCapabilities {
  const desktopRuntime = Boolean(input.isDesktopApp);
  const macOS = input.platform === "darwin";
  const coreVault = desktopRuntime;
  const limitations = [
    !desktopRuntime ? "LifeOps 0.2 仅支持 Obsidian Desktop，移动端不加载插件。" : "",
    desktopRuntime && !macOS ? "LifeOps 0.2 仅正式支持 macOS；核心 Vault 功能可用。" : "",
  ].filter(Boolean);

  return {
    desktopRuntime,
    macOS,
    coreVault,
    limitations
  };
}
