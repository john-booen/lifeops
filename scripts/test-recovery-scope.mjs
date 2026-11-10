// This is a finite maintenance scope, not a whole-Vault backup policy.
// Keep it aligned with jsonDataGuard.ts and the default Store paths.
export const TEST_RECOVERY_SCOPE_ID = "test-vault-data-24-v1";

export const TEST_RECOVERY_PATHS = Object.freeze([
  "LifeOps/Goals/Tasks/LifeOps任务库.json",
  "LifeOps/Goals/Habits/LifeOps打卡库.json",
  "LifeOps/Output/AI/Index/source-manifest.json",
  "LifeOps/Output/AI/Index/lifeops-index.json",
  "LifeOps/Output/AI/Index/lifeops-vectors.json",
  "LifeOps/Output/AI/Knowledge/lifeops-chunks.json",
  "LifeOps/Output/AI/Knowledge/lifeops-knowledge-graph.json",
  "LifeOps/Output/AI/Knowledge/knowledge-links.json",
  "LifeOps/Output/AI/Knowledge/associations.json",
  "LifeOps/Output/AI/Memory/memory-index.json",
  "LifeOps/Output/AI/Memory/personal-memory.json",
  "LifeOps/Output/AI/Memory/personality-vector.json",
  "LifeOps/Output/AI/Situation/observations.json",
  "LifeOps/Output/AI/Proactive/policy-state.json",
  "LifeOps/Output/AI/Operations/operation-ledger.json",
  "LifeOps/Output/AI/Vision/visual-state.json",
  "LifeOps/Output/AI/Desktop/desktop-state.json",
  "LifeOps/Goals/Tasks/任务看板.md",
  "LifeOps/Goals/Habits/打卡看板.md",
  "LifeOps/Output/AI/Quality/quality-log.jsonl",
  "LifeOps/Output/AI/Quality/provider-egress.jsonl",
  "LifeOps/Output/AI/Quality/voice-metrics.jsonl",
  "LifeOps/Output/AI/Proactive/candidates.jsonl",
  "LifeOps/Output/AI/Proactive/feedback-audit.jsonl"
]);

export const TEST_RECOVERY_SCOPE = Object.freeze({
  id: TEST_RECOVERY_SCOPE_ID,
  vault: "test-vault",
  backup: ".lifeops-test-backups",
  paths: TEST_RECOVERY_PATHS,
  excluded: Object.freeze([
    ".obsidian/ (settings, credentials and plugin artifacts)",
    "TEST_VAULT_ONLY.md and TEST_VAULT_INFO.json",
    "Diary, knowledge, goal, trading and health source notes",
    "Memory Markdown and Memory/conversation-memory.jsonl",
    "Attachments, media and every path not explicitly listed"
  ]),
  vaultClosed: "Operator declaration only; no application-state detection",
  guide: "docs/DATA_RECOVERY_GUIDE.md"
});
