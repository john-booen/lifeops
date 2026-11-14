import { createHash } from "node:crypto";

export const SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG = Buffer.from([255, 216, 255]);

export interface ScreenshotImage {
  bytes: Buffer;
  mime: "image/png" | "image/jpeg";
  digest: string;
}

export function readScreenshotImage(input: ArrayBuffer | Uint8Array): ScreenshotImage {
  const bytes = input instanceof Uint8Array ? Buffer.from(input) : Buffer.from(new Uint8Array(input));
  if (!bytes.length || bytes.length > SCREENSHOT_MAX_BYTES) throw Error("截图大小须在 4 MB 以内，请裁剪后重试。");
  const mime = bytes.subarray(0, PNG.length).equals(PNG) ? "image/png"
    : bytes.subarray(0, JPEG.length).equals(JPEG) ? "image/jpeg" : undefined;
  if (!mime) throw Error("请选择 PNG 或 JPEG 格式的截图。");
  return { bytes, mime, digest: createHash("sha256").update(bytes).digest("hex") };
}

