import type { TradeDraft } from "./types";

type Candidate = Pick<TradeDraft, "openedAt" | "openedAtPrecision" | "symbol" | "direction" | "qty">;
const windowMs = 60_000;

export function tradeDeduplication(existing: readonly Candidate[]) {
  const buckets = new Map<string, number[]>();
  const key = (trade: Candidate, bucket: number) => JSON.stringify([trade.symbol.trim().toUpperCase(), trade.direction, trade.qty, bucket]);
  const stamp = (trade: Candidate) => trade.qty === undefined || trade.openedAtPrecision === "date" ? undefined : Date.parse(trade.openedAt);
  const add = (trade: Candidate) => {
    const time = stamp(trade);
    if (time === undefined || !Number.isFinite(time)) return;
    const id = key(trade, Math.floor(time / windowMs)), group = buckets.get(id);
    if (group) group.push(time);
    else buckets.set(id, [time]);
  };
  existing.forEach(add);
  return {
    add,
    duplicate(trade: Candidate): boolean {
      const time = stamp(trade);
      if (time === undefined || !Number.isFinite(time)) return false;
      const bucket = Math.floor(time / windowMs);
      return [bucket - 1, bucket, bucket + 1].some(part => buckets.get(key(trade, part))?.some(other => Math.abs(time - other) <= windowMs));
    }
  };
}
