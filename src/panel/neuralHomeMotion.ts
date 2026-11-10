/** Owns one decorative loop. It never touches the assistant's media or timers. */
export interface HomeMotionGate {
  active: boolean;
  visible: boolean;
  focused: boolean;
  intersecting: boolean;
  reduced: boolean;
  paused: boolean;
}

export function createHomeMotion(options: {
  request(callback: (time: number) => void): number;
  cancel(id: number): void;
  start(): void;
  stop(): void;
  paint(time: number): void;
}, initial: HomeMotionGate) {
  let gate = { ...initial }, disposed = false, running = false;
  let frame: number | null = null, generation = 0, error: string | null = null;
  let cleanupNeeded = false;
  const enabled = () => !disposed && !error && gate.active && gate.visible && gate.focused
    && gate.intersecting && !gate.reduced && !gate.paused;
  function stop() {
    generation++;
    if (frame !== null) {
      const id = frame; frame = null;
      try { options.cancel(id); } catch { error = "动画取消未完成"; }
    }
    if (running || cleanupNeeded) {
      running = false;
      try { options.stop(); cleanupNeeded = false; } catch { error = "装饰媒体清理未完成"; }
    }
  }
  function schedule(token: number) {
    frame = options.request(time => {
      // A cancelled callback may still arrive after a new loop has started.
      if (token !== generation || !running || !enabled()) return;
      frame = null;
      try { options.paint(time); } catch { error = "动画暂时不可用"; stop(); return; }
      if (token === generation && running && enabled()) {
        try { schedule(token); } catch { error = "动画暂时不可用"; stop(); }
      }
    });
  }
  function reconcile() {
    if (!enabled()) { if (running || frame !== null) stop(); return; }
    if (running) return;
    running = true;
    cleanupNeeded = true;
    const token = ++generation;
    try {
      options.start();
      if (token === generation && running && enabled()) schedule(token);
    } catch { error = "动画暂时不可用"; stop(); }
  }
  return {
    setGate(patch: Partial<HomeMotionGate>) { if (disposed) return; gate = { ...gate, ...patch }; reconcile(); },
    dispose() { if (disposed) return; disposed = true; stop(); },
    snapshot() { return { ...gate, disposed, running, pendingFrame: frame !== null, cleanupNeeded, error }; }
  };
}
