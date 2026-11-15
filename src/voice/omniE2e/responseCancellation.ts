const RESPONSE_CANCEL_TIMEOUT_MS = 2_000;

export const UNCONFIRMED_VOICE_CANCEL_MESSAGE = "语音取消未获确认，旧连接已停止；重新连接后请重说刚才一句。";

export class OmniResponseCancellation {
  private waiting = false;
  private timer?: number;

  get pending(): boolean { return this.waiting; }

  begin(): void { this.waiting = true; }

  arm(onExpired: () => void): void {
    if (!this.waiting || this.timer !== undefined) return;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      onExpired();
    }, RESPONSE_CANCEL_TIMEOUT_MS);
  }

  reset(): void {
    this.waiting = false;
    if (this.timer === undefined) return;
    window.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
