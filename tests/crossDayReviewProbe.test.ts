import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { AgentRuntime } from "../src/agentRuntime";
import { executeVaultQuery } from "../src/vaultQuery";
import type { StoreHost } from "../src/store/settingsSlice";

vi.mock("obsidian", () => ({
  App: class {}, Notice: class {}, TFile: class {}, TFolder: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/")
}));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");

let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: AgentRuntime;
const today = "2026-09-27", yesterday = "2026-09-26";
const journalText = "合成跨日记录：蓝色清单尚未核对，明早留出十分钟。";

beforeEach(async () => {
  vi.stubEnv("TZ", "Asia/Shanghai");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${today}T08:00:00+08:00`));
  root = await mkdtemp(join(tmpdir(), "lifeops-cross-day-review-"));
  vault = new DiskVault(root);
  store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  runtime = new AgentRuntime({ store, refreshViews: async () => undefined });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("cross-day source and date review using only a temporary synthetic Vault", () => {
  it("writes an explicitly dated yesterday journal to yesterday without falling back to today", async () => {
    const result = await runtime.executeToolCall({
      toolName: "append_journal_entry", callId: "synthetic-yesterday-journal", source: "kimi",
      userMessage: `请把这段保存到昨天的晚间日记：${journalText}`,
      arguments: { content: journalText, date: "昨天", period: "晚" }
    });
    expect(result.success).toBe(true);
    expect(await store.readPath(store.dailyNotePath(yesterday, "晚"))).toContain(journalText);
    expect(await store.readPath(store.dailyNotePath(today, "晚"))).not.toContain(journalText);
  });

  it("rejects a nonexistent calendar date instead of creating an unusable journal path", async () => {
    const result = await runtime.executeToolCall({
      toolName: "append_journal_entry", callId: "synthetic-invalid-date", source: "kimi",
      userMessage: `请把这段保存到晚间日记：${journalText}`,
      arguments: { content: journalText, date: "2026-02-30", period: "晚" }
    });
    expect(result.success).toBe(false);
    expect(vault.getMarkdownFiles().filter(file => file.path.startsWith(`${store.settings.folders.dailyRoot}/`))).toHaveLength(0);
  });

  it("returns yesterday evening when the requested date has both morning and evening notes", async () => {
    const morning = "合成晨间计划：今天先看绿色清单。";
    await vault.seed(store.dailyNotePath(yesterday, "早"), morning);
    await vault.seed(store.dailyNotePath(yesterday, "晚"), journalText);
    const result = await executeVaultQuery(store, { domain: "journal", operation: "get", date: yesterday, period: "晚", query: "晚间日记" });
    expect(result).toContain(journalText);
    expect(result).toContain(store.dailyNotePath(yesterday, "晚"));
    expect(result).not.toContain(morning);
  });

  it("returns both periods when a date-specific read does not choose a period", async () => {
    const morning = "合成晨间计划：今天先看绿色清单。";
    await vault.seed(store.dailyNotePath(yesterday, "早"), morning);
    await vault.seed(store.dailyNotePath(yesterday, "晚"), journalText);
    const result = await executeVaultQuery(store, { domain: "journal", operation: "get", date: yesterday, limit: 1 });
    expect(result).toContain(morning);
    expect(result).toContain(journalText);
    expect(result.match(/### Journal Source/g)).toHaveLength(2);
  });

  it("does not substitute a morning file for a missing evening record", async () => {
    await vault.seed(store.dailyNotePath(yesterday, "早"), "合成晨间计划。");
    const result = await executeVaultQuery(store, { domain: "journal", operation: "get", date: yesterday, period: "晚" });
    expect(result).toContain("没有找到");
    expect(result).not.toContain("合成晨间计划");
  });

  it("keeps legacy journals readable while clearly preserving their unknown period", async () => {
    const legacy = `${store.settings.folders.dailyRoot}/2026/09/${yesterday}.md`;
    await vault.seed(legacy, journalText);
    const result = await executeVaultQuery(store, { domain: "journal", operation: "get", date: yesterday, period: "晚" });
    expect(result).toContain(journalText);
    expect(result).toContain("原文件未标明早晚");
    expect(result).not.toContain("- period: 晚");
  });

  it("prefers exact period evidence when an unlabelled legacy note exists on the same date", async () => {
    const legacy = `${store.settings.folders.dailyRoot}/2026/09/${yesterday}.md`;
    await vault.seed(legacy, "合成未分时段记录。");
    await vault.seed(store.dailyNotePath(yesterday, "晚"), journalText);
    const result = await executeVaultQuery(store, { domain: "journal", operation: "get", date: yesterday, period: "晚" });
    expect(result).toContain(journalText);
    expect(result).not.toContain("合成未分时段记录");
  });

  it("preserves latest-one lookup when no date is provided", async () => {
    await vault.seed(store.dailyNotePath(yesterday, "晚"), journalText);
    await vault.seed(store.dailyNotePath(today, "早"), "合成今日晨间计划。");
    const result = await executeVaultQuery(store, { domain: "journal", operation: "get" });
    expect(result).toContain("合成今日晨间计划");
    expect(result).not.toContain(journalText);
    expect(result.match(/### Journal Source/g)).toHaveLength(1);
  });

  it("supports a latest evening lookup without accidentally selecting today's morning", async () => {
    await vault.seed(store.dailyNotePath(yesterday, "晚"), journalText);
    await vault.seed(store.dailyNotePath(today, "早"), "合成今日晨间计划。");
    const result = await executeVaultQuery(store, { domain: "journal", operation: "get", period: "晚" });
    expect(result).toContain(journalText);
    expect(result).not.toContain("合成今日晨间计划");
  });

  it("reads relative yesterday against the local date", async () => {
    await vault.seed(store.dailyNotePath(yesterday, "晚"), journalText);
    const result = await executeVaultQuery(store, { domain: "journal", operation: "get", date: "昨天", period: "晚" });
    expect(result).toContain(journalText);
    expect(result).toContain(`- date: ${yesterday}`);
  });

  it.each(["2026-02-30", "2026-13-01", "不确定的某天"])("rejects an invalid read date instead of falling back to latest: %s", async date => {
    await vault.seed(store.dailyNotePath(today, "早"), "合成今日晨间计划。");
    await expect(executeVaultQuery(store, { domain: "journal", operation: "get", date })).rejects.toThrow("日期无效");
  });

  it.each([
    ["2026-03-01", "2026-02-28"],
    ["2028-03-01", "2028-02-29"],
    ["2027-01-01", "2026-12-31"]
  ])("keeps yesterday on the correct calendar date across %s", async (now, previous) => {
    vi.setSystemTime(new Date(`${now}T00:05:00+08:00`));
    const written = await runtime.executeToolCall({
      toolName: "append_journal_entry", callId: "synthetic-calendar-boundary", source: "kimi",
      userMessage: `请把这段保存到昨天的晚间日记：${journalText}`,
      arguments: { content: journalText, date: "昨天", period: "晚" }
    });
    expect(written.success).toBe(true);
    expect(await store.readPath(store.dailyNotePath(previous, "晚"))).toContain(journalText);
    const read = await runtime.executeToolCall({
      toolName: "query_vault", callId: "synthetic-read-calendar-boundary", source: "kimi",
      arguments: { domain: "journal", operation: "get", date: "昨天", period: "晚" }
    });
    expect(read.success).toBe(true);
    expect(read.output).toContain(`- date: ${previous}`);
    expect(read.output).toContain(journalText);
    expect(await store.readPath(store.dailyNotePath(now, "晚"))).not.toContain(journalText);
  });

  it("passes an explicit period through the runtime tool boundary", async () => {
    await vault.seed(store.dailyNotePath(yesterday, "早"), "合成晨间计划。");
    await vault.seed(store.dailyNotePath(yesterday, "晚"), journalText);
    const result = await runtime.executeToolCall({
      toolName: "query_vault", callId: "synthetic-period-query", source: "kimi",
      arguments: { domain: "journal", operation: "get", date: "昨天", period: "晚" }
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain(journalText);
    expect(result.output).not.toContain("合成晨间计划");
  });

  it("discloses omitted same-day notes when the read reaches its source cap", async () => {
    for (let index = 0; index < 13; index += 1) {
      await vault.seed(`${store.settings.folders.dailyRoot}/2026/09/${yesterday}补记${index}.md`, `合成补记 ${index}`);
    }
    const result = await executeVaultQuery(store, { domain: "journal", operation: "get", date: yesterday });
    expect(result.match(/### Journal Source/g)).toHaveLength(12);
    expect(result).toContain("同日共匹配 13 篇");
    expect(result).toContain("不能将本次片段视为完整当日记录");
  });
});
