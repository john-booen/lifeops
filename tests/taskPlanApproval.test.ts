import { expect, it } from "vitest";
import { recordRevision } from "../src/operationIdentity";
import { armAdjacentTaskPlan, consumeAdjacentTaskPlan, consumeAdjacentTaskDecision } from "../src/panel/taskPlanApproval";
import { isLiteralTaskCancellation } from "../src/features/tasks/confirmationText";
import type { AgentActionSuggestion, AgentConversationMessage } from "../src/types";

function fixture() {
  const message: AgentConversationMessage = { role: "assistant", content: "完整调整已准备，请核对。" };
  const updates: Array<Record<string, unknown>> = Array.from({ length: 4 }, (_, i) =>
    ({ taskIdOrTitle: `fictional-${i}`, startTime: "15:00", endTime: "15:30", expectedRevision: recordRevision({ i }) }));
  const action: AgentActionSuggestion = { id: "fictional-plan", type: "tool_batch", title: "确认4项调整", description: "虚构预览", date: "",
    content: "四条虚构安排", toolBatch: [{ name: "update_tasks", arguments: { updates } }] };
  const view = { agentMessages: [message], pendingAgentActions: [action] };
  armAdjacentTaskPlan(view, message, [action]); return { view, action, message, updates };
}
it.each(["确认", "确定", "是", " 确定。 "])("binds the exact adjacent approval %s once to its frozen plan", answer => {
  const h = fixture(); expect(consumeAdjacentTaskPlan(h.view, answer)).toBe(h.action);
  expect(consumeAdjacentTaskPlan(h.view, answer)).toBeUndefined();
});
it.each(["不确认", "确认但先别执行", "请解释这份计划", "确认第二份"])("does not interpret %s as the approval protocol", answer => {
  const h = fixture(); expect(consumeAdjacentTaskPlan(h.view, answer)).toBeUndefined();
  expect(consumeAdjacentTaskPlan(h.view, "确定")).toBeUndefined();
});
it.each(["取消", "算了", "不用了", "先不保存", " 取消。 "])("shares the original desktop cancellation protocol for %s", answer => {
  expect(isLiteralTaskCancellation(answer)).toBe(true);
  const h = fixture(); expect(consumeAdjacentTaskDecision(h.view, answer)).toEqual({action: h.action, approved: false});
  expect(consumeAdjacentTaskDecision(h.view, answer)).toBeUndefined();
});
it.each(["不要取消", "比如说取消", "“取消”", "取消第二项", "取消，然后新建一条"])("does not route %s as a literal card decision", answer => {
  expect(isLiteralTaskCancellation(answer)).toBe(false);
  const h = fixture(); expect(consumeAdjacentTaskDecision(h.view, answer)).toBeUndefined();
});
it("does not guess among multiple cards or a later unrelated conversation", () => {
  const h = fixture(); h.view.pendingAgentActions.push({ ...h.action, id: "fictional-other" });
  expect(consumeAdjacentTaskPlan(h.view, "确定")).toBeUndefined();
  const next = fixture(); next.view.agentMessages.push({ role: "user", content: "另一个问题" }, { role: "assistant", content: "其他回答" });
  expect(consumeAdjacentTaskPlan(next.view, "确定")).toBeUndefined();
});
it("does not use a replaced, changed or unbound plan", () => {
  const h = fixture(); h.updates[0].startTime = "19:00";
  expect(consumeAdjacentTaskPlan(h.view, "确定")).toBeUndefined();
  const replaced = fixture(); replaced.view.pendingAgentActions = [{ ...replaced.action }];
  expect(consumeAdjacentTaskPlan(replaced.view, "确定")).toBeUndefined();
  const unbound = fixture(); delete unbound.updates[0].expectedRevision;
  armAdjacentTaskPlan(unbound.view, unbound.message, [unbound.action]);
  expect(consumeAdjacentTaskPlan(unbound.view, "确定")).toBeUndefined();
});
