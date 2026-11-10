export class HabitPunishmentLifecycle {
  private timer?: ReturnType<typeof setTimeout>;
  private session?: object;

  constructor(
    private readonly check: (now: Date, assertCurrent: () => void) => Promise<void>,
    private readonly now = () => new Date()
  ) {}

  start(): void {
    if (this.session) return;
    const session = this.session = {};
    if (this.now().getHours() >= 21) this.run(session);
    this.schedule(session);
  }

  stop(): void {
    this.session = undefined;
    clearTimeout(this.timer);
  }

  private schedule(session: object): void {
    const now = this.now(), next = new Date(now);
    next.setHours(21, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    this.timer = setTimeout(() => {
      if (this.session !== session) return;
      this.run(session);
      this.schedule(session);
    }, next.getTime() - now.getTime());
  }

  private run(session: object): void {
    const now = this.now();
    if (now.getHours() < 21) return;
    const assertCurrent = () => {
      if (this.session !== session) throw Error("晚间习惯判定已停止。");
    };
    void this.check(now, assertCurrent).catch(() => {
      if (this.session === session) console.warn("LifeOps 晚间习惯判定未保存，请检查任务和习惯记录。");
    });
  }
}
