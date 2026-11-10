import type { AgentActionSuggestion } from "../types";

export function voiceActionPrompt(action: AgentActionSuggestion): string | undefined {
  const label = action.content.trim().split("\n", 1)[0]?.trim().replace(/^[-*]\s+/u, "").slice(0, 80);
  let question: string;
  switch (action.type) {
    case "delete_task": question = `要删除任务「${label}」吗？`; break;
    case "delete_habit": question = `要删除习惯「${label}」吗？`; break;
    case "delete_trade": question = `要删除交易「${label}」吗？`; break;
    case "tool_batch": question = `要执行${action.title.replace(/^确认\s*/u, "")}吗？`; break;
    case "review_memory":
      if (action.memoryDecision !== "forget") return;
      question = "要遗忘这条记忆吗？";
      break;
    default: return;
  }
  return `${question}说“是”或“确认”，我再执行。`;
}

export function isExactVoiceApproval(transcript: string): boolean {
  const answer = transcript.trim().replace(/[。！？.!?]+$/u, "").trim();
  return answer === "是" || answer === "确认";
}
