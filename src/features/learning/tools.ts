import { todayString } from "../../date";
import type { LifeOpsToolDefinition } from "../../toolRegistry";
import { isLearningTrackId, isLearningUnitStatus, LEARNING_TRACKS, learningProgress, type LearningTrackId } from "./model";

const trackIds = Object.keys(LEARNING_TRACKS) as LearningTrackId[];
const trackArg = { type: "string", enum: trackIds, description: "英语 english；交易 trading；量化 quant；AI ai" };

export const LEARNING_TOOLS: LifeOpsToolDefinition[] = [
  {
    name: "learning_progress", safety: "safe",
    description: "查英语、交易系统、量化或 AI 的已完成单元、本周实记分钟和下周的待学计划。",
    parameters: { type: "object", additionalProperties: false, properties: { trackId: trackArg } },
    async execute(args, context) {
      const { existingLearningTrack, readLearningDocument, visibleLearningTrack } = await import("./store");
      if (args.trackId !== undefined && !isLearningTrackId(args.trackId)) return { success: false, output: "请指定有效的学习轨道。", actions: [] };
      const doc = await readLearningDocument(context.store), now = new Date();
      const ids = isLearningTrackId(args.trackId) ? [args.trackId] : trackIds;
      return { success: true, actions: [], output: JSON.stringify(ids.map(id => {
        const track = visibleLearningTrack(context.store, existingLearningTrack(context.store, doc, id));
        return { id, name: track.name, goal: track.goal || null, targetDate: track.targetDate, units: track.units,
          ...learningProgress(track, now) };
      })) };
    }
  },
  {
    name: "record_learning", safety: "direct-write",
    description: "用户明确说已经学过时记学习记录。只填用户说过的分钟数，没说时省略；计划做的事用创建任务。",
    parameters: { type: "object", additionalProperties: false, required: ["trackId"], properties: {
      trackId: trackArg, minutes: { type: "integer", minimum: 1, maximum: 1440 },
      date: { type: "string", description: "实际学习日期，省略是今天。" }, summary: { type: "string" }
    } },
    async execute(args, context, request) {
      const { recordLearningTime } = await import("./store");
      if (!isLearningTrackId(args.trackId) || !request.userMessage?.trim() || args.minutes !== undefined && typeof args.minutes !== "number"
        || args.date !== undefined && typeof args.date !== "string" || args.summary !== undefined && typeof args.summary !== "string") {
        return { success: false, output: "请核对学习轨道、日期和实际分钟数。", actions: [] };
      }
      const date = await recordLearningTime(context.store, args.trackId, { minutes: args.minutes as number | undefined,
        date: args.date as string | undefined, summary: args.summary as string | undefined }, request.operationId);
      await context.refreshViews().catch(() => undefined);
      return { success: true, actions: [], output: "已记录 " + date + " 的" + LEARNING_TRACKS[args.trackId] + "学习"
        + (args.minutes === undefined ? "，用时未填写。" : " " + args.minutes + " 分钟。") };
    }
  },
  {
    name: "update_learning_unit", safety: "direct-write",
    description: "用户明确要改学习单元进度时，先查 learning_progress 获取准确的轨道和单元 ID。",
    parameters: { type: "object", additionalProperties: false, required: ["trackId", "unitId", "status"], properties: {
      trackId: trackArg, unitId: { type: "string" }, status: { type: "string", enum: ["todo", "doing", "done"] }
    } },
    async execute(args, context, request) {
      const { updateLearningUnit } = await import("./store");
      if (!isLearningTrackId(args.trackId) || typeof args.unitId !== "string" || !isLearningUnitStatus(args.status) || !request.userMessage?.trim()) {
        return { success: false, output: "请明确学习轨道、单元和状态。", actions: [] };
      }
      const unit = await updateLearningUnit(context.store, args.trackId, args.unitId, args.status, todayString());
      await context.refreshViews().catch(() => undefined);
      return { success: true, output: "已更新学习单元「" + unit.title + "」。", actions: [] };
    }
  }
];
