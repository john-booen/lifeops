import { ProviderTransportError } from "./providerRun";

interface TextRoute { provider: string; endpoint: string; apiKey: string; model: string }

/** Short-lived routing hints only. The configuration and credentials never
 * leave this client or become part of a provider/audit record. */
export class TextRouteCooldown {
  private scope = "";
  private generation = 0;
  private sequence = 0;
  private blocked = new Map<string, number>();
  private latest = new Map<string, number>();

  prepare<T extends TextRoute>(configs: T[]) {
    const key = (route: TextRoute) => JSON.stringify([route.provider, route.endpoint, route.model, route.apiKey]);
    const scope = JSON.stringify(configs.map(key));
    if (scope !== this.scope) {
      this.scope = scope; this.generation++;
      this.blocked.clear(); this.latest.clear();
    }
    const generation = this.generation, now = Date.now();
    const cooling = (config: T) => {
      const remaining = (this.blocked.get(key(config)) ?? 0) - now;
      return remaining > 0 && remaining <= 60_000;
    };
    // Keep every configured route available if the preferred alternative fails.
    // Stable ordering also preserves the configured primary when both are limited.
    const routes = configs.map((config, index) => ({ config, fallback: index > 0 }))
      .sort((a, b) => Number(cooling(a.config)) - Number(cooling(b.config)));
    const track = async <R>(config: T, execute: () => Promise<R>): Promise<R> => {
      const route = key(config), sequence = ++this.sequence;
      if (this.generation === generation) this.latest.set(route, sequence);
      const current = () => this.generation === generation && this.latest.get(route) === sequence;
      try {
        const result = await execute();
        if (current()) this.blocked.delete(route);
        return result;
      } catch (error) {
        if (current() && error instanceof ProviderTransportError && error.code === "rate_limit" && error.httpStatus === 429) {
          this.blocked.set(route, Date.now() + 60_000);
        }
        throw error;
      }
    };
    return { routes, track };
  }
}
