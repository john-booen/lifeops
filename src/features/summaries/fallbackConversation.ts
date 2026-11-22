import { redactSensitiveText } from "../../credentialSecurity";
import { MEMORY_CONTEXT_OMISSION } from "../../personalMemoryContext";
import type { SummaryData } from "./data";

/** Keep selected user words visible when model interpretation is unavailable. */
export function fallbackConversationText(data: SummaryData, credentials: string[]): string {
  const excerpts = (data.daily?.conversation ?? []).map(text => redactSensitiveText(text, credentials).trim())
    .filter(text => text && text !== MEMORY_CONTEXT_OMISSION).slice(-3).map(text => {
      const characters = [...text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")];
      const excerpt = characters.slice(0, 240).join("") + (characters.length > 240 ? "…（节选）" : "");
      const literal = excerpt.replace(/[&<>]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]!)
        .replace(/[\\`*_{}\[\]()#+.!|~$=-]/g, "\\$&").replace(/\n/g, "\n> ");
      return "> " + literal;
    });
  return excerpts.length ? ["## 当天对话原话（未整理）", "",
    "这里只保留最近几条原话片段，完整内容请回看当天对话。片段尚未整理，不能直接当作计划、完成记录或长期事实。", "",
    excerpts.join("\n\n")].join("\n") : "";
}
