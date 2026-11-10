/** Obsidian renderer scripts cannot load the plugin's file: URLs. */
export function pluginAssetUrl(
  getResourcePath: (path: string) => string,
  pluginDir: string,
  relativePath: string
): string {
  if (!pluginDir || !relativePath || relativePath.startsWith("/") || relativePath.includes("\\")
    || relativePath.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("无法定位 LifeOps 插件本地资源目录");
  }
  const url = new URL(getResourcePath(`${pluginDir}/${relativePath}`));
  if (url.protocol !== "app:") throw new Error("本地识别资源需要 Obsidian 的资源接口");
  // MediaPipe appends /vision_*.js to this directory; a timestamp query here
  // would turn the appended filename into a query value rather than a path.
  if (relativePath === "mediapipe/wasm") { url.search = ""; url.hash = ""; }
  return url.href;
}
