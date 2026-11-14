import { assistantName } from "./assistantSettings";
import { summarizeTaskFacts, type InjectedContext, type TaskCompletionEvidence } from "./contextInjection";
import { AgentRuntime } from "./agentRuntime";
import { formatDate } from "./date";
import { inferExplicitPersonalMemory } from "./personalMemory";
import { assertCurrentWrite, type StoreHost } from "./store/settingsSlice";

export interface MemoryRecord {
  timestamp: string;
  type: "conversation_summary" | "task_pattern" | "user_state";
  content: string;
  userStatement?: string;
  assistantResponse?: string;
  metadata: Record<string, unknown>;
}

export interface UserTrends {
  consecutiveLateNights: number;
  activeTasks: number;
  overdueTasks: number;
  completionSignals: number;
  lateNightStatus: "unknown";
  taskEvidenceStatus: "available" | "partial" | "unknown";
  completionEvidence: TaskCompletionEvidence[];
  sourcePaths: string[];
  observedAt?: string;
}

export async function recordConversationMemory(
  store: StoreHost,
  userMessage: string,
  assistantReply: string,
  context: InjectedContext,
  isCurrent?: () => boolean
): Promise<void> {
  assertCurrentWrite(isCurrent);
  const captured = new Date();
  const localDate = formatDate(captured);
  const sourcePath = store.path(store.settings.folders.aiReports, "Conversations", `${localDate}.md`);
  const record: MemoryRecord = {
    timestamp: captured.toISOString(),
    type: "conversation_summary",
    content: summarizeConversation(userMessage, assistantReply, assistantName(store.settings)),
    userStatement: compactConversationText(userMessage),
    assistantResponse: compactConversationText(assistantReply),
    metadata: {
      source: "agent-runtime",
      localDate,
      sourcePath,
      evidenceRole: "conversation_only",
      timeOfDay: context.time.timeOfDay,
      activeTasks: context.taskSummary.totalActive,
      overdueTasks: context.taskSummary.overdue,
      dueToday: context.taskSummary.dueToday,
      lateNightStatus: "unknown"
    }
  };
  await store.appendFile(memoryLogPath(store), `${JSON.stringify(record)}\n`, isCurrent);
  assertCurrentWrite(isCurrent);
  const capturedAt = record.timestamp;
  const personal = inferExplicitPersonalMemory(userMessage, {
    sourceId: `conversation:${localDate}`,
    path: sourcePath,
    capturedAt
  });
  if (personal) {
    assertCurrentWrite(isCurrent);
    const result = await new AgentRuntime({ store, refreshViews: async () => undefined }).executeLocalOperation(
      "observe_personal_memory_candidate", { input: personal }, async scoped => {
        assertCurrentWrite(isCurrent);
        const existing = (await scoped.readPersonalMemories()).records.find(record => record.id === personal.id);
        assertCurrentWrite(isCurrent);
        // An automatic repeated statement is already in the original chat.
        // Do not merge its unapproved source into legacy confirmed authority.
        // Bound-source/conflicting observations still follow candidate rules.
        if (existing?.status === "active" && existing.kind === personal.kind && existing.content === personal.content
          && existing.sourceBinding === undefined && personal.sourceBinding === undefined) return existing;
        return scoped.upsertPersonalMemory(personal, isCurrent);
      },
      `candidate:${personal.id}:${capturedAt}`
    );
    // Cancellation after a committed fact operation must not roll that operation back.
    assertCurrentWrite(isCurrent);
    if (!result.success) throw new Error(result.output);
  }
}

export async function getUserTrends(store: StoreHost, _fallback?: InjectedContext): Promise<UserTrends> {
  // Read current task state; old logs and caller snapshots are not current task facts.
  // The legacy numeric zero is neutral for expression tuning, not evidence of no late nights.
  const unknown: UserTrends = { consecutiveLateNights: 0, activeTasks: 0, overdueTasks: 0,
    completionSignals: 0, lateNightStatus: "unknown", taskEvidenceStatus: "unknown", completionEvidence: [], sourcePaths: [] };
  try {
    const now = new Date();
    const dashboard = await store.getTaskDashboard(formatDate(now));
    const facts = summarizeTaskFacts(dashboard.tasks, now, [store.taskDbPath(), store.taskMirrorPath()]);
    return {
      ...unknown, activeTasks: facts.activeTasks, overdueTasks: facts.overdueTasks,
      completionSignals: facts.completionEvidence.length,
      taskEvidenceStatus: facts.incompleteCompletionCount ? "partial" : "available",
      completionEvidence: facts.completionEvidence, sourcePaths: facts.sourcePaths, observedAt: facts.observedAt
    };
  } catch {
    return unknown;
  }
}

function memoryLogPath(store: StoreHost): string {
  return store.path(store.settings.folders.aiReports, "Memory", "conversation-memory.jsonl");
}

function summarizeConversation(userMessage: string, assistantReply: string, name: string): string {
  const user = compactConversationText(userMessage);
  const assistant = compactConversationText(assistantReply);
  return `用户：${user}\n${name}：${assistant}`;
}

function compactConversationText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}
