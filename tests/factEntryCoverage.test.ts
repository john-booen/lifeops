import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const mainText = readFileSync(resolve("src/main.ts"), "utf8");
const main = ts.createSourceFile("main.ts", mainText, ts.ScriptTarget.Latest, true);
const healthStore = ts.createSourceFile("health-store.ts", readFileSync(resolve("src/features/health/store.ts"), "utf8"), ts.ScriptTarget.Latest, true);
const serviceSources = [
  "src/features/tasks/service.ts", "src/features/habits/service.ts", "src/features/journal/service.ts",
  "src/features/memory/service.ts", "src/features/review/service.ts", "src/agent/run.ts", "src/agent/service.ts", "src/features/health/modal.ts"
]
  .map((path) => ts.createSourceFile(path, readFileSync(resolve(path), "utf8"), ts.ScriptTarget.Latest, true));
const factMethods = new Set([
  "recordHabitStatus", "appendHealthEntry", "appendCalendarNote", "recordClassifiedInput", "recordHabit", "clearHabitCheckin",
  "createTask", "updateTaskDetails", "deleteTask", "postponeTask", "postponeTasks", "skipRepeatedTask", "moveTaskToDate",
  "duplicateTaskToDate", "moveTaskOrder", "createHabit", "updateHabitDetails", "deleteHabit", "completeTask", "completeTaskAndLog",
  "abandonTask", "moveTaskToQuadrant", "acceptPunishments", "createDailyReview", "createTradingReview", "appendMemoryNote",
  "writePersonalMemories", "upsertPersonalMemory", "reviewPersonalMemory", "resetGatewayInbox", "writeWorkflowDraft", "writePersonalMemoryReview"
]);
function calls(root: ts.Node): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => { if (ts.isCallExpression(node)) found.push(node); ts.forEachChild(node, visit); };
  visit(root);
  return found;
}
function method(name: string): ts.MethodDeclaration {
  let found: ts.MethodDeclaration | undefined;
  const visit = (node: ts.Node) => { if (ts.isMethodDeclaration(node) && node.name.getText(main) === name) found = node; ts.forEachChild(node, visit); };
  visit(main);
  if (!found) throw new Error(`Missing method ${name}`);
  return found;
}
function actionImplementation(name: string): ts.MethodDeclaration | ts.FunctionDeclaration {
  return serviceSources.flatMap((source) => [...source.statements]).find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name) ?? method(name);
}
describe("first-party action entry coverage", () => {
  it("has no direct user-fact writes on the plugin's unscoped Store", () => {
    const bypasses = [main, ...serviceSources].flatMap(calls).filter(call => ts.isPropertyAccessExpression(call.expression)
      && call.expression.expression.getText() === "this.store" && factMethods.has(call.expression.name.text));
    expect(bypasses.map(call => call.getText())).toEqual([]);
  });
  it("routes every task and habit panel action through the local Runtime boundary", () => {
    const names = ["recordHabit", "recordHabitStatus", "clearHabitCheckin", "createTask", "updateTask", "deleteTask", "postponeTask", "postponeTasks",
      "skipRepeatedTask", "moveTaskToDate", "duplicateTaskToDate", "moveTaskOrder", "createHabit", "updateHabit", "deleteHabit",
      "completeTask", "completeTaskAndLog", "abandonTask", "moveTaskToQuadrant"];
    for (const name of names) expect(calls(actionImplementation(name)).some(call => call.expression.getText() === "this.saveLocalOperation"), name).toBe(true);
    expect(actionImplementation("openTaskEditModal").getText()).toContain("recordRevision(task)");
    expect(actionImplementation("openHabitEditModal").getText()).toContain("recordRevision(habit)");
    expect(actionImplementation("updateTask").getText()).toContain("assertRecordRevision");
    expect(actionImplementation("updateHabit").getText()).toContain("assertRecordRevision");
  });
  it("keeps CSV rows within a single operation and closes the old classification fallback", () => {
    const csv = calls(method("openHealthCsvImport")).filter(call => call.expression.getText(main) === "this.saveLocalOperation");
    expect(csv).toHaveLength(1);
    expect(csv[0].arguments[2].getText(main)).toContain("recordHealthEntries(store, entries)");
    const healthWriter = healthStore.statements.find((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === "recordHealthEntries");
    expect(healthWriter).toBeDefined();
    expect(calls(healthWriter!).filter(call => call.expression.getText() === "store.appendHealthEntry")).toHaveLength(1);
    const screenshot = serviceSources.find(source => source.fileName === "src/features/health/modal.ts")!;
    const confirmation = calls(screenshot).filter(call => call.expression.getText() === "this.host.saveLocalOperation");
    expect(confirmation).toHaveLength(1);
    expect(confirmation[0].arguments[2].getText()).toContain("recordHealthEntries(store, entries)");
    expect(actionImplementation("executeAgentAction").getText()).toContain("executeConfirmedJournalSuggestion");
    expect(actionImplementation("executeAgentAction").getText()).toContain("executeConfirmedCaptureSuggestion");
    expect(mainText).not.toContain("actionToClassification");
  });
  it("does not automatically import or clear excluded Gateway input", () => {
    expect(calls(method("processGatewayInbox")).some(call => /capture|readGateway|resetGateway/.test(call.expression.getText(main)))).toBe(false);
  });
  it("uses call identities that survive retries without reusing positional IDs across turns", () => {
    const entry = method("submitAgentMessageStream");
    const loop = readFileSync("src/agent/AgentLoop.ts", "utf8");
    expect(loop).toContain("ensureToolCallId(call)");
  });
  it("keeps background extraction on the candidate Runtime path", () => {
    const source = readFileSync(resolve("src/memorySystem.ts"), "utf8");
    expect(source).toContain('"observe_personal_memory_candidate"');
    expect(source).toContain("executeLocalOperation");
    expect(source).not.toContain("await store.upsertPersonalMemory");
  });
});
