/** Match the approved preview's object-fit: cover without stretching a frame. */
export function drawHomeMediaCover(
  context: Pick<CanvasRenderingContext2D, "clearRect" | "drawImage">,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number
): boolean {
  if (![sourceWidth, sourceHeight, width, height].every(value => Number.isFinite(value) && value > 0)) return false;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const cropWidth = width / scale, cropHeight = height / scale;
  if (![scale, cropWidth, cropHeight].every(value => Number.isFinite(value) && value > 0)) return false;
  context.clearRect(0, 0, width, height);
  context.drawImage(source, (sourceWidth - cropWidth) / 2, (sourceHeight - cropHeight) / 2,
    cropWidth, cropHeight, 0, 0, width, height);
  return true;
}
