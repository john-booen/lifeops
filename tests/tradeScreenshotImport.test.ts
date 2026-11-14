import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { setProviderEgressSink } from "../src/privacy";
import { confirmTradeScreenshot, parseTradeScreenshotRows, previewTradeScreenshot, readTradeScreenshot } from "../src/features/trading/screenshotImport";
import { recognizeTradeScreenshot } from "../src/features/trading/screenshotVision";
import { readTradeDatabase } from "../src/features/trading/persistence";
import type { StoreHost } from "../src/store/settingsSlice";
import type { LocalOperationHost } from "../src/features/serviceHost";
import { createFsApp } from "./helpers/fsApp";

vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { AgentRuntime } = await import("../src/agentRuntime");
const { LifeOpsStore } = await import("../src/store");

const cases = {
  "equity-match": { symbol: "FICT-A", market: "us-stock", direction: "long", openedAt: "2026-10-12T09:30:00-04:00",
    openClockShown: true, openedZone: "-04:00", closedAt: "2026-10-12T15:30:00-04:00", closedZone: "-04:00",
    qty: 10, qtyUnit: "shares", entry: 100, exit: 110, fees: 2.5, displayedPnl: 97.5, currency: "USD" },
  "futures-mismatch": { symbol: "FICT-F", market: "futures", direction: "short", openedAt: "2026-10-13T09:30:00+08:00",
    openClockShown: true, openedZone: "+08:00", closedAt: "2026-10-13T10:05:00+08:00", closedZone: "+08:00",
    qty: 2, qtyUnit: "contracts", entry: 250, exit: 245, fees: 3, displayedPnl: 94, currency: "CNY" },
  "forex-missing-zone": { symbol: "FICT-FX", market: "forex", direction: "short", openedAt: "2026-10-14T11:15:00Z",
    openClockShown: true, openedZone: null,
    qty: 1000, qtyUnit: "units", entry: 1.2, exit: 1.19, fees: 1.2, displayedPnl: 8.8, currency: "USD" },
  "crypto-open": { symbol: "FICT-COIN", market: "crypto", direction: "long", openedAt: "2026-10-15T21:10:00Z",
    openClockShown: true, openedZone: "+00:00", qty: 0.5, qtyUnit: "coin", entry: 50, exit: null, displayedPnl: null, currency: "USD" }
};
type CaseName = keyof typeof cases;
const readFixture = async (name: CaseName) => readTradeScreenshot(await readFile(join("tests/fixtures/trade-screenshots", name + ".png")));
const settings = () => {
  const selected = structuredClone(DEFAULT_SETTINGS);
  selected.vision = { ...selected.vision, provider: "openai-compatible", endpoint: "https://example.invalid/v1/chat/completions",
    model: "fixture-vision", apiKey: "fictional-vision-key", tradeScreenshotDisclosureAccepted: true };
  selected.privacy = { excludedVaultPrefixes: [], plaintextCredentialStorageAccepted: true };
  selected.tradingContractMultipliers = { "FICT-F": 10 };
  return selected;
};

afterEach(() => { vi.unstubAllGlobals(); setProviderEgressSink(null); });

it.each([
  ["equity-match", { kind: "ready", computedPnl: 97.5, screenshotPnl: 97.5, mismatch: false }],
  ["futures-mismatch", { kind: "ready", computedPnl: 97, screenshotPnl: 94, mismatch: true }],
  ["forex-missing-zone", { kind: "invalid", reason: expect.stringContaining("时区") }],
  ["crypto-open", { kind: "ready", computedPnl: undefined, screenshotPnl: undefined, mismatch: false }]
] as const)("validates %s through the image provider and confirmation preview", async (name, expected) => {
  const image = await readFixture(name);
  const config = settings();
  const fetchMock = vi.fn(async (_url: string, request: RequestInit) => {
    expect(request.redirect).toBe("error");
    const body = JSON.parse(String(request.body));
    expect(body.messages[0].content[1].image_url.url).toBe("data:image/png;base64," + image.bytes.toString("base64"));
    expect(String(request.body)).not.toContain("fixtures/trade-screenshots");
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: {
      content: JSON.stringify({ rows: [cases[name]] })
    } }] }));
  });
  vi.stubGlobal("fetch", fetchMock);
  const audit: unknown[] = [];
  setProviderEgressSink(record => { audit.push(record); });
  const rows = await recognizeTradeScreenshot(config, image);
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(previewTradeScreenshot(rows, image.digest, [], config.tradingContractMultipliers).rows[0]).toMatchObject(expected);
  expect(audit).toEqual([expect.objectContaining({ capability: "vision", purpose: "trade_screenshot", sourceCount: 1, contentLogged: false })]);
  expect(JSON.stringify(audit)).not.toMatch(/fictional-vision-key|base64|FICT-/u);
});

it("does not send an image without the screenshot-specific opt-in or after cancellation", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const image = await readFixture("equity-match");
  const configured = settings();
  configured.vision.tradeScreenshotDisclosureAccepted = false;
  configured.vision.remoteDataDisclosureAccepted = true;
  await expect(recognizeTradeScreenshot(configured, image)).rejects.toThrow("请先确认");
  await expect(recognizeTradeScreenshot(settings(), image, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
  expect(fetchMock).not.toHaveBeenCalled();
});

it("writes only the selected rows on explicit confirmation, prevents repeat imports and supports undo", async () => {
  const root = await mkdtemp(join(tmpdir(), "lifeops-trade-screenshot-"));
  try {
    const store = new LifeOpsStore(createFsApp(root), settings()) as unknown as StoreHost;
    await store.initializeVault();
    const runtime = new AgentRuntime({ store, refreshViews: async () => {} });
    let operationId: string | undefined;
    const host: LocalOperationHost = {
      async saveLocalOperation(name, args, execute, options) {
        const result = await runtime.executeLocalOperation(name, args, execute, undefined, options);
        if (!result.success) throw Error(result.output);
        operationId = result.callId;
      },
      refreshViews: async () => {}
    };
    const screenshot = await readFixture("futures-mismatch");
    const rows = parseTradeScreenshotRows(JSON.stringify({ rows: [cases["futures-mismatch"], cases["equity-match"]] }));
    const preview = previewTradeScreenshot(rows, screenshot.digest, [], store.settings.tradingContractMultipliers);
    expect((await readTradeDatabase(store)).trades).toEqual([]);
    await expect(confirmTradeScreenshot(host, rows, screenshot.digest, preview, [], () => {})).rejects.toThrow("请选择");
    expect(await confirmTradeScreenshot(host, rows, screenshot.digest, preview, [1], () => {})).toBe(1);
    const { trades } = await readTradeDatabase(store);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ symbol: "FICT-F", pnl: 97, pnlSource: "computed", notes: expect.stringContaining("94 CNY"),
      source: { kind: "form", ref: "trade-screenshot:" + screenshot.digest } });
    expect(previewTradeScreenshot(rows, screenshot.digest, trades, store.settings.tradingContractMultipliers).rows[0].kind).toBe("duplicate");
    await expect(confirmTradeScreenshot(host, rows, screenshot.digest, preview, [1], () => {})).rejects.toThrow("已经变化");
    expect(await runtime.undoLatestOperation()).toBe(operationId);
    expect((await readTradeDatabase(store)).trades).toEqual([]);

    const openPosition = await readFixture("crypto-open");
    const unverifiedRows = parseTradeScreenshotRows(JSON.stringify({
      rows: [{ ...cases["crypto-open"], displayedPnl: 12.5 }]
    }));
    const unverified = previewTradeScreenshot(unverifiedRows, openPosition.digest, []);
    expect(unverified.rows[0]).toMatchObject({ kind: "ready", screenshotPnl: 12.5, computedPnl: undefined });
    expect(await confirmTradeScreenshot(host, unverifiedRows, openPosition.digest, unverified, [1], () => {})).toBe(1);
    const persisted = (await readTradeDatabase(store)).trades;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ symbol: "FICT-COIN", pnlSource: "unknown", notes: expect.stringContaining("12.5 USD") });
    expect(persisted[0].pnl).toBeUndefined();
    expect(await runtime.undoLatestOperation()).toBe(operationId);
    expect((await readTradeDatabase(store)).trades).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
