import { Notice } from "obsidian";
import type { AiToolCall } from "../../ai";
import type { BailianRealtimeClient } from "../../bailianRealtime";
import { mergePendingAgentActions, PENDING_ACTION_CONFLICT_NOTICE } from "../../pendingAgentActions";
import { assertProjectConfirmationPayload } from "../../projectTools";
import { agentToolsForRealtime, getLifeOpsTool } from "../../toolRegistry";
import type { AgentActionSuggestion } from "../../types";
import { attachVoiceWriteReceipts } from "../../writeReceipts";
import { disposeRealtimeToolOutput, type RealtimeToolOutput } from "../realtimeToolOutput";
import {
  clearRepairedProjectProposal, currentProjectProposalFailures, nextProjectProposalSequence,
  projectProposalKey, projectProposalSpecification, recordProjectProposalFailure
} from "./projectProposals";

type VoiceRealtimeView = any;

interface OmniToolHost {
  captureVoicePresentationGuard(view: VoiceRealtimeView): () => boolean;
  retireOmniPlaybackDrain(view: VoiceRealtimeView): void;
  updateManagedAssistantText(view: VoiceRealtimeView, text: string): void;
  failOmniToolContext(view: VoiceRealtimeView, message: string): void;
}

const priorVoiceQueries = new WeakMap<VoiceRealtimeView, { client: BailianRealtimeClient; isCurrent: () => boolean }>();
export async function executeOmniE2eTool(
  view: VoiceRealtimeView, toolCall: AiToolCall, retainOutput: boolean, host: OmniToolHost
): Promise<string | RealtimeToolOutput> {
  if (view.viewClosed) return "";
  const isCurrent = host.captureVoicePresentationGuard(view);
  if (!isCurrent()) return "";
  if (!agentToolsForRealtime().some(tool => tool.name === toolCall.name)) return "实时语音暂不支持这个工具，未执行操作。";
  const assertCurrent = () => { if (!isCurrent()) throw new Error("这轮语音已停止，未继续准备或保存安排。"); };
  const protectedClient=view.agentRealtimeClient?.hasProtectedContextSources?.()?view.agentRealtimeClient:undefined;
  let sourceFailure=false;
  const assertToolSourcesNow=()=>{
    try{
      assertCurrent();
      if(!protectedClient)return;
      if(view.agentRealtimeClient!==protectedClient||!protectedClient.hasProtectedContextSources())throw Error("原语音资料连接已结束，未展示新卡。");
      protectedClient.assertContextSourcesCurrentNow();
    }catch(error){sourceFailure=!!protectedClient;throw error;}
  };
  const assertToolSources=async()=>{
    try{
      assertToolSourcesNow();
      if(protectedClient)await protectedClient.assertContextSourcesCurrent();
      assertToolSourcesNow();
    }catch(error){sourceFailure=true;throw error;}
  };
  const proposal=projectProposalSpecification(toolCall.name);
  const proposalKey=proposal ? projectProposalKey(toolCall) : "";
  const proposalSequence=proposal ? nextProjectProposalSequence() : 0;
  const failureAtStart=proposal ? currentProjectProposalFailures(view)?.notices.get(proposalKey) : undefined;
  const isProposalAction=(action:AgentActionSuggestion)=>action.type===proposal?.type
    && (action.type!=="project_change" || (toolCall.name==="propose_project_task_result"
      ? action.projectCommand?.kind==="record_task_result" : action.projectCommand?.kind!=="record_task_result"));
  const recordFailure=(text:string)=>recordProjectProposalFailure(view,text,isCurrent,proposalKey,proposalSequence,host.retireOmniPlaybackDrain);
  const retiredProposalReply="该较早提议已被较新的核对取代，本次未新增卡或保存内容。";
  let proposedActions: AgentActionSuggestion[] = [];
  let unshownActions: AgentActionSuggestion[] = [];
  let recoveredProjectProposal = false;
  let retained:RealtimeToolOutput|undefined,transferred=false;
  const deliver=(reply:string):string|RealtimeToolOutput=>{
    if(retained && retained.text===reply){transferred=true;return retained;}
    return reply;
  };
  try {
    await assertToolSources();assertToolSourcesNow();
    const turn = view.agentVoiceRuntime?.snapshot().currentTurn;
    const userMessage = turn && !["completed", "interrupted", "failed"].includes(turn.phase) ? turn.transcript : "";
    const assertPriorQuery = async () => {
      const prior = priorVoiceQueries.get(view);
      if (!prior?.isCurrent() || prior.client !== protectedClient || !protectedClient?.hasProtectedToolOutputs()
        || view.agentRealtimeClient !== protectedClient) throw new Error("本轮没有可核对的成功查询。");
      await assertToolSources();
      assertToolSourcesNow();
      if (!prior.isCurrent() || !protectedClient.hasProtectedToolOutputs()) throw new Error("本轮查询已结束。");
    };
    const queryClient = view.agentRealtimeClient;
    const onSuccessfulQuery = () => {
      assertCurrent();
      // Legacy query callers may hand their owned output straight to a client
      // without retaining it on the view. They gain no ordered-undo authority.
      if (!queryClient || view.agentRealtimeClient !== queryClient) return;
      priorVoiceQueries.set(view, { client: queryClient, isCurrent });
    };
    // The optional capability is host-only. Legacy callers retain their three-argument interface.
    const isQuery = ["query_vault", "query_projects", "query_trading_research", "list_personal_memory_candidates"].includes(toolCall.name);
    const isOrderedUndo = toolCall.name === "undo_latest_operation" && /查询/u.test(userMessage);
    const receiveOutput = (output: RealtimeToolOutput) => { retained = output; };
    const response = retainOutput
      ? isQuery
        ? await view.controller.executeAgentToolCall(toolCall,userMessage,assertCurrent,receiveOutput,assertPriorQuery,onSuccessfulQuery)
        : isOrderedUndo
          ? await view.controller.executeAgentToolCall(toolCall,userMessage,assertCurrent,receiveOutput,assertPriorQuery)
          : await view.controller.executeAgentToolCall(toolCall,userMessage,assertCurrent,receiveOutput)
      : isOrderedUndo
        ? await view.controller.executeAgentToolCall(toolCall,userMessage,assertCurrent,undefined,assertPriorQuery)
        : await view.controller.executeAgentToolCall(toolCall,userMessage,assertCurrent);
    proposedActions = response.actions;
    if (!isCurrent()) { discardUndeliveredVoicePlans(view, response.actions); return ""; }
    if(proposal) {
      if(!response.actions.length || !response.actions.every(isProposalAction)) {
        discardUndeliveredVoicePlans(view,response.actions);
        const notice=`${proposal.notice}${response.reply || "请重新核对。"}`;
        if(!recordFailure(notice))return retiredProposalReply;
        host.updateManagedAssistantText(view,notice);
        return notice;
      }
    }
    for (const action of response.actions) {
      if (action.type === "project_change") assertProjectConfirmationPayload(action);
      if (action.type !== "task_plan"&&action.type!=="project_change") continue;
      if (!view.controller.assertAgentActionDeliverable) throw new Error("安排卡暂时无法核对，未提供旧卡，请重新提出安排。");
      await view.controller.assertAgentActionDeliverable(action, assertCurrent, assertToolSources);
    }
    if (!isCurrent()) { discardUndeliveredVoicePlans(view, response.actions); return ""; }
    if (response.actions.length > 0) {
      // A callback may await after Main has prepared its readonly card. Check
      // the original socket's whole history before the first visible merge.
      // Actual committed writes have no cards and retain their private receipt.
      if(!response.actions.every((action:AgentActionSuggestion)=>action.type==="task_plan"||action.type==="project_change"))await assertToolSources();
      assertToolSourcesNow();
      const previousActions = view.pendingAgentActions;
      const merged = mergePendingAgentActions(view.pendingAgentActions, response.actions);
      view.pendingAgentActions = merged.actions;
      unshownActions = merged.actions.filter((action: AgentActionSuggestion) => !previousActions.includes(action));
      const proposalDelivered=Boolean(proposal) && response.actions.every((action: AgentActionSuggestion) =>
        isProposalAction(action) && !merged.conflictingIds.includes(action.id) && view.pendingAgentActions.some((item: AgentActionSuggestion) =>
          item.id===action.id && item.type===action.type && (action.type==="task_plan"
            ? typeof action.taskPlanToken==="string" && item.taskPlanToken===action.taskPlanToken
            : typeof action.projectReviewHash==="string" && item.projectReviewHash===action.projectReviewHash)));
      discardUndeliveredVoicePlans(view, response.actions);
      if(proposal && !proposalDelivered) {
        view.pendingAgentActions=view.pendingAgentActions.filter((action:AgentActionSuggestion)=>!unshownActions.includes(action));
        discardUndeliveredVoicePlans(view,response.actions);unshownActions=[];
        const notice=`${proposal.notice}已有卡保留，请重新核对。`;
        if(!recordFailure(notice))return retiredProposalReply;host.updateManagedAssistantText(view,notice);return notice;
      }
      if (merged.conflictingIds.length) new Notice(PENDING_ACTION_CONFLICT_NOTICE);
      view.agentOmniE2eActionSuggestions = response.actions.length;
      view.refreshAgentSuggestions();
      unshownActions = [];
      if (proposalDelivered) {
        recoveredProjectProposal = clearRepairedProjectProposal(view,proposalKey,failureAtStart,proposalSequence);
      }
    }
    const reply = response.reply || (response.actions.length > 0 ? "已生成待确认动作，等待用户确认。" : "工具已执行。");
    // Protected query data belongs in the tool response, not the user's transcript.
    if (!response.actions.length && getLifeOpsTool(toolCall.name)?.safety === "safe") {
      if(retainOutput && ["query_vault","query_projects","query_trading_research","list_personal_memory_candidates"].includes(toolCall.name) && !retained)throw Error("实时查询读取范围尚未交接，未发送旧详情。");
      return deliver(reply);
    }
    const current = recoveredProjectProposal ? reply : [view.agentOmniE2eReply, reply].filter(Boolean).join("\n\n");
    host.updateManagedAssistantText(view, current);
    attachVoiceWriteReceipts(view, response.receipts);
    return deliver(reply);
  } catch (error) {
    if (unshownActions.length > 0) {
      view.pendingAgentActions = view.pendingAgentActions.filter((action: AgentActionSuggestion) => !unshownActions.includes(action));
      try { view.refreshAgentSuggestions(); } catch { /* The old pending cards retain their capabilities. */ }
    }
    discardUndeliveredVoicePlans(view, proposedActions);
    if(sourceFailure){
      if(isCurrent()&&view.agentRealtimeClient===protectedClient)host.failOmniToolContext(view,"语音资料刚刚变化或原连接已结束，未展示本次新确认卡；原待确认卡和已保存记录保留，请重新提出安排。");
      else protectedClient?.close();
      return "";
    }
    if (!isCurrent()) return "";
    const reason = error instanceof Error ? error.message : "未知错误";
    const reply = proposal
      ? `${proposal.notice}${reason}`
      : `工具“${toolCall.name}”执行失败：${reason}。请明确告诉用户本次操作没有完成，并建议稍后重试。`;
    if(proposal && !recordFailure(reply))return retiredProposalReply;
    const current = [view.agentOmniE2eReply, reply].filter(Boolean).join("\n\n");
    host.updateManagedAssistantText(view, current);
    await view.controller.appendQualityLog?.({
      inputSource: "voice",
      errorCode: "omni_tool_call_failed",
      errorMessage: `${toolCall.name}: ${reason}`
    }).catch(() => undefined);
    return reply;
  }finally{if(!transferred)disposeRealtimeToolOutput(retained);}
}

/** A delivered card survives the speaking turn; an unseen late/colliding card has no authority. */
function discardUndeliveredVoicePlans(view: VoiceRealtimeView, actions: AgentActionSuggestion[]): void {
  for (const action of actions) {
    if (action.type !== "task_plan" || !action.taskPlanToken) continue;
    const retained = view.pendingAgentActions.some((item: AgentActionSuggestion) =>
      item.type === "task_plan" && item.taskPlanToken === action.taskPlanToken);
    if (!retained) view.controller.dismissAgentAction?.(action);
  }
}
