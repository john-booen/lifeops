import { textAiReadiness } from "../../capabilityReadiness";
import { hasPendingFactOperation } from "../../dataFoundation/factOperation";
import { jsonDataContract, parseJsonData, serializeJsonData } from "../../dataFoundation/jsonDataGuard";
import { readScopedMarkdown } from "../../dataFoundation/markdownSources";
import { OperationLedger } from "../../dataFoundation/operationLedger";
import { configuredCredentials, redactSensitiveText } from "../../credentialSecurity";
import { todayString } from "../../date";
import type { LifeOpsEventBus } from "../../lifeOpsEventBus";
import { newLocalOperationId, recordRevision } from "../../operationIdentity";
import { isVaultPathExcluded } from "../../privacy";
import { ProviderRunFailure } from "../../providerRun";
import type { StoreHost } from "../../store/settingsSlice";
import type { AgentActionSuggestion, AgentResponse } from "../../types";
import {
  PHONE_INBOX_PATH, PHONE_INBOX_STATE, isPhoneInboxAction, isPhoneInboxTool, parsePhoneInbox, phoneInboxLabels,
  validPhoneInboxDocument, type PhoneInboxDecision, type PhoneInboxDocument, type PhoneInboxLine, type PhoneInboxReceipt, type PhoneInboxRecord,
  type PhoneInboxSnapshot, type PhoneInboxTurn
} from "./model";

const EMPTY_NOTE = "# 手机随手记\n";
const MAX_BATCH_LINES = 20;
const RECEIPT_CHANGED = "手机随手记回执已变化，请重新打开核对。";

function receiptRevisions(records: readonly PhoneInboxRecord[]): Map<string, string> {
  return new Map(records.map(row => [row.id, recordRevision(row)]));
}

export class PhoneInboxBusyError extends Error {
  constructor() { super("另一个保存还没结束，待处理记录暂缓检查。"); }
}

interface PhoneInboxHost {
  store(): StoreHost;
  enabled(): boolean;
  submit(text: string, turn: PhoneInboxTurn, signal: AbortSignal): Promise<AgentResponse>;
  confirm(action: AgentActionSuggestion, turn: PhoneInboxTurn): Promise<void>;
  undo(id: string): Promise<boolean>;
  notify(message: string): void;
}

interface PhoneInboxScope {
  store: StoreHost;
  receiptPath: string;
  assertCurrent(): void;
}

export class PhoneInbox {
  private running: Promise<void> = Promise.resolve();
  private scheduled?: ReturnType<typeof setTimeout>;
  private activeSubmission?: { controller: AbortController; scope: PhoneInboxScope };
  private stopped = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly host: PhoneInboxHost, events: LifeOpsEventBus) {
    this.unsubscribe = events.subscribe(event => {
      if (!["vault.created", "vault.modified", "vault.renamed"].includes(event.type)) return;
      if ((event.payload as { path?: string }).path === PHONE_INBOX_PATH) this.schedule();
    });
  }

  get enabled(): boolean {
    return !this.stopped && this.host.enabled() && this.allowed(this.host.store());
  }

  get autoProcessingReady(): boolean {
    return this.enabled && textAiReadiness(this.host.store().settings).ready;
  }

  schedule(delay = 650): void {
    clearTimeout(this.scheduled);
    const active = this.activeSubmission;
    if (active) {
      try { active.scope.assertCurrent(); }
      catch { active.controller.abort(); }
    }
    if (!this.enabled) return;
    this.scheduled = setTimeout(() => void this.scan().catch(() =>
      this.host.notify("手机随手记暂时无法读取或处理，请打开回执核对。")), delay);
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe();
    clearTimeout(this.scheduled);
    this.activeSubmission?.controller.abort();
  }

  async list(): Promise<PhoneInboxReceipt[]> {
    return (await this.snapshot()).receipts;
  }

  async snapshot(): Promise<PhoneInboxSnapshot> {
    if (!this.enabled) return { receipts: [], source: "unreadable", pending: 0, unfinished: 0 };
    const scope = this.scope();
    const { store } = scope;
    const doc = await this.read(scope);
    const exists = !!store.getFile(PHONE_INBOX_PATH);
    const lines = exists ? await this.lines(scope, true).catch(() => undefined) : undefined;
    const positions = new Map(lines?.map(line => [line.id, line]));
    await this.restoreReceipts(scope, doc.records);
    scope.assertCurrent();
    const receipts = doc.records.slice().reverse().map(row => {
      const source = positions.get(row.id);
      if (!source) return { ...row, sourceUnavailable: true as const };
      const sourceEditing = row.status === "confirm" && requiresPhoneLineEnding(row) && !source.terminated;
      return { ...row, line: source.line, ...(sourceEditing ? { sourceEditing: true as const } : {}) };
    });
    const known = new Set(receipts.map(row => row.id));
    let pending = 0, unfinished = 0;
    for (const row of lines ?? []) {
      if (known.has(row.id)) continue;
      if (row.terminated) pending++;
      else unfinished++;
    }
    const revisions = receiptRevisions(doc.records);
    return {
      receipts, source: lines ? "available" : exists ? "unreadable" : "missing", pending, unfinished,
      resolve: (id, decision) => this.resolveReceipt(id, decision, scope, revisions.get(id))
    };
  }

  async createFile(): Promise<void> {
    const { store, assertCurrent } = this.scope();
    assertCurrent();
    await store.ensureFile(PHONE_INBOX_PATH, EMPTY_NOTE);
    this.schedule();
  }

  scan(includeUnterminated = false): Promise<void> {
    return this.serialize(async () => {
      if (!this.enabled) return;
      const scope = this.scope();
      const { store } = scope;
      if (await hasPendingFactOperation(store)) {
        this.schedule(10_000);
        if (includeUnterminated) throw new PhoneInboxBusyError();
        return;
      }
      const doc = await this.read(scope);
      const previous = receiptRevisions(doc.records);
      if (await this.restoreReceipts(scope, doc.records)) await this.write(scope, doc.records, previous);
      if (!store.getFile(PHONE_INBOX_PATH)) return;
      const known = new Set(doc.records.map(row => row.id));
      const eligible = (line: PhoneInboxLine) => !known.has(line.id)
        && (textAiReadiness(store.settings).ready || !!phoneInboxReviewReason(store, line));
      const scanDate = todayString();
      const lines = (await this.lines(scope, includeUnterminated, scanDate)).filter(eligible);
      const added: PhoneInboxRecord[] = [];
      let pausedBySave = false;
      for (const queued of lines.slice(0, MAX_BATCH_LINES)) {
        if (!this.enabled || store !== this.host.store()) break;
        if (await hasPendingFactOperation(store)) {
          pausedBySave = true;
          this.schedule(10_000);
          break;
        }
        // A sync may have edited or reopened a later line during processing.
        if (!store.getFile(PHONE_INBOX_PATH)) break;
        const currentLines = await this.lines(scope, includeUnterminated, scanDate).catch(error => {
          if (store.getFile(PHONE_INBOX_PATH)) throw error;
          return [];
        });
        const line = currentLines.find(row => row.id === queued.id);
        if (!line || queued.terminated && !line.terminated) {
          this.schedule();
          break;
        }
        const invalid = phoneInboxReviewReason(store, line);
        if (!invalid && !textAiReadiness(store.settings).ready) continue;
        const row = await this.process(scope, line, invalid);
        if (row) added.push(row);
      }
      if (added.length) this.host.notify(summarizePhoneInbox(added));
      if (lines.length > MAX_BATCH_LINES && !pausedBySave && this.enabled && store === this.host.store()) this.schedule();
      if (pausedBySave && includeUnterminated) throw new PhoneInboxBusyError();
    });
  }

  resolve(id: string, decision: PhoneInboxDecision): Promise<void> {
    return this.resolveReceipt(id, decision);
  }

  private resolveReceipt(id: string, decision: PhoneInboxDecision, capturedScope?: PhoneInboxScope, expectedRevision?: string): Promise<void> {
    return this.serialize(async () => {
      const scope = capturedScope ?? this.scope();
      const doc = await this.read(scope);
      const row = doc.records.find(record => record.id === id);
      if (!row) throw Error("找不到这条手机记录。");
      const previous = receiptRevisions([row]);
      const changed = await this.restoreReceipts(scope, [row]);
      if (changed) {
        await this.write(scope, [row], previous);
        previous.set(id, recordRevision(row));
      }
      scope.assertCurrent();
      if (capturedScope && expectedRevision !== recordRevision(row)) throw Error("这条回执已变化，请重新打开核对。");
      if (changed && decision === "confirm" && row.status === "saved") return;
      if (decision === "undo" && row.operationId && !row.undone) {
        await this.assertReceiptCurrent(scope, id, previous.get(id)!);
        if (!await this.host.undo(row.operationId)) throw Error("撤销暂时未完成。");
        row.undone = true;
      } else if (decision === "dismiss" && (row.status === "confirm" || row.status === "review" || row.status === "processing")) {
        row.status = "dismissed";
        delete row.action;
        delete row.pendingOperationId;
      } else if (decision === "confirm" && row.status === "confirm" && row.action) {
        const line = await this.findLine(scope, id);
        if (requiresPhoneLineEnding(row) && !line.terminated) throw Error("这一行已回到编辑状态，请等它写完。");
        const turn = this.turn(scope, line, previous.get(id)!);
        await this.host.confirm(row.action, turn);
        row.operationId = `confirmed:${row.action.id}`;
        row.status = "saved";
        row.message = `已确认并核验 · ${row.action.content}`.slice(0, 2000);
        delete row.action;
      } else throw Error("这条回执已变化，请重新打开核对。");
      await this.write(scope, [row], previous);
    });
  }

  private async process(scope: PhoneInboxScope, line: PhoneInboxLine, invalid: string): Promise<PhoneInboxRecord | undefined> {
    const row: PhoneInboxRecord = { id: line.id, line: line.line, status: "processing", message: "上次处理未读回回执，请核对最近操作。" };
    if (invalid) {
      row.status = "review";
      row.message = invalid;
      return await this.write(scope, [row]) ? row : undefined;
    }
    row.pendingOperationId = `${newLocalOperationId("agent-turn")}:phone`;
    if (!await this.write(scope, [row])) return;
    const revision = recordRevision(row);
    const turn = this.turn(scope, line, revision, row.pendingOperationId);
    const submission = { controller: new AbortController(), scope };
    this.activeSubmission = submission;
    try {
      turn.assertCurrent();
      const response = await this.host.submit(line.text, turn, submission.controller.signal);
      turn.assertCurrent();
      const call = response.toolCalls?.find(item => isPhoneInboxTool(item.name));
      if (call?.ok && isPhoneInboxTool(call.name)) row.tool = call.name;
      const receipt = response.receipts?.[0];
      const action = response.actions.length === 1 ? response.actions[0] : undefined;
      if (receipt) {
        row.operationId = receipt.operationId;
        row.status = "saved";
        delete row.pendingOperationId;
      } else if (isPhoneInboxAction(action)) {
        row.action = action;
        row.status = "confirm";
        row.sourceTerminated = line.terminated;
        delete row.pendingOperationId;
      } else {
        row.status = "review";
      }
      row.message = response.reply.trim().slice(0, 2000) || "请核对对应的保存记录。";
    } catch (error) {
      if (!this.enabled || scope.store !== this.host.store()) throw Error("手机随手记已停止。");
      scope.assertCurrent();
      row.status = "review";
      row.message = error instanceof ProviderRunFailure && error.code === "network"
        ? "文字模型暂时连不上。原文保留，请先核对「最近操作」。"
        : "本条没有读回保存回执。请核对「最近操作」和收件箱原文。";
    } finally {
      if (this.activeSubmission === submission) this.activeSubmission = undefined;
    }
    await this.write(scope, [row], new Map([[row.id, revision]]));
    return row;
  }

  private async restoreReceipts(scope: PhoneInboxScope, records: PhoneInboxRecord[]): Promise<boolean> {
    const { store } = scope;
    const candidates = records.flatMap(row => {
      const id = row.operationId ?? row.pendingOperationId ?? (row.action && `confirmed:${row.action.id}`);
      return id && !row.undone ? [{ row, id }] : [];
    });
    if (!candidates.length) return false;
    const ledger = new OperationLedger(store);
    const allowed = () => !isVaultPathExcluded(ledger.filePath, store.settings.privacy?.excludedVaultPrefixes);
    if (!allowed()) return false;
    try {
      if (await hasPendingFactOperation(store)) return false;
      const { reverted, verified } = await ledger.readSettledOperations(candidates.map(({ id }) => id));
      if (await hasPendingFactOperation(store) || !allowed()) return false;
      scope.assertCurrent();
      let changed = false;
      for (const { row, id } of candidates) {
        const receipt = verified.get(id);
        const tool = receipt?.toolName;
        if (!row.operationId && (reverted.has(id) || receipt && (row.action ? tool === `confirm_${row.action.type}` : isPhoneInboxTool(tool)))) {
          row.operationId = id;
          row.status = "saved";
          row.message = receipt?.output.slice(0, 2000) || "已从最近操作核对回执。";
          if (isPhoneInboxTool(tool)) row.tool = tool;
          delete row.pendingOperationId;
          delete row.action;
          changed = true;
        }
        if (row.operationId && reverted.has(id)) { row.undone = true; changed = true; }
      }
      return changed;
    } catch { return false; }
  }

  private turn(scope: PhoneInboxScope, line: PhoneInboxLine, expectedRevision: string, operationId?: string): PhoneInboxTurn {
    return {
      date: line.date,
      operationId,
      assertCurrent: () => {
        scope.assertCurrent();
        if (hasCredential(scope.store, line.text)) throw Error("这一行疑似含密钥。请去掉密钥后另追加一行。");
      },
      assertLineCurrent: async () => {
        const current = await this.findLine(scope, line.id);
        if (line.terminated && !current.terminated) throw Error("这一行已回到编辑状态，请等它写完。");
        await this.assertReceiptCurrent(scope, line.id, expectedRevision);
      }
    };
  }

  private async findLine(scope: PhoneInboxScope, id: string): Promise<PhoneInboxLine> {
    const line = (await this.lines(scope, true)).find(item => item.id === id);
    if (!line) throw Error("这一行已经修改或移除，请核对收件箱。");
    return line;
  }

  private async lines(scope: PhoneInboxScope, includeUnterminated: boolean, referenceDate = todayString()): Promise<PhoneInboxLine[]> {
    scope.assertCurrent();
    const text = await readScopedMarkdown(scope.store, PHONE_INBOX_PATH);
    scope.assertCurrent();
    return parsePhoneInbox(text, referenceDate, includeUnterminated);
  }

  private async read(scope: PhoneInboxScope): Promise<PhoneInboxDocument> {
    scope.assertCurrent();
    const doc = await scope.store.readJson<PhoneInboxDocument>(scope.receiptPath, { version: 1, records: [] });
    scope.assertCurrent();
    if (!validPhoneInboxDocument(doc)) throw Error("手机随手记回执格式需要核对。");
    return doc;
  }

  private async assertReceiptCurrent(scope: PhoneInboxScope, id: string, revision: string): Promise<void> {
    const latest = (await this.read(scope)).records.find(row => row.id === id);
    if (!latest || recordRevision(latest) !== revision) throw Error(RECEIPT_CHANGED);
  }

  private async write(scope: PhoneInboxScope, records: readonly PhoneInboxRecord[],
    previous: ReadonlyMap<string, string> = new Map()): Promise<boolean> {
    scope.assertCurrent();
    const changes = records.filter(row => recordRevision(row) !== previous.get(row.id));
    if (!changes.length) return false;
    const { store, receiptPath } = scope;
    const file = store.getFile(receiptPath);
    if (!file) {
      if (changes.some(row => previous.has(row.id))) throw Error(RECEIPT_CHANGED);
      await store.writeJson(receiptPath, { version: 1, records: changes });
      return true;
    }
    const contract = jsonDataContract(receiptPath, store.settings.folders);
    let applied = false;
    await store.app.vault.process(file, current => {
      scope.assertCurrent();
      const doc = parseJsonData(current, receiptPath, contract) as PhoneInboxDocument;
      const rows = new Map(doc.records.map(row => [row.id, row]));
      applied = false;
      for (const row of changes) {
        const existing = rows.get(row.id);
        const revision = previous.get(row.id);
        if (existing && revision === undefined) continue;
        if ((existing && recordRevision(existing)) !== revision) throw Error(RECEIPT_CHANGED);
        rows.set(row.id, row);
        applied = true;
      }
      if (!applied) return current;
      const result: PhoneInboxDocument = { ...doc, records: [...rows.values()] };
      if (!validPhoneInboxDocument(result)) throw Error("手机随手记回执格式需要核对。");
      return serializeJsonData(result);
    });
    return applied;
  }

  private statePath(store: StoreHost): string {
    return store.path(store.settings.folders.aiReports, "System", PHONE_INBOX_STATE);
  }

  private allowed(store: StoreHost): boolean {
    const prefixes = store.settings.privacy?.excludedVaultPrefixes;
    return !isVaultPathExcluded(PHONE_INBOX_PATH, prefixes) && !isVaultPathExcluded(this.statePath(store), prefixes);
  }

  private scope(): PhoneInboxScope {
    const store = this.host.store();
    const receiptPath = this.statePath(store);
    return {
      store,
      receiptPath,
      assertCurrent: () => {
        if (!this.enabled || store !== this.host.store() || receiptPath !== this.statePath(store)) {
          throw Error("手机随手记设置已变化。");
        }
      }
    };
  }

  private serialize(work: () => Promise<void>): Promise<void> {
    const result = this.running.then(work);
    this.running = result.catch(() => undefined);
    return result;
  }
}

function phoneInboxReviewReason(store: StoreHost, line: PhoneInboxLine): string {
  if (!line.date) return "请核对日期和时间。可把更正后的记录追加为新行。";
  if (!line.text.trim()) return "这一行没有记录内容。";
  if (line.text.length > 2000) return "这行超过 2000 字，请分成几条再追加。";
  return hasCredential(store, line.text) ? "这一行疑似含密钥。请去掉密钥后另追加一行。" : "";
}

function requiresPhoneLineEnding(row: PhoneInboxRecord): boolean {
  // Older confirmations did not record whether the last line was complete.
  return row.sourceTerminated !== false;
}

function hasCredential(store: StoreHost, text: string): boolean {
  const normalized = text.normalize("NFKC");
  const values = configuredCredentials(store.settings);
  return redactSensitiveText(text, values) !== text || redactSensitiveText(normalized, values) !== normalized;
}

export function summarizePhoneInbox(records: PhoneInboxRecord[]): string {
  const saved = new Map<string, number>();
  for (const row of records) {
    if (row.status !== "saved" || row.undone) continue;
    const label = row.tool ? phoneInboxLabels[row.tool] : "已保存";
    saved.set(label, (saved.get(label) ?? 0) + 1);
  }
  const confirmed = records.filter(row => row.status === "confirm").length;
  const review = records.filter(row => row.status === "review" || row.status === "processing").length;
  const undone = records.filter(row => row.undone).length;
  const dismissed = records.filter(row => row.status === "dismissed").length;
  const details = [...saved].map(([label, count]) => `${label} ${count} 项`);
  if (confirmed) details.push(`待确认 ${confirmed} 条`);
  if (review) details.push(`待核对 ${review} 条`);
  if (undone) details.push(`已撤销 ${undone} 条`);
  if (dismissed) details.push(`已归档 ${dismissed} 条`);
  return `手机随手记已处理 ${records.length} 条${details.length ? " · " + details.join(" · ") : ""}`;
}
