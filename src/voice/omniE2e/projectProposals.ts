import type { AiToolCall } from "../../ai";
import type { AgentActionSuggestion } from "../../types";

type VoiceRealtimeView = any;

// A proposal failure is host-owned and belongs only to the captured active turn.
type ProjectProposalFailure = {text:string;sequence:number};
const failedProjectProposals = new WeakMap<object, {notices:Map<string,ProjectProposalFailure>;watermarks:Map<string,number>;isCurrent:()=>boolean}>();
let projectProposalSequence = 0;
export function nextProjectProposalSequence(): number { return ++projectProposalSequence; }
export function currentProjectProposalFailures(view: VoiceRealtimeView) {
  const failures=failedProjectProposals.get(view);
  if(failures && !failures.isCurrent()){failedProjectProposals.delete(view);return undefined;}
  return failures;
}
export function recordProjectProposalFailure(view: VoiceRealtimeView, text:string, isCurrent:()=>boolean, proposalKey:string, sequence:number, retirePlayback: (view: VoiceRealtimeView) => void): boolean {
  if(!isCurrent())return false;
  const prior=currentProjectProposalFailures(view),notices=prior?.notices ?? new Map<string,ProjectProposalFailure>(),watermarks=prior?.watermarks ?? new Map<string,number>();
  if((watermarks.get(proposalKey) ?? -1)>sequence)return false;
  watermarks.set(proposalKey,sequence);notices.set(proposalKey,{text,sequence});failedProjectProposals.set(view,{notices,watermarks,isCurrent});
  retirePlayback(view);
  const runtime=view.agentVoiceRuntime,current=runtime?.snapshot().currentTurn;
  // Retire queued native output without interrupting the owning tool turn.
  if(current?.playbackId && current.outputOwner !== "none") {
    runtime.selectOutputOwner("none");
    view.agentAudioOutput?.cancel?.(current.playbackId,"project_proposal_failed");
  }
  view.agentTtsClient?.cancel?.();view.agentTtsClient=null;
  view.agentOmniPendingAudio=[];view.agentOmniPlaybackReady=null;view.agentSpeaking=false;return true;
}
export function projectProposalFailure(view: VoiceRealtimeView): string | undefined {
  const failures=currentProjectProposalFailures(view);
  return failures?.notices.size ? [...failures.notices.values()].map(failure=>failure.text).join("\n\n") : undefined;
}
export function clearRepairedProjectProposal(view: VoiceRealtimeView, proposalKey:string, failureAtStart:ProjectProposalFailure | undefined, sequence:number): boolean {
  const failures=currentProjectProposalFailures(view);
  // A success begun before a failure is not a repair of that later failure.
  if(!failureAtStart || failures?.notices.get(proposalKey)!==failureAtStart)return false;
  failures.notices.delete(proposalKey);
  // Keep the repaired watermark until this exact turn retires, even with no notices.
  failures.watermarks.set(proposalKey,sequence);return true;
}
export function projectProposalKey(call:AiToolCall): string {
  const string=(value:unknown)=>typeof value==="string" ? value.trim() : "";
  if(call.name!=="propose_project_change")return JSON.stringify([call.name,string(call.arguments.projectId),
    call.name==="propose_project_task_result" ? string(call.arguments.taskId) : ""]);
  const raw=call.arguments.command,command=raw && typeof raw==="object" && !Array.isArray(raw) ? raw as Record<string,unknown> : {};
  const rawInput=command.input,input=rawInput && typeof rawInput==="object" && !Array.isArray(rawInput) ? rawInput as Record<string,unknown> : {};
  return JSON.stringify([call.name,string(command.kind),string(command.id),string(command.projectId),string(command.taskId),string(command.entryId),
    command.kind==="create_task" || !string(command.id) && !string(command.projectId) ? string(input.title) : ""]);
}
export function projectProposalSpecification(name:string): {type:AgentActionSuggestion["type"];notice:string} | undefined {
  if(name==="propose_project_work_plan")return {type:"task_plan",notice:"本次项目安排卡未生成，尚未保存新的任务或项目下一步。"};
  if(name==="propose_project_task_result")return {type:"project_change",notice:"本次任务结果卡未生成，尚未保存这项产出或回顾。"};
  if(name==="propose_project_change")return {type:"project_change",notice:"本次项目变更卡未生成，尚未保存这项变更。"};
  return undefined;
}
