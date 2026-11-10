import type { StoreHost } from "../store/settingsSlice";
import { DataProtectionError, parseJsonData } from "./jsonDataGuard";
import { fileRevision, isGuardedOperationScope } from "./factOperation";
import { emptyTradingDocument, normalizeTradingHistory, tradingDocumentPath, validateTradingDocument, type TradingDocument } from "../tradingResearch";
export { tradingDocumentPath } from "../tradingResearch";
export const tradingReadSnapshot=Symbol("lifeops-trading-read-snapshot");
type SnapshotDocument=TradingDocument&{[tradingReadSnapshot]?:{raw:string|null}};
export function tradingConflict():never{throw new Error("交易研究记录已变化，已停止覆盖；请重新核对最新版本和案例。");}
const contract={root:"object" as const,version:1 as const,arrays:["models","cases"],validate:validateTradingDocument};
const raw=(store:StoreHost)=>store.getFile(tradingDocumentPath(store))?store.readPath(tradingDocumentPath(store)):Promise.resolve(null);
export async function readTradingDocument(store:StoreHost):Promise<SnapshotDocument>{const text=await raw(store),path=tradingDocumentPath(store),document=text===null?emptyTradingDocument():parseJsonData(text,path,contract);if(!validateTradingDocument(document))throw new DataProtectionError(path,"shape");return {...normalizeTradingHistory(document),[tradingReadSnapshot]:{raw:text}};}
export function tradingDocumentRevision(document:SnapshotDocument):string{return fileRevision(document[tradingReadSnapshot]!.raw);}
export function needsTradingHistoryMigration(document: SnapshotDocument): boolean {
  const text = document[tradingReadSnapshot]?.raw;
  return text != null && JSON.stringify(JSON.parse(text)) !== JSON.stringify(document);
}
export async function persistTradingDocument(store:StoreHost,document:SnapshotDocument):Promise<void>{
  if(!isGuardedOperationScope(store))throw new Error("交易研究须通过确认后可恢复的保存入口修改。");
  const path=tradingDocumentPath(store),snapshot=document[tradingReadSnapshot];if(!snapshot||!validateTradingDocument(document))throw new DataProtectionError(path,"shape");
  const next=JSON.stringify(document,null,2)+"\n";if(await raw(store)!==snapshot.raw)tradingConflict();const file=store.getFile(path);
  if(file)await store.app.vault.process(file,current=>{if(current!==snapshot.raw)tradingConflict();parseJsonData(current,path,contract);return next;});
  else{await store.ensureFolder(store.settings.folders.tradingModels);await store.app.vault.create(path,next);}
  if(await raw(store)!==next)throw new Error("交易研究保存后核对失败，请先恢复这次操作。");document[tradingReadSnapshot]={raw:next};
}
