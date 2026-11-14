interface CheckSession { pending: boolean; rerun: boolean }

export class HabitPunishmentLifecycle {
  private timer?: ReturnType<typeof setTimeout>;
  private session?: CheckSession;

  constructor(
    private readonly check: (now: Date, assertCurrent: () => void) => Promise<void>,
    private readonly now = () => new Date()
  ) {}

  start(): void {
    if (this.session) return;
    const session = this.session = { pending: false, rerun: false };
    this.run(session);
    this.schedule(session);
  }

  stop(): void {
    this.session = undefined;
    clearTimeout(this.timer);
  }

  private schedule(session: CheckSession): void {
    const now = this.now(), next = new Date(now);
    next.setHours(now.getHours() + 1, 0, 0, 0);
    this.timer = setTimeout(() => {
      if (this.session !== session) return;
      this.run(session);
      this.schedule(session);
    }, next.getTime() - now.getTime());
  }

  private run(session: CheckSession): void {
    if (session.pending) {
      session.rerun = true;
      return;
    }
    session.pending = true;
    const assertCurrent = () => {
      if (this.session !== session) throw Error("晚间习惯判定已停止。");
    };
    void this.check(this.now(), assertCurrent).catch(() => {
      if (this.session === session) console.warn("LifeOps 晚间习惯判定未保存，请检查任务和习惯记录。");
    }).finally(() => {
      session.pending = false;
      if (this.session === session && session.rerun) {
        session.rerun = false;
        this.run(session);
      }
    });
  }
}
