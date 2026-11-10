export type LifeOpsEventType =
  | "vault.created"
  | "vault.modified"
  | "vault.deleted"
  | "vault.renamed"
  | "conversation.user_message"
  | "conversation.assistant_reply"
  | "camera.observation"
  | "desktop.observation"
  | "sensor.disabled"
  | "task.changed"
  | "habit.changed"
  | "proactive.candidate"
  | "proactive.delivered"
  | "proactive.feedback";

export interface LifeOpsEvent<T = unknown> {
  id: string;
  type: LifeOpsEventType;
  occurredAt: string;
  source: "vault" | "conversation" | "camera" | "desktop" | "runtime";
  payload: T;
}

export type LifeOpsEventListener = (event: LifeOpsEvent<unknown>) => void | Promise<void>;

export class LifeOpsEventBus {
  private readonly listeners = new Set<LifeOpsEventListener>();

  subscribe(listener: LifeOpsEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish<T>(
    event: Omit<LifeOpsEvent<T>, "id" | "occurredAt"> & Partial<Pick<LifeOpsEvent<T>, "id" | "occurredAt">>
  ): LifeOpsEvent<T> {
    const occurredAt = event.occurredAt ?? new Date().toISOString();
    const complete: LifeOpsEvent<T> = {
      ...event,
      id: event.id ?? `event_${hashText(`${event.type}:${occurredAt}:${JSON.stringify(event.payload)}`)}`,
      occurredAt
    };
    for (const listener of this.listeners) {
      try {
        void Promise.resolve(listener(complete as LifeOpsEvent<unknown>)).catch(() => undefined);
      } catch {
        // One observer cannot block the producer or other observers.
      }
    }
    return complete;
  }

  clear(): void {
    this.listeners.clear();
  }
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
