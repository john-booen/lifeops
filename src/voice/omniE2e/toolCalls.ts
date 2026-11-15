import { mergeOmniToolArguments, normalizeOmniToolCall, responseEventId } from "./protocol";

interface ToolBatch {
  responseId: string;
  callIds: Set<string>;
  pendingCallIds: Set<string>;
  responseDone: boolean;
}

interface AcceptedToolCall {
  duplicate: false;
  toolCall: NonNullable<ReturnType<typeof normalizeOmniToolCall>>;
  responseId: string;
  batch?: ToolBatch;
}

/** Tracks raw tool frames and when a response can continue after local calls. */
export class OmniToolCalls {
  private readonly argumentBuffers = new Map<string, string>();
  private readonly handledCallIds = new Set<string>();
  private batch?: ToolBatch;

  get hasContinuation(): boolean { return this.batch !== undefined; }

  accumulate(event: Record<string, unknown>): void {
    mergeOmniToolArguments(this.argumentBuffers, event);
  }

  accept(event: Record<string, unknown>, activeResponseId: string): AcceptedToolCall | { duplicate: true } | undefined {
    const toolCall = normalizeOmniToolCall(event, this.argumentBuffers);
    if (!toolCall) return;
    if (this.handledCallIds.has(toolCall.id)) return { duplicate: true };
    this.handledCallIds.add(toolCall.id);
    this.argumentBuffers.delete(toolCall.id);
    const responseId = responseEventId(event) || activeResponseId;
    if (responseId) {
      const batch = this.batch ??= { responseId, callIds: new Set(), pendingCallIds: new Set(), responseDone: false };
      batch.callIds.add(toolCall.id);
      batch.pendingCallIds.add(toolCall.id);
    }
    return { duplicate: false, toolCall, responseId, batch: this.batch };
  }

  markResponseDone(responseId: string): void {
    if (this.batch?.responseId === responseId) this.batch.responseDone = true;
  }

  markCallSent({ batch, responseId, toolCall }: AcceptedToolCall): boolean {
    if (!batch || batch.responseId !== responseId) return false;
    batch.pendingCallIds.delete(toolCall.id);
    return true;
  }

  takeReadyContinuation(): { previousResponseId: string; callIds: string[] } | undefined {
    const batch = this.batch;
    if (!batch || !batch.responseDone || batch.pendingCallIds.size) return;
    this.batch = undefined;
    return { previousResponseId: batch.responseId, callIds: [...batch.callIds] };
  }

  clearHandledCalls(): void { this.handledCallIds.clear(); }

  invalidate(): void {
    this.argumentBuffers.clear();
    this.batch = undefined;
  }
}
