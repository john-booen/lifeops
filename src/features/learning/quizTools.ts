import type { LifeOpsToolDefinition, ToolExecutionContext, ToolExecutionRequest } from "../../toolRegistry";
import type { ProviderRequestOptions } from "../../types";
import { isLearningTrackId, LEARNING_TRACKS } from "./model";
import { quizText } from "./quizModel";

const optionsFor = (context: ToolExecutionContext, request: ToolExecutionRequest): ProviderRequestOptions => ({
  signal: request.signal,
  assertTextRequestCurrent: () => { context.assertCurrent?.(); request.assertCurrent?.(); }
});
const refusal = (output: string) => ({ success: false, output, actions: [] });

export function formatQuizQuestions(output: string): string | undefined {
  let result: { cards?: { number: number; question: string }[] } | null;
  try { result = JSON.parse(output); } catch { return; }
  const cards = result?.cards;
  if (!Array.isArray(cards) || !cards.length || cards.length > 12
    || cards.some((card, index) => card?.number !== index + 1 || !quizText(card.question, 300))) return;
  const questions = cards.map(card => `第 ${card.number} 题：${card.question}`);
  return [...questions, "请按题号作答。"].join("\n\n");
}

export const QUIZ_TOOLS: LifeOpsToolDefinition[] = [
  {
    name: "start_quiz", safety: "direct-write",
    description: "用户想测验时，先取到期卡，无到期卡才从学习笔记出题。按题号给题目，等用户作答。",
    parameters: { type: "object", additionalProperties: false, properties: {
      trackId: { type: "string", enum: Object.keys(LEARNING_TRACKS), description: "英语 english；交易 trading；量化 quant；AI ai" },
      count: { type: "integer", minimum: 1, maximum: 12, description: "默认三题。" }
    } },
    async execute(args, context, request) {
      const count = args.count ?? 3;
      if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 12
        || args.trackId !== undefined && !isLearningTrackId(args.trackId) || !request.userMessage?.trim()) {
        return refusal("请选择学习轨道和 1 至 12 道题。");
      }
      const { startQuiz } = await import("./quiz");
      const reviewer = context.requestQuizReview;
      const cards = await startQuiz(context.store, count, reviewer && ((messages, options) => reviewer(messages, options, request.source)),
        optionsFor(context, request), isLearningTrackId(args.trackId) ? args.trackId : undefined);
      if (!cards.length) return refusal("当前没有可复习的卡。可以在对应学习轨道填入笔记目录，或添加有足够内容的学习笔记。");
      await context.refreshViews().catch(() => undefined);
      return { success: true, output: JSON.stringify({ cards, requested: count, instruction: "现在仅出题，等用户回答。答题时用 current_quiz 查题号。" }), actions: [] };
    }
  },
  {
    name: "current_quiz", safety: "safe",
    description: "用户在回答测验或问答对了吗，先按题号查当前测验和卡 ID，再用 grade_answer 判分。",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async execute(_args, context) {
      const { currentQuiz } = await import("./quiz");
      const cards = await currentQuiz(context.store);
      return { success: true, output: JSON.stringify({ cards, instruction: "只用未作答的准确 ID，用户答案不足时追问。" }), actions: [] };
    }
  },
  {
    name: "grade_answer", safety: "direct-write",
    description: "按当前测验的准确卡 ID 核对用户实际回答，解释对错并更新复习日期。",
    parameters: { type: "object", additionalProperties: false, required: ["cardId", "userAnswer"], properties: {
      cardId: { type: "string", description: "从 current_quiz 或 start_quiz 获取。" },
      userAnswer: { type: "string", description: "尽量保留用户的回答原话。" }
    } },
    async execute(args, context, request) {
      const reviewer = context.requestQuizReview;
      if (!quizText(args.cardId, 120) || !quizText(args.userAnswer, 1200) || !request.userMessage?.trim() || !reviewer) {
        return refusal("请提供一道当前题目的编号、实际回答和可用的判分模型。");
      }
      const { gradeQuizAnswer } = await import("./quiz");
      const result = await gradeQuizAnswer(context.store, args.cardId, args.userAnswer.trim(),
        (messages, options) => reviewer(messages, options, request.source), optionsFor(context, request));
      await context.refreshViews().catch(() => undefined);
      return { success: true, output: JSON.stringify({ result: result.correct ? "答对了" : "答错了", ...result }), actions: [] };
    }
  }
];
