import { newLocalOperationId } from "../operationIdentity";
import type { StoreHost } from "../store/settingsSlice";
import { OperationLedger } from "./operationLedger";
import { needsTradingHistoryMigration, persistTradingDocument, readTradingDocument } from "./tradingPersistence";

export async function migrateTradingHistory(store: StoreHost, assertCurrent?: () => void): Promise<boolean> {
  if (!store.runFactOperation) return false;
  assertCurrent?.();
  if (!needsTradingHistoryMigration(await readTradingDocument(store))) return false;

  assertCurrent?.();
  const ledger = new OperationLedger(store);
  const operationId = newLocalOperationId("m2-trading-migration");
  const claim = await ledger.claim({ operationId, toolName: "migrate_m2_trading_history", source: "system", arguments: { version: 1 } });
  if (claim.kind !== "execute") throw new Error("交易研究迁移尚未就绪。");
  try {
    return await store.runFactOperation({ operationId }, async scope => {
      const document = await readTradingDocument(scope);
      if (!needsTradingHistoryMigration(document)) return false;
      await persistTradingDocument(scope, document);
      return true;
    }, async migrated => {
      await ledger.verify(operationId, { success: true, actions: [], output: migrated ? "已兼容旧交易研究记录。" : "交易研究已兼容。" });
    }, { assertCurrent });
  } catch (error) {
    await ledger.failClaim(claim.record, "交易研究迁移未完成，请检查原记录或恢复备份。").catch(() => undefined);
    throw error;
  }
}
