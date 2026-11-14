import type { LifeOpsToolDefinition } from "../../toolRegistry";
import { LEARNING_TRACKS, isLearningTrackId } from "../learning/model";

export const READING_TOOL: LifeOpsToolDefinition = {
  name: "search_reading", safety: "safe",
  description: "查最近阅读、文章摘要及相关想法或学习轨道，回答时给对应的笔记链接。",
  parameters: { type: "object", additionalProperties: false, properties: {
    query: { type: "string", description: "文章关键词或想法标题。" },
    ideaId: { type: "string", description: "可用 list_ideas 返回的准确 ID。" },
    trackId: { type: "string", enum: Object.keys(LEARNING_TRACKS) },
    limit: { type: "integer", minimum: 1, maximum: 12 }
  } },
  async execute(args, context) {
    const limit = args.limit ?? 6;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 12
      || args.query !== undefined && typeof args.query !== "string" || args.ideaId !== undefined && typeof args.ideaId !== "string"
      || args.trackId !== undefined && !isLearningTrackId(args.trackId)) {
      return { success: false, output: "请核对阅读关键词、轨道或结果条数。", actions: [] };
    }
    const [{ listIdeas, ideaTitleKey, ideaLink }, { relatedReading }] = await Promise.all([import("../ideas/notes"), import("./index")]);
    const ideas = await listIdeas(context.store), visible = new Map(ideas.map(idea => [idea.ideaId, idea]));
    if (args.ideaId && !visible.has(args.ideaId)) return { success: true, output: JSON.stringify({ articles: [] }), actions: [] };
    const query = typeof args.query === "string" ? args.query.trim().slice(0, 200) : "";
    const matches = query ? ideas.filter(idea => ideaTitleKey(idea.title) === ideaTitleKey(query)) : [];
    const ideaId = args.ideaId || (matches.length === 1 ? matches[0].ideaId : undefined);
    const result = await relatedReading(context.store, { ideaId, query: !args.ideaId && ideaId ? undefined : query, limit,
      trackId: isLearningTrackId(args.trackId) ? args.trackId : undefined });
    return { success: true, output: JSON.stringify({ articles: result.map(entry => ({
      title: entry.title, summary: entry.summary, keywords: entry.keywords, link: ideaLink(entry.path), updatedAt: entry.updatedAt,
      ideas: entry.ideaIds.flatMap(id => {
        const idea = visible.get(id);
        return idea ? [{ id, title: idea.title, link: ideaLink(idea.path) }] : [];
      }),
      tracks: entry.trackIds.map(id => ({ id, name: LEARNING_TRACKS[id] }))
    })) }), actions: [] };
  }
};

export function readingLinkEvidence(output: string, answer: string, question: string): string | undefined {
  if (!/(?:笔记|原文|原始|原始网页)(?:的)?链接/u.test(question)) return;
  let result: { articles?: Array<{ link: string }> };
  try { result = JSON.parse(output); } catch { return; }
  if (!Array.isArray(result?.articles)) return;
  const links = [...new Set(result.articles.map(article => article?.link)
    .filter(link => typeof link === "string" && link && !answer.includes(link)))];
  if (links.length) return "笔记链接：" + links.join("、");
}
