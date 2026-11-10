import { describe, expect, it, vi } from "vitest";
import { drawHomeMediaCover } from "../src/panel/neuralHomeCanvas";

describe("home decoded frames preserve source proportions", () => {
  it.each([
    { source: [240, 180], target: [100, 100], crop: [30, 0, 180, 180] },
    { source: [180, 240], target: [100, 100], crop: [0, 30, 180, 180] },
    { source: [480, 480], target: [100, 100], crop: [0, 0, 480, 480] },
    { source: [240, 180], target: [200, 150], crop: [0, 0, 240, 180] },
    { source: [240, 180], target: [150, 100], crop: [0, 10, 240, 160] }
  ])("centers $source in $target without unequal scaling", ({ source, target, crop }) => {
    const context = { clearRect: vi.fn(), drawImage: vi.fn() }, frame = {} as CanvasImageSource;
    expect(drawHomeMediaCover(context, frame, source[0], source[1], target[0], target[1])).toBe(true);
    expect(context.clearRect).toHaveBeenCalledExactlyOnceWith(0, 0, ...target);
    expect(context.drawImage).toHaveBeenCalledExactlyOnceWith(frame, ...crop, 0, 0, ...target);
    const [x, y, width, height] = crop;
    expect(width / height).toBeCloseTo(target[0] / target[1]);
    expect(x + width / 2).toBeCloseTo(source[0] / 2);
    expect(y + height / 2).toBeCloseTo(source[1] / 2);
  });
  it.each([[0, 180, 100, 100], [240, 0, 100, 100], [240, 180, 0, 100], [240, 180, 100, Number.NaN]])(
    "leaves fallback untouched for unusable dimensions %j", (sourceWidth, sourceHeight, width, height) => {
      const context = { clearRect: vi.fn(), drawImage: vi.fn() };
      expect(drawHomeMediaCover(context, {} as CanvasImageSource, sourceWidth, sourceHeight, width, height)).toBe(false);
      expect(context.clearRect).not.toHaveBeenCalled(); expect(context.drawImage).not.toHaveBeenCalled();
    });
  it("does not clear the fallback when scaling would overflow", () => {
    const context = { clearRect: vi.fn(), drawImage: vi.fn() };
    expect(drawHomeMediaCover(context, {} as CanvasImageSource, Number.MIN_VALUE, 1, Number.MAX_VALUE, 100)).toBe(false);
    expect(context.clearRect).not.toHaveBeenCalled(); expect(context.drawImage).not.toHaveBeenCalled();
  });
  it("propagates draw failure to the existing motion owner's cleanup", () => {
    const failure = new Error("decoder draw failed"), context = { clearRect: vi.fn(), drawImage: vi.fn(() => { throw failure; }) };
    expect(() => drawHomeMediaCover(context, {} as CanvasImageSource, 240, 180, 100, 100)).toThrow(failure);
  });
});
