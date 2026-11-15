import { formatDate } from "../../date";
import { isVaultPathExcluded } from "../../privacy";
import type { LifeOpsToolDefinition } from "../../toolRegistry";

export const IDEA_TOOLS: LifeOpsToolDefinition[] = [
  {
    name: "list_ideas", safety: "safe",
    description: "查想法、停滞和下一步。用户明确要拆成任务时，按标题查并设 draftAdvance=true，唯一匹配后用 advance_idea。",
    parameters: { type: "object", additionalProperties: false, properties: {
      query: { type: "string", description: "想法标题或关键词。" },
      exactTitle: { type: "boolean", description: "按完整标题查单条想法时设为 true。" },
      draftAdvance: { type: "boolean", description: "明确要把指定想法拆成任务时才填 true。" }
    } },
    async execute(args, context) {
      const { listIdeas, ideaTitleKey, ideaDaysStalled } = await import("./notes");
      const { ideaIsStalled, ideaRemindersSinceProgress } = await import("./progress");
      const query = typeof args.query === "string" ? ideaTitleKey(args.query) : "";
      const date = formatDate(new Date());
      const items = (await listIdeas(context.store)).filter(idea => args.exactTitle === true
        ? ideaTitleKey(idea.title) === query
        : !query || ideaTitleKey(idea.title + " " + idea.description).includes(query));
      return { success: true, output: JSON.stringify({ total: items.length, ideas: items.slice(0, 40).map(idea => ({
        id: idea.ideaId, title: idea.title, status: idea.status, description: idea.description.slice(0, 200), nextAction: idea.nextAction,
        nextReview: idea.nextReview, lastProgress: idea.lastProgress, daysStalled: ideaDaysStalled(idea.lastProgress, date),
        stalled: ideaIsStalled(idea, date), needsDecision: ideaIsStalled(idea, date) && ideaRemindersSinceProgress(idea, date).length >= 3,
        link: "[[" + idea.path.replace(/\.md$/, "") + "]]"
      })) }), actions: [] };
    }
  },
  {
    name: "advance_idea", safety: "ui-confirm",
    description: "用户要推进一个已登记想法时，按准确 ID 生成现状和本周任务确认卡。查进展用 list_ideas。",
    parameters: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } },
    async prepareConfirmation(args, context, request) {
      if (typeof args.id !== "string" || !args.id || !request.userMessage?.trim() || !context.requestIdeaPlan) {
        throw new Error("请在当前对话中选择一个想法来生成安排。");
      }
      const { prepareIdeaAdvance } = await import("./advance");
      const action = await prepareIdeaAdvance(context.store, args.id, request.operationId,
        (messages, options) => context.requestIdeaPlan!(messages, options, request.source),
        { signal: request.signal, assertTextRequestCurrent: () => { context.assertCurrent?.(); request.assertCurrent?.(); } });
      return { success: true, output: action.content + "\n请核对确认卡。", actions: [action] };
    },
    async execute() { return { success: false, output: "请使用可见确认卡。", actions: [] }; }
  },
  {
    name: "set_idea_status", safety: "direct-write",
    description: "仅当用户明确决定继续、暂停、放弃或改变一个想法状态时，按该想法的准确 ID 保存选择。",
    parameters: { type: "object", additionalProperties: false, required: ["id", "status"], properties: {
      id: { type: "string" }, status: { type: "string", enum: ["continue", "seed", "exploring", "validating", "building", "parked", "dropped"] }
    } },
    async execute(args, context, request) {
      const { IDEA_STATES, isIdeaStatus } = await import("./notes");
      const { findIdea, setIdeaStatus } = await import("./progress");
      if (typeof args.id !== "string" || !request.userMessage?.trim() || !(args.status === "continue" || isIdeaStatus(args.status))) {
        return { success: false, output: "请选择一个想法和要保存的状态。", actions: [] };
      }
      const idea = await setIdeaStatus(context.store, await findIdea(context.store, args.id), args.status);
      return { success: true, output: "「" + idea.title + "」已设为" + IDEA_STATES[idea.status] + "。", actions: [] };
    }
  },
  {
    name: "upsert_idea", safety: "direct-write",
    description: "用户明确要记下想法时直接登记。先查看是否有同一想法，只有核心内容相同才用已有 mergeId。保留用户原意。",
    parameters: { type: "object", additionalProperties: false, required: ["title", "description"], properties: {
      title: { type: "string" }, description: { type: "string" }, nextAction: { type: "string" }, mergeId: { type: "string" }
    } },
    async execute(args, context, request) {
      if (typeof args.title !== "string" || typeof args.description !== "string"
        || args.nextAction !== undefined && typeof args.nextAction !== "string" || args.mergeId !== undefined && typeof args.mergeId !== "string") {
        return { success: false, output: "请提供想法的标题和内容。", actions: [] };
      }
      const { upsertIdea } = await import("./service");
      const now = new Date();
      const conversation = context.store.path(context.store.settings.folders.aiReports, "Conversations", formatDate(now) + ".md");
      const sourcePath = request.userMessage?.trim() && !isVaultPathExcluded(conversation, context.store.settings.privacy?.excludedVaultPrefixes)
        ? conversation : undefined;
      const { idea, merged } = await upsertIdea(context.store, {
        title: args.title, description: args.description, nextAction: args.nextAction as string | undefined,
        mergeId: args.mergeId as string | undefined, sourcePath
      }, now);
      return { success: true, actions: [], output: (merged ? "已归入已有想法「" : "已登记想法「") + idea.title + "」 · [[" + idea.path.replace(/\.md$/, "") + "]]"
        + (idea.nextAction ? " · 下一步 " + idea.nextAction : "") };
    }
  }
];
