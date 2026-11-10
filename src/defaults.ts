import type { LifeOpsSettings } from "./types";
import { DEFAULT_PROACTIVE_RUNTIME_SETTINGS } from "./proactivePolicy";

export const DEFAULT_SETTINGS: LifeOpsSettings = {
  externalVaults: [],
  folders: {
    dailyRoot: "LifeOps/Journal",
    inbox: "LifeOps/Inbox",
    tasks: "LifeOps/Goals/Tasks",
    habits: "LifeOps/Goals/Habits",
    ideas: "LifeOps/Knowledge/Ideas",
    tradingModels: "LifeOps/Knowledge/TradeRules",
    tradingReviews: "LifeOps/TradeReview",
    health: "LifeOps/Goals/Health",
    aiReports: "LifeOps/Output/AI",
    goals: "LifeOps/Goals",
    outputs: "LifeOps/Output"
  },
  habits: [],
  ai: {
    provider: "off",
    endpoint: "https://api.moonshot.cn/v1/chat/completions",
    apiKey: "",
    model: "kimi-k2.6",
    fallbackProvider: "off",
    fallbackEndpoint: "",
    fallbackApiKey: "",
    fallbackModel: "",
    confidenceThreshold: 0.78,
    dataDisclosureAccepted: false
  },
  vision: {
    provider: "off",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    apiKey: "",
    model: "qwen3.7-flash",
    cameraEnabled: false,
    cameraMode: "off",
    snapshotIntervalMs: 60000,
    privacyNoticeAccepted: false,
    screenEnabled: false,
    screenPrivacyNoticeAccepted: false,
    screenAnalysisMinIntervalMs: 30000,
    remoteDataDisclosureAccepted: false
  },
  embedding: {
    provider: "off",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings",
    apiKey: "",
    model: "text-embedding-v4",
    topK: 5,
    dataDisclosureAccepted: false
  },
  voice: {
    provider: "off",
    endpoint: "",
    apiKey: "",
    model: "",
    language: "zh",
    aliyunAccessKeyId: "",
    aliyunAccessKeySecret: "",
    aliyunAppKey: "",
    aliyunRegionId: "cn-beijing",
    aliyunEndpoint: "tingwu.cn-beijing.aliyuncs.com",
    ossRegion: "oss-cn-shanghai",
    ossBucket: "",
    ossPrefix: "lifeops/voice",
    ossSignedUrlExpires: 3600,
    pollIntervalMs: 3000,
    pollTimeoutMs: 120000,
    dataDisclosureAccepted: false
  },
  realtimeVoice: {
    provider: "qwen-omni-realtime",
    mode: "cascade",
    vadSilenceMs: 700,
    endpoint: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    apiKey: "",
    model: "qwen3.5-omni-plus-realtime-2026-03-15",
    ttsModel: "qwen3-tts-flash-realtime",
    ttsEngine: "bailian",
    breeze: { home: "", python: "", referenceAudio: "", referenceText: "" },
    ttsVoice: "Cherry",
    omniVoice: "Tina",
    ttsSampleRate: 24000,
    language: "zh-CN",
    autoSendOnStop: true,
    cloudFallback: true,
    speakReplies: true,
    triggerEnabled: false,
    triggerPhrases: "小管家",
    triggerSessionTimeoutSec: 45,
    dataDisclosureAccepted: false,
    plaintextCredentialStorageAccepted: false
  },
  gateway: {
    inboxFile: "LifeOps/Inbox/外部输入.md",
    sharedSecret: ""
  },
  proactive: { ...DEFAULT_PROACTIVE_RUNTIME_SETTINGS },
  privacy: {
    excludedVaultPrefixes: [],
    plaintextCredentialStorageAccepted: false
  }
};
