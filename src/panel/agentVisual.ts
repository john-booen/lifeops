export type AgentVisualActivity = "idle" | "listening" | "thinking" | "speaking";

export class LifeOpsAgentVisual {
  private animation = 0;
  private readonly window: Window | null;
  private readonly reduce: MediaQueryList | undefined;
  private readonly dots = Array.from({ length: 500 }, (_, index) => {
    const progress = index / 500;
    const angle = progress * Math.PI * 12;
    const radius = 1.05 + Math.floor(index / 63) * 0.14 + Math.sin(angle * 0.7) * 0.22;
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius * 0.54, z: (progress - 0.5) * 4.6 };
  });

  constructor(private readonly canvas: HTMLCanvasElement, private readonly activity: AgentVisualActivity) {
    this.window = canvas.ownerDocument.defaultView;
    this.reduce = this.window?.matchMedia?.("(prefers-reduced-motion: reduce)");
  }

  start(): void {
    if (!this.window) return;
    this.window.addEventListener("resize", this.resize);
    this.canvas.ownerDocument.addEventListener("visibilitychange", this.resize);
    this.reduce?.addEventListener?.("change", this.resize);
    this.resize();
  }

  dispose(): void {
    this.window?.removeEventListener("resize", this.resize);
    this.canvas.ownerDocument.removeEventListener("visibilitychange", this.resize);
    this.reduce?.removeEventListener?.("change", this.resize);
    this.window?.cancelAnimationFrame(this.animation);
    this.animation = 0;
  }

  private readonly resize = () => {
    if (!this.window) return;
    this.window.cancelAnimationFrame(this.animation);
    this.animation = 0;
    if (this.canvas.ownerDocument.hidden) return;
    const rect = this.canvas.getBoundingClientRect();
    const density = Math.min(this.window.devicePixelRatio || 1, 1.5);
    this.canvas.width = Math.max(1, Math.round(rect.width * density));
    this.canvas.height = Math.max(1, Math.round(rect.height * density));
    this.paint(0);
  };

  private readonly paint = (time: number) => {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const { width, height } = this.canvas;
    const pulse = this.activity === "idle" ? 0.035 : 0.09;
    const scale = Math.min(width, height) * (1 + Math.sin(time / 500) * pulse);
    const turn = time / (this.activity === "idle" ? 5000 : 2700);
    const sin = Math.sin(turn), cos = Math.cos(turn);
    ctx.clearRect(0, 0, width, height);
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < this.dots.length; i++) {
      const { x, y, z } = this.dots[i];
      const depth = 7.2 - (x * sin + z * cos);
      const px = width / 2 + (x * cos - z * sin) * scale / depth;
      const py = height / 2 + y * scale / depth;
      const opacity = Math.max(0.08, Math.min(0.65, 0.74 - depth / 15));
      const color = this.activity === "speaking" && i % 3 === 0 ? "168, 183, 244" : "86, 174, 240";
      ctx.fillStyle = `rgba(${color}, ${opacity})`;
      const size = Math.max(0.7, scale / depth * 0.036);
      ctx.fillRect(px, py, size, size);
    }
    if (!this.reduce?.matches && this.canvas.isConnected) this.animation = this.window?.requestAnimationFrame(this.paint) ?? 0;
  };
}
