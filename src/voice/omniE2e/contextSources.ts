import type { BailianRealtimeClient } from "../../bailianRealtime";

export const CONTEXT_CHANGED_MESSAGE = "语音资料刚刚变化，旧回复已停止。请重新查询。";

type ProtectedContextClient = Pick<BailianRealtimeClient, "assertContextSourcesCurrent" | "assertContextSourcesCurrentNow">;

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
