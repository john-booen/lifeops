import type { AiToolCall, AiToolDefinition } from "../ai";
import type { ToolCallResult } from "../agentRuntime";
import { newLocalOperationId } from "../operationIdentity";
import type { AgentResponse } from "../types";
import { hasGroundedSpeechNumbers } from "./summaryNumbers";
import { speakTaskReport, taskReportBrief } from "./taskReportSpeech";

export interface VoiceJob {
  id: string;
  title: string;
  status: "running" | "done" | "cancelled" | "failed";
  startedAt: number;
  result?: string;
  voiceSpeech?: string;
  announced: boolean;
}

interface VoiceJobRequest { title: string; question: string; scope: string; originalQuestion?: string }
type VoiceJobResult = string | Pick<AgentResponse, "reply" | "voiceSpeech">;

export function backgroundVoiceQuestion({ originalQuestion, question, scope }: VoiceJobRequest): string {
  if (!originalQuestion) return scope ? `${question}\n\n用户指定的范围：${scope}` : question;
  const inferred = [question === originalQuestion ? "" : question, scope].filter(Boolean).join("\n");
  return inferred ? `${originalQuestion}\n\n后台补充（只用于补全指代，日期和范围以用户原话为准）：\n${inferred}` : originalQuestion;
}

export function needsVoiceJobSummary(text: string): boolean {
  return text.length > 180 || /(?:^|\n)[\t ]*(?:#{1,6}[\t ]|[-*+>][\t ]|\d+[.)、]|```)|\|[^\n]*\||\*\*|\[\[/u.test(text);
}

export function voiceJobSpeech(detail: string, summary?: string): string {
  const spoken = summary?.trim();
  const taskBrief = taskReportBrief(detail);
  if (taskBrief) return speakTaskReport(taskBrief, spoken?.startsWith(taskBrief.facts) ? spoken.slice(taskBrief.facts.length) : undefined);
  if (spoken && !needsVoiceJobSummary(spoken)) {
    return hasGroundedSpeechNumbers(detail, spoken) ? spoken.replace(/\s+/gu, " ") : "详细内容已经放到面板里了。";
  }
  return needsVoiceJobSummary(detail) ? "详细内容已经放到面板里了。" : detail;
}

const target = { type: "string", description: "填任务编号或标题关键词。用户明确说最近的才用 latest，指代不清用 ambiguous。" };
export function voiceJobControlTool(ids: string[], intents: string[]): AiToolDefinition {
  return {
    name: "choose_voice_job_control",
    description: "区分撤销写入、取消后台任务、续播后台结果和普通问题。",
    parameters: { type: "object", additionalProperties: false, required: ["intent", "target"], properties: {
      intent: { type: "string", enum: intents },
      target: { type: "string", enum: ["ambiguous", "latest", "latest_task", "unknown", ...ids],
        description: "撤销最近保存用 latest，撤销刚创建的待办用 latest_task。后台指代不清用 ambiguous，明确说最新用 latest，点名但查不到用 unknown。" }
    } }
  };
}
export const voiceJobTools: AiToolDefinition[] = [
  { name: "start_background_job", description: "用户明确要求在后台处理时启动新任务。耗时的总结、复盘、跨月统计或规划也放后台。调用后马上口头回执。简单查询和写入走原工具。",
    parameters: { type: "object", additionalProperties: false, required: ["title", "question", "scope"],
      properties: { title: { type: "string", description: "简短名称" }, question: { type: "string", description: "完整的用户问题" },
        scope: { type: "string", description: "用户给出的日期、项目或资料范围。相对日期保留原话，不要换算。" } } } },
  { name: "cancel_job", description: "用户说上面那个不用了，或要取消正在进行的后台任务时使用。",
    parameters: { type: "object", additionalProperties: false, required: ["target"], properties: { target } } },
  { name: "replay_job", description: "用户要继续说刚才那个或重播已经完成的后台结果时使用。",
    parameters: { type: "object", additionalProperties: false, required: ["target"], properties: { target } } }
];

export function isVoiceJobTool(name: string): boolean {
  return voiceJobTools.some(tool => tool.name === name);
}

export class VoiceJobManager {
  private readonly jobs: Array<{ job: VoiceJob; request: AbortController }> = [];
  private readonly pending = new Set<string>();
  private replay?: string;

  constructor(private readonly run: (input: VoiceJobRequest, signal: AbortSignal) => Promise<VoiceJobResult>,
    private readonly update: (job: VoiceJob) => void) {}

  list(): VoiceJob[] { return this.jobs.map(({ job }) => ({ ...job })); }

  needsControlCheck(): boolean {
    return Boolean(this.replay || this.jobs.some(({ job }) => job.status === "running"));
  }

  quickTools(): AiToolDefinition[] {
    return voiceJobTools.filter(tool => tool.name === "start_background_job"
      || tool.name === "cancel_job" && this.jobs.some(({ job }) => job.status === "running")
      || tool.name === "replay_job" && Boolean(this.replay));
  }

  routingContext() {
    const entries = this.jobs.map(({ job }) => ({ id: job.id, title: job.title, status: job.status }));
    const running = entries.filter(job => job.status === "running");
    const completed = entries.filter(job => job.status === "done").slice(-3);
    return { running, completed };
  }

  start(input: VoiceJobRequest): string {
    if (this.jobs.filter(({ job }) => job.status === "running").length >= 3) return "已经有三个任务在处理。等一个完成或取消后再加。";
    if (!input.title || !input.question) return "请说一下要后台整理的问题。";
    const job: VoiceJob = { id: newLocalOperationId("voice-job"), title: input.title, startedAt: Date.now(), status: "running", announced: false };
    const entry = { job, request: new AbortController() };
    this.jobs.push(entry);
    this.trim();
    this.update({ ...job });
    void this.complete(entry, input);
    return "好，我去整理一下，好了告诉你。";
  }

  cancel(target: string): string {
    const matches = this.matches(target, "running");
    if (matches.length !== 1) return this.clarify(matches, "没有找到正在处理的任务。", "取消");
    const entry = matches[0];
    this.finish(entry.job, "cancelled");
    entry.request.abort();
    return `好，已经取消「${entry.job.title}」。`;
  }

  requestReplay(target: string): string {
    const interrupted = target === "ambiguous" && this.replay;
    const matches = this.matches(interrupted || target, "done");
    if (matches.length !== 1) return this.clarify(matches, "还没有找到可重播的结果。", "重播");
    this.pending.add(matches[0].job.id);
    this.replay = matches[0].job.id;
    return "好，我接着说。";
  }

  takeAnnouncement(): VoiceJob | undefined {
    const id = this.replay && this.pending.has(this.replay) ? this.replay : this.pending.values().next().value;
    if (!id) return;
    this.pending.delete(id);
    const job = this.jobs.find(entry => entry.job.id === id)?.job;
    return job && { ...job };
  }

  settleAnnouncement(id: string, completed: boolean): void {
    const job = this.jobs.find(entry => entry.job.id === id)?.job;
    if (!job) return;
    if (completed) {
      job.announced = true;
      if (this.replay === id) this.replay = undefined;
    } else {
      job.announced = false;
      this.replay = id;
    }
  }

  stop(): void {
    this.pending.clear();
    this.replay = undefined;
    for (const entry of this.jobs) {
      if (entry.job.status !== "running") continue;
      this.finish(entry.job, "cancelled");
      entry.request.abort();
    }
  }

  private trim(): void {
    while (this.jobs.length > 20) {
      const index = this.jobs.findIndex(entry => entry.job.status !== "running");
      if (index < 0) return;
      const [removed] = this.jobs.splice(index, 1);
      this.pending.delete(removed.job.id);
      if (this.replay === removed.job.id) this.replay = undefined;
    }
  }

  private matches(target: string, status: VoiceJob["status"]) {
    const candidates = this.jobs.filter(entry => entry.job.status === status);
    if (target === "unknown") return [];
    if (target === "latest") return candidates.slice(-1);
    if (!target || target === "ambiguous") return candidates;
    const exact = candidates.find(entry => entry.job.id === target);
    if (exact) return [exact];
    const titles = candidates.filter(entry => entry.job.title === target);
    return titles.length ? titles : candidates.filter(entry => entry.job.title.includes(target));
  }

  private clarify(entries: Array<{ job: VoiceJob }>, empty: string, action: string): string {
    return entries.length ? `你想${action}哪一个？${entries.map(({ job }) => job.title).join("、")}。` : empty;
  }

  private async complete(entry: { job: VoiceJob; request: AbortController }, input: VoiceJobRequest): Promise<void> {
    try {
      const response = await this.run(input, entry.request.signal);
      if (entry.job.status !== "running") return;
      const result = (typeof response === "string" ? response : response.reply).trim();
      if (!result) { this.finish(entry.job, "failed"); return; }
      entry.job.result = result;
      if (typeof response !== "string" && response.voiceSpeech) entry.job.voiceSpeech = response.voiceSpeech;
      this.pending.add(entry.job.id);
      this.finish(entry.job, "done");
    } catch {
      if (entry.job.status === "running") this.finish(entry.job, "failed");
    }
  }

  private finish(job: VoiceJob, status: VoiceJob["status"]): void {
    job.status = status;
    this.update({ ...job });
  }
}

export function handleVoiceJobTool(manager: VoiceJobManager, call: AiToolCall, userMessage?: string): ToolCallResult {
  const arg = (key: string, limit: number) => typeof call.arguments[key] === "string" ? call.arguments[key].trim().slice(0, limit) : "";
  const output = call.name === "start_background_job"
    ? manager.start({ title: arg("title", 60), question: arg("question", 2_000), scope: arg("scope", 800),
      originalQuestion: userMessage?.trim().slice(0, 2_000) })
    : call.name === "cancel_job" ? manager.cancel(arg("target", 120)) : manager.requestReplay(arg("target", 120));
  return { callId: call.id!, success: true, output, actions: [] };
}
