import type { BailianRealtimeClient } from "../../bailianRealtime";
import type { RealtimeInstructionsBoundary } from "../realtimeInstructionsBoundary";

export const CONTEXT_CHANGED_MESSAGE = "语音资料刚刚变化，旧回复已停止。请重新查询。";

type ProtectedContextClient = Pick<BailianRealtimeClient, "assertContextSourcesCurrent" | "assertContextSourcesCurrentNow">;

export async function checkActiveOmniSources(
  view: { agentRealtimeClient?: BailianRealtimeClient | null },
  capturePresentation: () => () => boolean,
  onInvalid: () => void
): Promise<boolean> {
  const client = view.agentRealtimeClient;
  if (!client?.hasProtectedContextSources?.()) return true;
  const presentationCurrent = capturePresentation();
  return checkContextSources(client, () => view.agentRealtimeClient === client && presentationCurrent(), onInvalid);
}

export async function checkContextSources(client: ProtectedContextClient, isCurrent: () => boolean, onInvalid: () => void): Promise<boolean> {
  try {
    await client.assertContextSourcesCurrent();
    if (!isCurrent()) return false;
    client.assertContextSourcesCurrentNow();
    return true;
  } catch {
    if (isCurrent()) onInvalid();
    return false;
  }
}

interface ResponseContextHost {
  hasProtectedSources(): boolean;
  assertSourcesCurrent(): Promise<void>;
  assertSourcesCurrentNow(): void;
}

export async function prepareOmniResponseContext(
  host: ResponseContextHost,
  instructions: RealtimeInstructionsBoundary | undefined,
  current: () => boolean,
  send: () => void
): Promise<void> {
  await host.assertSourcesCurrent();
  if (!current()) return;
  const snapshot = await instructions?.prepareForResponse(current);
  try {
    if (!current()) return;
    if (host.hasProtectedSources()) await host.assertSourcesCurrent();
    if (!current()) return;
    await snapshot?.assertSourcesCurrent?.();
    if (!current()) return;
    snapshot?.assertCurrent();
    await host.assertSourcesCurrent();
    if (!current()) return;
    snapshot?.assertCurrent();
    host.assertSourcesCurrentNow();
    send();
  } finally { snapshot?.dispose(); }
}
