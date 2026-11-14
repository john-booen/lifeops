import { randomUUID } from "node:crypto";
import { ACCOUNTABILITY_BOUNDARY } from "../../accountability";
import type { AiToolCall } from "../../ai";
import type { BailianRealtimeOptions, BailianRealtimeResponseEvent } from "../../bailianRealtime";
import type { RealtimeVoiceSettings } from "../../types";

export function buildOmniSessionUpdate(settings: RealtimeVoiceSettings, options: BailianRealtimeOptions,
  initial: { nonce: string; wireInstructions: string } | undefined, language: string | undefined): Record<string, unknown> {
  const explicitAudio = settings.model.trim() === "qwen3.8-omni-flash-realtime";
  return {
    type: "session.update",
    ...(initial ? {event_id: initial.nonce} : explicitAudio ? {event_id: `event_${randomUUID()}`} : {}),
    session: {
      modalities: ["text", "audio"],
      input_audio_transcription: {
        model: "qwen3-asr-flash-realtime",
        ...(language ? { language } : {})
      },
      turn_detection: {
        type: explicitAudio ? "server_vad" : "semantic_vad",
        threshold: explicitAudio ? 0.35 : 0.8,
        silence_duration_ms: 1500,
        create_response: false,
        interrupt_response: false
      },
      ...(explicitAudio ? {
        audio: {
          input: { format: { type: "pcm", sample_rate: 16000 } },
          output: { format: { type: "pcm", sample_rate: 24000 } }
        }
      } : { input_audio_format: "pcm16", output_audio_format: "pcm16" }),
      voice: settings.omniVoice?.trim() || "Tina",
      instructions: initial?.wireInstructions || options.instructions || defaultOmniInstructions(),
      ...(options.tools?.length ? { tools: options.tools.map(tool => {
        // Keep internal tool descriptors unchanged; Realtime uses a nested function.
        if (tool.type !== "function" || "function" in tool) return tool;
        const { name, description, parameters, ...rest } = tool;
        return { ...rest, function: { name,
          ...(description !== undefined ? { description } : {}),
          ...(parameters !== undefined ? { parameters } : {}) } };
      }) } : {})
    }
  };
}

export function mergeOmniToolArguments(buffers: Map<string, string>, event: Record<string, unknown>): void {
  const id = toolCallId(event);
  const delta = typeof event.delta === "string" ? event.delta : "";
  if (id && delta) buffers.set(id, `${buffers.get(id) ?? ""}${delta}`);
}

function defaultOmniInstructions(): string {
  return [
    "你是 LifeOps 个人管家，正在和用户进行中文实时语音对话。",
    ACCOUNTABILITY_BOUNDARY,
    "回复要自然、简洁、口语化，通常 2 到 5 句话。",
    "如果用户明确要求创建、完成、删除任务或处理习惯，请优先使用工具调用；删除类动作只会生成待确认卡片，不要声称已经真正删除。",
    "不要使用 Markdown 表格、代码块或复杂编号。"
  ].join("\n");
}

function toolCallId(event: Record<string, unknown>): string {
  const direct = event.call_id ?? event.callId ?? event.item_id ?? event.itemId ?? event.id;
  if (typeof direct === "string") return direct;
  const item = event.item;
  if (isRecord(item)) {
    const nested = item.call_id ?? item.callId ?? item.id;
    if (typeof nested === "string") return nested;
  }
  return "";
}

export function normalizeOmniToolCall(event: Record<string, unknown>, buffers: Map<string, string>): (Omit<AiToolCall, "id" | "arguments"> & {
  id: string;
  arguments: Record<string, unknown> | undefined;
}) | null {
  const item = isRecord(event.item) ? event.item : event;
  const callId = toolCallId(event);
  const name = stringValue(item.name) || stringValue(event.name);
  if (!name || !callId) return null;
  const argsText = stringValue(event.arguments)
    || stringValue(item.arguments)
    || (callId ? buffers.get(callId) ?? "" : "");
  return {
    id: callId,
    name,
    arguments: parseToolArguments(argsText)
  };
}

function parseToolArguments(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (isRecord(parsed) && !Array.isArray(parsed)) return parsed;
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function normalizeSampleRate(sampleRate: number): number {
  return Number.isFinite(sampleRate) && sampleRate > 0 ? Math.round(sampleRate) : 24000;
}

export function extractResponseAudioTranscriptDelta(event: Record<string, unknown>): string {
  const type = String(event.type ?? "");
  if (!type.startsWith("response.") || !type.includes("audio_transcript") || !type.endsWith(".delta")) return "";
  return stringValue(event.delta) || stringValue(event.transcript_delta) || stringValue(event.text);
}

export function extractResponseAudioTranscriptDone(event: Record<string, unknown>): string {
  const type = String(event.type ?? "");
  if (type.startsWith("response.") && type.includes("audio_transcript") && (type.endsWith(".done") || type.endsWith(".completed"))) {
    return stringValue(event.transcript) || stringValue(event.text);
  }
  if (type !== "response.output_item.done" && type !== "response.content_part.done") return "";
  const item = isRecord(event.item) ? event.item : {};
  const part = isRecord(event.part) ? event.part : {};
  return transcriptFromContent(part) || transcriptFromContent(item);
}

export function responseEventId(event: Record<string, unknown>): string {
  const direct = stringValue(event.response_id) || stringValue(event.responseId);
  if (direct) return direct;
  const response = isRecord(event.response) ? event.response : {};
  return stringValue(response.id);
}

export function responseLifecycleEvent(
  event: Record<string, unknown>,
  fallbackResponseId = ""
): BailianRealtimeResponseEvent {
  const response = isRecord(event.response) ? event.response : {};
  return {
    eventType: stringValue(event.type),
    responseId: responseEventId(event) || fallbackResponseId,
    status: stringValue(event.status) || stringValue(response.status)
  };
}

export function isSuccessfulResponseStatus(status: string): boolean {
  return !status || status === "completed" || status === "succeeded" || status === "success";
}

export function responseFailureMessage(event: Record<string, unknown>, status: string): string {
  const response = isRecord(event.response) ? event.response : {};
  const eventError = isRecord(event.error) ? event.error : {};
  const responseError = isRecord(response.error) ? response.error : {};
  const statusDetails = isRecord(response.status_details) ? response.status_details : {};
  const detailsError = isRecord(statusDetails.error) ? statusDetails.error : {};
  return stringValue(eventError.message)
    || stringValue(responseError.message)
    || stringValue(detailsError.message)
    || `百炼 Realtime 响应未完成（${status || "unknown"}）。`;
}

function transcriptFromContent(value: Record<string, unknown>): string {
  const direct = stringValue(value.transcript) || stringValue(value.text);
  if (direct) return direct;
  const content = value.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((entry) => isRecord(entry) ? stringValue(entry.transcript) || stringValue(entry.text) : "")
    .filter(Boolean)
    .join("");
}
