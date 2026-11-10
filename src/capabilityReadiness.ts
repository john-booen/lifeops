import type { LifeOpsSettings } from "./types";
import { streamingAsrEndpoint } from "./voice/realtimeAsrOptions";

export interface CapabilityReadiness {
  ready: boolean;
  code: "off" | "configuration" | "disclosure" | "credential-storage" | "text-required" | "experimental" | "configured";
  message: string;
}

/** Configuration checks only: being configured does not prove a live service is available. */
export function textAiReadiness(settings: LifeOpsSettings): CapabilityReadiness {
  const ai = settings.ai;
  if (ai.provider === "off") {
    return { ready: false, code: "off", message: "文字 AI 尚未开启。可以继续记录和使用本地任务指令；自由对话与 AI 整理需要先配置。" };
  }
  if (!ai.endpoint.trim() || !ai.model.trim()) {
    return { ready: false, code: "configuration", message: "文字 AI 配置未完成，请在 LifeOps 设置中补全服务地址和模型。" };
  }
  if (ai.dataDisclosureAccepted !== true) {
    return { ready: false, code: "disclosure", message: "文字 AI 尚未获准发送消息和相关记录。请先在 LifeOps 设置中阅读并确认数据发送范围。" };
  }
  if (ai.apiKey.trim() && settings.privacy?.plaintextCredentialStorageAccepted !== true) {
    return { ready: false, code: "credential-storage", message: "文字 AI 的密钥存储确认尚未完成，请先在 LifeOps 设置中确认本地明文存储说明。" };
  }
  return { ready: true, code: "configured", message: "文字 AI 已配置；服务是否可用仍需实际连接验证。" };
}

/** Preflight for continuous Qwen conversation, before any microphone acquisition. */
export function realtimeVoiceReadiness(settings: LifeOpsSettings): CapabilityReadiness {
  const voice = settings.realtimeVoice;
  if (voice.provider === "off") {
    return { ready: false, code: "off", message: "语音尚未开启。可切回文字继续记录，或打开 LifeOps 设置查看配置。" };
  }
  if (voice.provider !== "qwen-omni-realtime") {
    return { ready: false, code: "experimental", message: "当前选择的是实验性听写。连续语音对话需要在 LifeOps 设置中选择百炼实时语音。" };
  }
  if (!voice.apiKey.trim()) {
    return { ready: false, code: "configuration", message: "百炼实时语音尚未配置密钥，请先在 LifeOps 设置中完成配置。" };
  }
  if (voice.dataDisclosureAccepted !== true) {
    return { ready: false, code: "disclosure", message: "语音尚未获准发送音频和朗读文本，请先在 LifeOps 设置中阅读并确认数据发送范围。" };
  }
  if (voice.plaintextCredentialStorageAccepted !== true || settings.privacy?.plaintextCredentialStorageAccepted !== true) {
    return { ready: false, code: "credential-storage", message: "语音密钥的存储确认尚未完成，请先在 LifeOps 设置中确认本地明文存储说明。" };
  }
  if ((voice.mode ?? "cascade") === "cascade") {
    if (voice.asrEngine === "streaming-hotwords") {
      try { streamingAsrEndpoint(voice.endpoint); }
      catch (error) { return { ready: false, code: "configuration", message: (error as Error).message }; }
    }
    const text = textAiReadiness(settings);
    if (!text.ready) {
      return { ready: false, code: "text-required", message: `当前语音使用“听写 → 文字 AI → 朗读”。${text.message}完成文字 AI 配置后才能开始语音对话。` };
    }
  }
  return { ready: true, code: "configured", message: "语音已配置；点击语音后会启动麦克风并连接服务。" };
}
