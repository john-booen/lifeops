const RETIRED_RESPONSE_LIMIT = 512;

/** Keeps a native response and its late messages tied to this connection. */
export class OmniResponseIdentity {
  private current = "";
  private readonly retired = new Set<string>();

  get active(): string { return this.current; }

  isRetired(id: string): boolean { return this.retired.has(id); }

  retire(id: string): void {
    if (this.retired.has(id)) return;
    if (this.retired.size >= RETIRED_RESPONSE_LIMIT) this.retired.delete(this.retired.values().next().value!);
    this.retired.add(id);
  }

  bindCreated(id: string, cancelling: boolean): boolean {
    if (!id || this.isRetired(id) || this.current && !cancelling && id !== this.current) return false;
    this.current = id;
    return true;
  }

  acceptOutput(id: string, cancelling: boolean): "bound" | "current" | undefined {
    if (cancelling || id && (this.isRetired(id) || this.current && id !== this.current)) return;
    if (!id || this.current) return "current";
    this.current = id;
    return "bound";
  }

  clear(id = ""): boolean {
    if (id && this.current && id !== this.current) return false;
    this.current = "";
    return true;
  }

  clearRetired(): void { this.retired.clear(); }
}
