import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";

const workers = vi.hoisted(() => [] as any[]);
vi.mock("node:child_process", () => ({ spawn: () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn()
  });
  workers.push(child); return child;
} }));
vi.mock("obsidian", () => ({
  ItemView: class {}, WorkspaceLeaf: class {}, Modal: class {}, Notice: class {},
  TFile: class {}, TFolder: class {}, setIcon: vi.fn(), normalizePath: (p: string) => p
}));
import { applyComposerPanel } from "../src/panel/composer";

class Host {}
applyComposerPanel(Host as never);
let directory: string;
let breeze: NonNullable<typeof DEFAULT_SETTINGS.realtimeVoice.breeze>;
function host() {
  return Object.assign(new Host(), {
    controller: { settings: { ...structuredClone(DEFAULT_SETTINGS), realtimeVoice: {
      ...DEFAULT_SETTINGS.realtimeVoice, ttsEngine: "breeze-local", apiKey: "", speakReplies: true, breeze
    } } },
    agentSpeechPlaybackId: 0, agentTtsClient: null, agentSpeaking: false,
    agentSpeechSources: new Set(), agentSpeechAudioContext: { state: "running" }, agentReply: "",
    cleanupAgentSpeechAudio: vi.fn(), refreshAgentSurfaceState: vi.fn(), markVoiceTrace: vi.fn(),
    transitionVoiceSession: vi.fn(), enqueueAgentSpeechAudio: vi.fn(() => true), speakAgentReplyWithSystem: vi.fn()
  }) as any;
}
function frames() { return Buffer.from([0, 0, 0, 2, 1, 2, 0, 0, 0, 2, 3, 4]); }
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "lifeops-breeze-fallback-"));
  await mkdir(join(directory, "work", "breeze-model-4bit"), { recursive: true });
  breeze = { home: directory, python: join(directory, "python"), referenceAudio: join(directory, "reference.wav"), referenceText: "虚构参考文字。" };
  await writeFile(breeze.python, "fictional executable");
  await writeFile(breeze.referenceAudio, "fictional reference");
  workers.length = 0; vi.useFakeTimers(); vi.stubGlobal("window", globalThis);
});
afterEach(async () => {
  for (const child of workers) child.emit("close", null);
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

describe("Breeze through the actual composer methods", () => {
  it("falls back once when the local worker fails before audio, without needing a cloud key", async () => {
    const view = host(), p = view.speakAgentReplyWithBailian("纯虚构完整回复");
    expect(workers).toHaveLength(1); workers[0].emit("close", 1); await p;
    expect(view.speakAgentReplyWithSystem).toHaveBeenCalledExactlyOnceWith("纯虚构完整回复");
  });
  it("keeps full text after partial speech failure and does not repeat it via system speech", async () => {
    const view = host(), text = "纯虚构完整回复，不应被状态提示覆盖。", p = view.speakAgentReplyWithBailian(text);
    workers[0].stdout.write(frames());
    view.controller.settings.realtimeVoice.ttsEngine = "bailian";
    workers[0].emit("close", 1); await p;
    expect(view.speakAgentReplyWithSystem).not.toHaveBeenCalled(); expect(view.agentReply).toBe(text);
    expect(view.agentSpeaking).toBe(false);
  });
  it("discards remaining same-chunk frames after the audio sink triggers fallback", async () => {
    const view = host(); view.enqueueAgentSpeechAudio.mockReturnValue(false);
    const p = view.speakAgentReplyWithBailian("虚构回复"); workers[0].stdout.write(frames()); await p;
    expect(view.enqueueAgentSpeechAudio).toHaveBeenCalledOnce(); expect(view.speakAgentReplyWithSystem).toHaveBeenCalledOnce();
  });
  it("times out a silent cold worker and ignores its later audio", async () => {
    const view = host(), p = view.speakAgentReplyWithBailian("虚构超时回复");
    await vi.advanceTimersByTimeAsync(90_000); await p; workers[0].stdout.write(frames());
    expect(workers[0].kill).toHaveBeenCalledWith("SIGKILL");
    expect(view.speakAgentReplyWithSystem).toHaveBeenCalledOnce(); expect(view.enqueueAgentSpeechAudio).not.toHaveBeenCalled();
  });
});
