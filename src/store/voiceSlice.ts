import type { StoreHost } from "./settingsSlice";

type StoreConstructor = { prototype: object };
export interface VoiceSliceApi {
  writeVoiceRuntimeSelfTestReport(report: unknown): Promise<string>;
  writeVoiceAgentSelfTestReport(report: unknown): Promise<string>;
}

const voiceSlice = {
async writeVoiceRuntimeSelfTestReport(this: StoreHost, report: unknown): Promise<string> {
    const filePath = this.path(this.settings.folders.aiReports, "Quality", "voice-runtime-self-test.json");
    await this.writeJson(filePath, report);
    return filePath;
  },

async writeVoiceAgentSelfTestReport(this: StoreHost, report: unknown): Promise<string> {
    const filePath = this.path(this.settings.folders.aiReports, "Quality", "voice-agent-self-test.json");
    await this.writeJson(filePath, report);
    return filePath;
  },
};

export function applyVoiceSlice(Store: StoreConstructor): void {
  Object.assign(Store.prototype, voiceSlice);
}
