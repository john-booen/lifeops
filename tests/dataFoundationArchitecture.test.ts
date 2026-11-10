import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(resolve(testDir, "../src/main.ts"), "utf8");
const agentSource = readFileSync(resolve(testDir, "../src/agent/service.ts"), "utf8");
const sourceSlice = readFileSync(resolve(testDir, "../src/store/sourceSlice.ts"), "utf8");
const agentSlice = readFileSync(resolve(testDir, "../src/store/agentSlice.ts"), "utf8");

describe("data foundation architecture", () => {
  it("listens for every Vault source lifecycle event after layout is ready", () => {
    expect(mainSource).toContain("onLayoutReady");
    expect(mainSource).toContain('this.app.vault.on("create"');
    expect(mainSource).toContain('this.app.vault.on("modify"');
    expect(mainSource).toContain('this.app.vault.on("delete"');
    expect(mainSource).toContain('this.app.vault.on("rename"');
  });

  it("updates changed sources incrementally and invalidates stale vectors", () => {
    expect(sourceSlice).toContain("sourceNeedsProcessing");
    expect(sourceSlice).toContain("upsertVaultSourceInternal");
    expect(sourceSlice).toContain("removeVectorSource");
    expect(sourceSlice).toContain("sourceQueues");
    expect(sourceSlice).toContain("deriveSourceMemories");
    expect(sourceSlice).toContain("staleSourceMemories");
    expect(sourceSlice).not.toContain("rebuildKnowledgeStructure(");
  });

  it("uses incremental source synchronization instead of a full rebuild during retrieval", () => {
    const start = agentSlice.indexOf("async buildRetrievalContext");
    const end = agentSlice.indexOf("async buildSemanticContext", start);
    const body = agentSlice.slice(start, end);

    expect(agentSlice).toContain("async searchKnowledge");
    expect(agentSlice).toContain("syncVaultSources");
    expect(body).toContain("knowledgeResultsToMarkdown");
    expect(body).not.toContain("rebuildVaultIndex");
  });


  it("uses the generic Vault query tool instead of a phrase-specific journal patch", () => {
    const toolRegistry = readFileSync(resolve(testDir, "../src/toolRegistry.ts"), "utf8");
    const vaultQuery = readFileSync(resolve(testDir, "../src/vaultQuery.ts"), "utf8");
    expect(toolRegistry).toContain('name: "query_vault"');
    expect(vaultQuery).toContain("findLatestJournalFiles");
    expect(mainSource).not.toContain("isLatestJournalRequest(message)");
  });

  it("keeps confirmed task creation on the verified Agent Runtime path", () => {
    const start = agentSource.indexOf("export async function executeAgentAction");
    const end = agentSource.indexOf("export function finiteProviderRevision", start);
    const body = agentSource.slice(start, end);

    expect(body).toContain('toolName: "create_task"');
    expect(body).toContain("createAgentRuntime");
    expect(body).not.toContain("createTaskFromAgentAction");
  });

  it("routes confirmed linked-note writes through Agent Runtime", () => {
    const start = agentSource.indexOf("export async function executeAgentAction");
    const end = agentSource.indexOf("export function finiteProviderRevision", start);
    const body = agentSource.slice(start, end);

    expect(body).toContain('toolName: "append_knowledge_note"');
    expect(body).toContain('toolName: "append_trading_model_note"');
    expect(body).not.toContain("this.store.appendKnowledgeNote");
    expect(body).not.toContain("this.store.appendTradingModelNote");
  });

  it("keeps Tingwu/OSS and sensitive Vault paths outside the 0.2 Provider path", () => {
    const aiSource = readFileSync(resolve(testDir, "../src/ai.ts"), "utf8");
    const settingsSource = readFileSync(resolve(testDir, "../src/settingsTab.ts"), "utf8");
    expect(aiSource).not.toContain('from "./tingwu"');
    expect(settingsSource).not.toContain('.addOption("aliyun-tingwu"');
    expect(sourceSlice).toContain("isVaultPathExcluded");
  });

  it("routes confirmed screenshot reports through the audited action runtime", () => {
    const start = agentSource.indexOf("export async function executeAgentAction");
    const end = agentSource.indexOf("export function finiteProviderRevision", start);
    const body = agentSource.slice(start, end);

    expect(body).toContain("runConfirmedToolAction");
    expect(body).not.toContain("screenshot-analysis.md");
    expect(body).not.toContain("captureScreenshotAnalysis();");
  });
});
