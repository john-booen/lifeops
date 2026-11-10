import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pcm16ToBase64 } from "../src/voice/voiceRealtime";

vi.mock("obsidian", () => ({ Notice: class {} }));
type Encoder = (this: Uint8Array, ...args: unknown[]) => string;
const descriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "toBase64");
const native = descriptor?.value as Encoder;
let btoa: ReturnType<typeof vi.fn>;
const install = (value: unknown) => Object.defineProperty(Uint8Array.prototype, "toBase64", {
  configurable: true, writable: true, value
});
const bytesFor = (pcm: Int16Array) => new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
const expectedFor = (pcm: Int16Array) => Buffer.from(bytesFor(pcm)).toString("base64");
const fixture = (length: number) => Int16Array.from({ length }, (_, i) => (i * 7919 + 32767) % 65536 - 32768);

beforeEach(() => {
  btoa = vi.fn((binary: string) => globalThis.btoa(binary));
  vi.stubGlobal("window", { btoa });
});
afterEach(() => {
  if (descriptor) Object.defineProperty(Uint8Array.prototype, "toBase64", descriptor);
  else Reflect.deleteProperty(Uint8Array.prototype, "toBase64");
  vi.unstubAllGlobals();
});

describe.each(["native", "fallback"] as const)("%s byte equivalence", route => {
  // The two large boundaries straddle the existing 0x8000-byte spread chunks.
  it.each([0, 1, 2, 3, 127, 128, 639, 640, 641, 16383, 16384, 16385])(
    "preserves %i PCM samples, standard alphabet, padding and input bytes", length => {
      if (route === "native") { expect(typeof native).toBe("function"); install(native); }
      else install(undefined);
      const pcm = fixture(length), before = [...pcm], expected = expectedFor(pcm);
      const actual = pcm16ToBase64(pcm);
      expect(actual).toBe(expected);
      expect([...Buffer.from(actual, "base64")]).toEqual([...bytesFor(pcm)]);
      expect(actual.length).toBe(4 * Math.ceil(pcm.byteLength / 3));
      expect([...pcm]).toEqual(before);
      expect(btoa).toHaveBeenCalledTimes(route === "fallback" ? 1 : 0);
    }
  );

  it("uses only a nonzero-offset subview, leaving outside sentinels unchanged", () => {
    install(route === "native" ? native : undefined);
    const parent = new Int16Array([2222, -1234, 32767, -32768, -1, 9876, 1111]);
    const pcm = parent.subarray(2, 5), before = [...parent];
    expect(pcm16ToBase64(pcm)).toBe(expectedFor(pcm));
    expect([...parent]).toEqual(before);
    expect(pcm16ToBase64(pcm)).not.toBe(expectedFor(parent));
  });

  it("keeps + / and both standard padding widths", () => {
    install(route === "native" ? native : undefined);
    const two = new Int16Array(1), four = new Int16Array(2);
    bytesFor(two).set([255, 255]); bytesFor(four).set([251, 255, 239, 255]);
    expect(pcm16ToBase64(two)).toBe("//8=");
    expect(pcm16ToBase64(four)).toBe("+//v/w==");
  });
});

it("calls the fast method once with the exact Uint8Array receiver and zero arguments", () => {
  const parent = fixture(10), pcm = parent.subarray(3, 7);
  const encode = vi.fn(function(this: Uint8Array, ...args: unknown[]) {
    expect(this).toBeInstanceOf(Uint8Array);
    expect(this.buffer).toBe(pcm.buffer);
    expect(this.byteOffset).toBe(pcm.byteOffset);
    expect(this.byteLength).toBe(pcm.byteLength);
    expect(args).toEqual([]);
    return native.call(this);
  });
  install(encode);
  expect(pcm16ToBase64(pcm)).toBe(expectedFor(pcm));
  expect(encode).toHaveBeenCalledOnce();
  expect(btoa).not.toHaveBeenCalled();
});

it("falls back when a present method is not callable", () => {
  install("unsupported");
  const pcm = fixture(640);
  expect(pcm16ToBase64(pcm)).toBe(expectedFor(pcm));
  expect(btoa).toHaveBeenCalledOnce();
});

it("preserves a callable fast method error without retrying the old encoder", () => {
  const failure = new TypeError("synthetic native failure");
  install(() => { throw failure; });
  expect(() => pcm16ToBase64(fixture(1))).toThrow(failure);
  expect(btoa).not.toHaveBeenCalled();
});

it("preserves the old encoder error on the fallback path", () => {
  const failure = new Error("synthetic btoa failure");
  install(undefined); btoa.mockImplementation(() => { throw failure; });
  expect(() => pcm16ToBase64(fixture(1))).toThrow(failure);
  expect(btoa).toHaveBeenCalledOnce();
});
