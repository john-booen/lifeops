import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { realtimeVoiceReadiness, textAiReadiness } from "../src/capabilityReadiness";
import type { LifeOpsSettings } from "../src/types";

const notices = vi.hoisted(() => [] as string[]);
const socketCreated = vi.hoisted(() => vi.fn());
vi.mock("obsidian", () => ({
  Notice: class { constructor(message: string) { notices.push(message); } },
  ItemView: class {}, WorkspaceLeaf: class {}, setIcon: vi.fn()
}));
vi.mock("ws", () => ({ default: class { constructor() { socketCreated(); throw new Error("Network forbidden"); } } }));
const { applyComposerPanel } = await import("../src/panel/composer");
const { startBailianRealtimeRecording } = await import("../src/voice/voiceRealtime");

function configured(): LifeOpsSettings {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.ai.provider = "openai-compatible";
  settings.ai.apiKey = "test-text-key";
  settings.ai.dataDisclosureAccepted = true;
  settings.privacy!.plaintextCredentialStorageAccepted = true;
  settings.realtimeVoice.apiKey = "test-voice-key";
  settings.realtimeVoice.dataDisclosureAccepted = true;
  settings.realtimeVoice.plaintextCredentialStorageAccepted = true;
  return settings;
}

function host(settings: LifeOpsSettings) {
  class Panel {}
  applyComposerPanel(Panel);
  return Object.assign(new Panel(), {
    controller: { settings, openStewardSettings: vi.fn() },
    agentMode: "voice", agentRecording: false, agentBusy: false, agentInput: "尚未发送的文字",
    agentVoiceConversation: false, agentReply: "", agentWorkspaceOpen: false,
    render: vi.fn(async () => {}), refreshAgentSurfaceState: vi.fn(), recoverTimedOutAgentBusy: vi.fn(),
    interruptAgentSpeech: vi.fn(), startVoiceTrace: vi.fn(),
    startBailianRealtimeRecording: vi.fn(async () => {}), startFallbackAgentRecording: vi.fn(async () => {}),
    sendAgentMessage: vi.fn(async () => {}), agentReplyModeButton: vi.fn()
  }) as any;
}

let getUserMedia: ReturnType<typeof vi.fn>;
beforeEach(() => {
  notices.length = 0;
  socketCreated.mockClear();
  getUserMedia = vi.fn(() => { throw new Error("Microphone forbidden"); });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("MediaRecorder", class {});
});
afterEach(() => vi.unstubAllGlobals());

describe("capability configuration presentation", () => {
  it("distinguishes an intentionally disabled provider from a missing credential without mutating settings", () => {
    const settings = configured();
    settings.ai.provider = "off";
    settings.realtimeVoice.provider = "off";
    const before = structuredClone(settings);
    expect(textAiReadiness(settings)).toMatchObject({ ready: false, code: "off" });
    expect(realtimeVoiceReadiness(settings)).toMatchObject({ ready: false, code: "off" });
    expect(realtimeVoiceReadiness(settings).message).not.toMatch(/需要.*Key|缺少.*密钥|常驻监听/);
    expect(settings).toEqual(before);
  });

  it("requires the text-model stage for cascade but does not remove the existing e2e path", () => {
    const settings = configured();
    settings.ai.provider = "off";
    expect(realtimeVoiceReadiness(settings)).toMatchObject({ ready: false, code: "text-required" });
    settings.realtimeVoice.mode = "omni-e2e";
    expect(realtimeVoiceReadiness(settings).ready).toBe(true);
  });

  it("keeps supported unauthenticated custom text endpoints usable", () => {
    const settings = configured();
    settings.ai.provider = "custom";
    settings.ai.endpoint = "http://localhost:1234/v1/chat/completions";
    settings.ai.apiKey = "";
    settings.privacy!.plaintextCredentialStorageAccepted = false;
    expect(textAiReadiness(settings).ready).toBe(true);
  });

  it("shows the disabled hint while preserving the text draft, send action and settings entry", () => {
    const settings = configured(); settings.ai.provider = "off";
    const view = host(settings); view.agentMode = "text";
    const nodes: any[] = [];
    const element = (tag = "div", options: any = {}): any => {
      const node: any = { tag, ...options, empty: vi.fn(), addEventListener: vi.fn() };
      node.createDiv = (options: any = {}) => element("div", options);
      node.createSpan = (options: any = {}) => element("span", options);
      node.createEl = (tag: string, options: any = {}, callback?: (node: any) => void) => {
        const child = element(tag, options); callback?.(child); return child;
      };
      nodes.push(node); return node;
    };
    view.renderAgentComposer(element());
    expect(nodes.some(node => node.text?.includes("文字 AI 尚未开启"))).toBe(true);
    const input = nodes.find(node => node.tag === "textarea");
    expect(input.value).toBe("尚未发送的文字");
    const send = nodes.find(node => node.cls === "lifeops-agent-send");
    expect(send.disabled).toBe(false); send.onclick();
    expect(view.sendAgentMessage).toHaveBeenCalledOnce();
    nodes.find(node => node.text === "查看设置").onclick();
    expect(view.controller.openStewardSettings).toHaveBeenCalledOnce();
    view.sendAgentMessage.mockClear();
    input.onkeydown({ key: "Enter", preventDefault: vi.fn() });
    expect(view.sendAgentMessage).toHaveBeenCalledOnce();
    input.onkeydown({ key: "Enter", shiftKey: true, preventDefault: vi.fn() });
    expect(view.sendAgentMessage).toHaveBeenCalledOnce();
  });
});

describe("microphone preflight", () => {
  const blockers: Array<[string, (settings: LifeOpsSettings) => void]> = [
    ["off", settings => { settings.realtimeVoice.provider = "off"; }],
    ["missing voice credential", settings => { settings.realtimeVoice.apiKey = ""; }],
    ["voice disclosure", settings => { settings.realtimeVoice.dataDisclosureAccepted = false; }],
    ["global storage consent", settings => { settings.privacy!.plaintextCredentialStorageAccepted = false; }],
    ["voice storage consent", settings => { settings.realtimeVoice.plaintextCredentialStorageAccepted = false; }],
    ["cascade text off", settings => { settings.ai.provider = "off"; }],
    ["cascade text disclosure", settings => { settings.ai.dataDisclosureAccepted = false; }],
    ["cascade text model missing", settings => { settings.ai.model = " "; }]
  ];

  it.each(blockers)("blocks %s in the direct realtime entry before microphone and transport", async (_name, change) => {
    const settings = configured(); change(settings);
    const view = host(settings);
    await startBailianRealtimeRecording(view);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(socketCreated).not.toHaveBeenCalled();
    expect(view.agentVoiceConversation).toBe(false);
    expect(view.agentInput).toBe("尚未发送的文字");
    expect(view.agentReply).toBe(realtimeVoiceReadiness(settings).message);
    expect(view.agentReply).not.toContain("test-voice-key");
  });

  it("does not turn disabled standby into a missing-key notice or fallback capture", async () => {
    const settings = configured(); settings.realtimeVoice.provider = "off";
    const view = host(settings);
    await view.ensureVoiceStandby();
    await view.startAgentRecording();
    expect(view.agentReply).toContain("语音尚未开启");
    expect(view.agentReply).not.toContain("Key");
    expect(view.startBailianRealtimeRecording).not.toHaveBeenCalled();
    expect(view.startFallbackAgentRecording).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("allows a configured cascade into the existing realtime flow without claiming it is already listening", async () => {
    const view = host(configured());
    await view.ensureVoiceStandby();
    expect(view.startBailianRealtimeRecording).toHaveBeenCalledOnce();
    expect(view.startFallbackAgentRecording).not.toHaveBeenCalled();
    expect(view.agentReply).not.toMatch(/常驻监听|我在听/);
    expect(view.agentVoiceConversation).toBe(true);
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});
