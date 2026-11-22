import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { ChatMessage } from "../src/ai";
import type { ProviderRequestOptions } from "../src/types";
import type { StoreHost } from "../src/store/settingsSlice";
import type { SummaryHost } from "../src/features/summaries/service";
import { createPersonalMemory, emptyPersonalMemoryDocument, reviewPersonalMemoryRecord } from "../src/personalMemory";

vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, TFolder: class {}, Modal: class {}, Notice: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/"), parseYaml: JSON.parse, stringifyYaml: JSON.stringify }));
const { LifeOpsStore } = await import("../src/store");
const { AgentRuntime } = await import("../src/agentRuntime");
const { DiskVault } = await import("./helpers/diskVault");
const { generatePeriodSummary } = await import("../src/features/summaries/service");
const { summaryPeriod } = await import("../src/features/summaries/periods");
const { readSummary, readSummaryScope } = await import("../src/features/summaries/notes");
const date = "2026-02-04", now = new Date("2026-02-05T08:00:00+08:00");
const heading = "## 当天对话原话（未整理）";
const tentative = "我在考虑也许每天整理一张紫色纸片，但还没有决定，先别排进任务。";
const decided = "我已经决定明天15:00核对青色纸盒清单，也还没有做。";
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, host: SummaryHost;
const ask = vi.fn(async (_messages: ChatMessage[], options: ProviderRequestOptions) => {
  await options.beforeTextRequest?.(); return "格式不合格的模型文字，不是用户原话。";
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-summary-fallback-conversation-")); vault = new DiskVault(root);
  const settings = structuredClone(DEFAULT_SETTINGS);
  Object.assign(settings.ai, { provider: "custom", endpoint: "https://synthetic.invalid", model: "synthetic", dataDisclosureAccepted: true });
  const app = { vault } as unknown as App; store = new LifeOpsStore(app, settings) as unknown as StoreHost;
  await store.initializeVault(); ask.mockClear();
  const runtime = new AgentRuntime({ store, refreshViews: async () => undefined });
  host = { store, app, register() {}, unloaded: false, refreshViews: async () => undefined,
    async saveLocalOperation(name, args, run, options) {
      const result = await runtime.executeLocalOperation(name, args, run, undefined, options);
      if (!result.success) throw Error(result.output);
    },
    withAiFallback: (action, _fallback, options) => action(options ?? {}),
    observeProvider: (_stage, _source, action, signal) => action({ signal }, store as unknown as InstanceType<typeof LifeOpsStore>, { generateSummary: ask } as never,
      () => signal?.throwIfAborted(), () => undefined)
  } as SummaryHost;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const conversationPath = () => store.path(store.settings.folders.aiReports, "Conversations", date + ".md");
async function original(message: string, day = date) { await store.appendAgentConversation(message, "虚构助手说已做完，不能当作用户原话。", day); }
function offline() { host.withAiFallback = async (_action, fallback, options) => { options?.onLocalFallback?.("unavailable"); return fallback; }; }
async function generate() {
  await generatePeriodSummary(host, summaryPeriod("day", date), now);
  return (await readSummary(store, summaryPeriod("day", date), (await readSummaryScope(store)).hash))!;
}

it("keeps tentative and decided user statements as literal original excerpts after model format failure", async () => {
  await original(tentative); await original(decided);
  const raw = await vault.bytes(conversationPath()), tasks = await store.readTaskDb({ readOnly: true });
  const note = await generate();
  expect(note.properties.generatedBy).toBe("local"); expect(ask).toHaveBeenCalledTimes(2);
  expect(note.text).toContain(heading); expect(note.text).toContain(tentative); expect(note.text).toContain(decided);
  expect(note.text).not.toMatch(/格式不合格的模型文字|虚构助手说已做完/);
  expect(await vault.bytes(conversationPath())).toBe(raw); expect(await store.readTaskDb({ readOnly: true })).toEqual(tasks);
});

it("keeps only bounded recent same-day excerpts in an offline draft without interpreting Markdown", async () => {
  offline(); await original("虚构昨天不应出现", "2026-02-03"); await original("虚构最早一条不应出现");
  await original("虚构近期第一条"); await original("虚构近期第二条");
  await original("<script>虚构标签</script> ![[虚构附件]] [虚构链接](https://synthetic.invalid)\n" + "🟣".repeat(250));
  const note = await generate(); expect(ask).not.toHaveBeenCalled(); expect(note.text).toContain(heading);
  expect(note.text).toContain("虚构近期第一条"); expect(note.text).toContain("虚构近期第二条");
  expect(note.text).not.toMatch(/虚构昨天|虚构最早|<script>|!\[\[|\]\(https:/);
  expect(note.text).toContain("（节选）"); expect(note.text).not.toContain("🟣".repeat(241));
  expect(note.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
});

it("redacts configured credentials and forgotten statements before quoting a local draft", async () => {
  offline(); store.settings.ai.apiKey = "fictional-local-credential-not-real";
  const memory = createPersonalMemory({ kind: "core_profile", content: "虚构需要遗忘的旧纸片规则" });
  await vault.seed(store.personalMemoryPath(), JSON.stringify({ ...emptyPersonalMemoryDocument(),
    records: reviewPersonalMemoryRecord([memory], memory.id, { decision: "forget" }) }));
  await original(memory.content); await original("虚构配置值：fictional-local-credential-not-real"); await original(decided);
  const note = await generate(); expect(note.text).toContain(decided);
  expect(note.text).not.toMatch(/虚构需要遗忘的旧纸片规则|fictional-local-credential-not-real/);
});

it("does not quote excluded conversations, assistant replies or unextracted raw journals", async () => {
  offline(); await original(tentative);
  await vault.seed(store.path(store.settings.folders.dailyRoot, "2026", "02", date + "早.md"), "虚构未经提取的原日记不能被新出口复制。");
  store.settings.privacy = { ...store.settings.privacy, excludedVaultPrefixes: [conversationPath()] };
  const note = await generate(); expect(note.text).not.toContain(heading);
  expect(note.text).not.toMatch(/紫色纸片|虚构助手说|虚构未经提取/); expect(ask).not.toHaveBeenCalled();
});

it("keeps successful model summaries free of duplicate local excerpts", async () => {
  await original(tentative);
  ask.mockImplementationOnce(async (_messages, options) => { await options.beforeTextRequest?.(); return "虚构资料仅代表登记，明确决定和未决想法保持原意。".repeat(18); });
  const note = await generate(); expect(note.properties.generatedBy).toBe("model"); expect(note.text).not.toContain(heading);
});

it("rejects a fallback save when the original conversation changes while generating", async () => {
  await original(tentative);
  ask.mockImplementationOnce(async (_messages, options) => { await options.beforeTextRequest?.(); await original(decided); return "格式不合格"; });
  await expect(generate()).rejects.toThrow(/依据.*变化/);
  expect(await readSummary(store, summaryPeriod("day", date), (await readSummaryScope(store)).hash)).toBeUndefined();
  expect(await vault.bytes(conversationPath())).toContain(decided);
});
