import { hasPendingFactOperation } from "../../dataFoundation/factOperation";
import { readScopedMarkdown } from "../../dataFoundation/markdownSources";
import { OperationLedger } from "../../dataFoundation/operationLedger";
import { todayString } from "../../date";
import type { LifeOpsEventBus } from "../../lifeOpsEventBus";
import { isVaultPathExcluded } from "../../privacy";
import type { StoreHost } from "../../store/settingsSlice";
import type { AgentActionSuggestion, AgentResponse } from "../../types";
import {
  PHONE_INBOX_PATH, PHONE_INBOX_STATE, isPhoneInboxAction, isPhoneInboxTool, parsePhoneInbox, phoneInboxLabels,
  validPhoneInboxDocument, type PhoneInboxDocument, type PhoneInboxLine, type PhoneInboxReceipt, type PhoneInboxRecord, type PhoneInboxTurn
} from "./model";

const EMPTY_NOTE = "# 手机随手记\n";
const MAX_BATCH_LINES = 20;

export class PhoneInboxBusyError extends Error {
  constructor() { super("另一个保存还没结束，请稍后再检查末行。"); }
}

interface PhoneInboxHost {
  store(): StoreHost;
  enabled(): boolean;
  submit(text: string, turn: PhoneInboxTurn, signal: AbortSignal): Promise<AgentResponse>;
  confirm(action: AgentActionSuggestion, turn: PhoneInboxTurn): Promise<void>;
  undo(id: string): Promise<boolean>;
  notify(message: string): void;
}

export class PhoneInbox {
  private running: Promise<void> = Promise.resolve();
  private scheduled?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private readonly unsubscribe: () => void;
  private readonly controller = new AbortController();

  constructor(private readonly host: PhoneInboxHost, events: LifeOpsEventBus) {
    this.unsubscribe = events.subscribe(event => {
      if (!["vault.created", "vault.modified", "vault.renamed"].includes(event.type)) return;
      if ((event.payload as { path?: string }).path === PHONE_INBOX_PATH) this.schedule();
    });
  }

  get enabled(): boolean {
    return !this.stopped && this.host.enabled() && this.allowed(this.host.store());
  }

  schedule(delay = 650): void {
    clearTimeout(this.scheduled);
    if (!this.enabled) return;
    this.scheduled = setTimeout(() => void this.scan().catch(() =>
      this.host.notify("手机随手记暂时无法读取或处理，请打开回执核对。")), delay);
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe();
    clearTimeout(this.scheduled);
    this.controller.abort();
  }

  async list(): Promise<PhoneInboxReceipt[]> {
    if (!this.enabled) return [];
    const store = this.host.store();
    const doc = await this.read(store);
    const ledger = new OperationLedger(store);
    const operationIds = doc.records.flatMap(row => row.operationId && !row.undone ? [row.operationId] : []);
    const [positions, reverted] = await Promise.all([
      store.getFile(PHONE_INBOX_PATH)
        ? this.lines(store, true).then(lines => new Map(lines.map(({ id, line }) => [id, line])), () => undefined)
        : undefined,
      operationIds.length && !isVaultPathExcluded(ledger.filePath, store.settings.privacy?.excludedVaultPrefixes)
        ? ledger.revertedOperations(operationIds).catch(() => new Set<string>())
        : new Set<string>()
    ]);
    this.assertCurrent(store);
    return doc.records.slice().reverse().map(row => {
      const line = positions?.get(row.id);
      return { ...row, ...(line === undefined ? { sourceUnavailable: true as const } : { line }),
        ...(row.operationId && reverted.has(row.operationId) ? { undone: true } : {}) };
    });
  }

  async createFile(): Promise<void> {
    const store = this.host.store();
    this.assertCurrent(store);
    await store.ensureFile(PHONE_INBOX_PATH, EMPTY_NOTE);
    this.schedule();
  }

  scan(includeUnterminated = false): Promise<void> {
    return this.serialize(async () => {
      if (!this.enabled) return;
      const store = this.host.store();
      if (!store.getFile(PHONE_INBOX_PATH)) return;
      if (await hasPendingFactOperation(store)) {
        this.schedule(10_000);
        if (includeUnterminated) throw new PhoneInboxBusyError();
        return;
      }
      const ai = store.settings.ai;
      if (ai.provider === "off" || !ai.dataDisclosureAccepted || !ai.endpoint || !ai.model) return;
      const doc = await this.read(store);
      const known = new Set(doc.records.map(row => row.id));
      const lines = (await this.lines(store, includeUnterminated)).filter(line => !known.has(line.id));
      const added: PhoneInboxRecord[] = [];
      for (const line of lines.slice(0, MAX_BATCH_LINES)) {
        if (!this.enabled || store !== this.host.store()) break;
        added.push(await this.process(store, doc, line));
      }
      if (added.length) this.host.notify(summarizePhoneInbox(added));
      if (added.length === MAX_BATCH_LINES && lines.length > added.length) this.schedule();
    });
  }

  resolve(id: string, decision: "confirm" | "dismiss" | "undo"): Promise<void> {
    return this.serialize(async () => {
      const store = this.host.store();
      this.assertCurrent(store);
      const doc = await this.read(store);
      const row = doc.records.find(record => record.id === id);
      if (!row) throw Error("找不到这条手机记录。");
      if (decision === "undo" && row.operationId && !row.undone) {
        if (!await this.host.undo(row.operationId)) throw Error("撤销暂时未完成。");
        row.undone = true;
      } else if (decision === "dismiss" && (row.status === "confirm" || row.status === "review" || row.status === "processing")) {
        row.status = "dismissed";
        delete row.action;
      } else if (decision === "confirm" && row.status === "confirm" && row.action) {
        const line = await this.findLine(store, id);
        const turn = this.turn(store, line);
        await this.host.confirm(row.action, turn);
        row.operationId = `confirmed:${row.action.id}`;
        row.status = "saved";
        row.message = `已确认并核验 · ${row.action.content}`.slice(0, 2000);
        delete row.action;
      } else throw Error("这条回执已变化，请重新打开核对。");
      await this.write(store, doc);
    });
  }

  private async process(store: StoreHost, doc: PhoneInboxDocument, line: PhoneInboxLine): Promise<PhoneInboxRecord> {
    const row: PhoneInboxRecord = { id: line.id, line: line.line, status: "processing", message: "上次处理未读回回执，请核对最近操作。" };
    doc.records.push(row);
    await this.write(store, doc);
    const invalid = !line.date ? "请核对日期和时间。可把更正后的记录追加为新行。"
      : !line.text.trim() ? "这一行没有记录内容。"
      : line.text.length > 2000 ? "这行超过 2000 字，请分成几条再追加。"
      : "";
    if (invalid) {
      row.status = "review";
      row.message = invalid;
      await this.write(store, doc);
      return row;
    }
    try {
      const response = await this.host.submit(line.text, this.turn(store, line), this.controller.signal);
      const call = response.toolCalls?.find(item => isPhoneInboxTool(item.name));
      if (call?.ok && isPhoneInboxTool(call.name)) row.tool = call.name;
      const receipt = response.receipts?.[0];
      const action = response.actions.length === 1 ? response.actions[0] : undefined;
      if (receipt) {
        row.operationId = receipt.operationId;
        row.status = "saved";
      } else if (isPhoneInboxAction(action)) {
        row.action = action;
        row.status = "confirm";
      } else {
        row.status = "review";
      }
      row.message = response.reply.trim().slice(0, 2000) || "请核对对应的保存记录。";
    } catch {
      if (!this.enabled || store !== this.host.store()) throw Error("手机随手记已停止。");
      row.status = "review";
      row.message = "本条没有读回保存回执。请核对「最近操作」和收件箱原文。";
    }
    await this.write(store, doc);
    return row;
  }

  private turn(store: StoreHost, line: PhoneInboxLine): PhoneInboxTurn {
    return {
      date: line.date,
      assertCurrent: () => this.assertCurrent(store),
      assertLineCurrent: async () => {
        const current = await this.findLine(store, line.id);
        if (line.terminated && !current.terminated) throw Error("这一行已回到编辑状态，请等它写完。");
      }
    };
  }

  private async findLine(store: StoreHost, id: string): Promise<PhoneInboxLine> {
    const line = (await this.lines(store, true)).find(item => item.id === id);
    if (!line) throw Error("这一行已经修改或移除，请核对收件箱。");
    return line;
  }

  private async lines(store: StoreHost, includeUnterminated: boolean): Promise<PhoneInboxLine[]> {
    this.assertCurrent(store);
    const text = await readScopedMarkdown(store, PHONE_INBOX_PATH);
    this.assertCurrent(store);
    return parsePhoneInbox(text, todayString(), includeUnterminated);
  }

  private async read(store: StoreHost): Promise<PhoneInboxDocument> {
    this.assertCurrent(store);
    const doc = await store.readJson<PhoneInboxDocument>(this.statePath(store), { version: 1, records: [] });
    this.assertCurrent(store);
    if (!validPhoneInboxDocument(doc)) throw Error("手机随手记回执格式需要核对。");
    return doc;
  }

  private async write(store: StoreHost, doc: PhoneInboxDocument): Promise<void> {
    this.assertCurrent(store);
    if (!validPhoneInboxDocument(doc)) throw Error("手机随手记回执格式需要核对。");
    await store.writeJson(this.statePath(store), doc);
  }

  private statePath(store: StoreHost): string {
    return store.path(store.settings.folders.aiReports, "System", PHONE_INBOX_STATE);
  }

  private allowed(store: StoreHost): boolean {
    const prefixes = store.settings.privacy?.excludedVaultPrefixes;
    return !isVaultPathExcluded(PHONE_INBOX_PATH, prefixes) && !isVaultPathExcluded(this.statePath(store), prefixes);
  }

  private assertCurrent(store: StoreHost): void {
    if (!this.enabled || store !== this.host.store()) throw Error("手机随手记设置已变化。");
  }

  private serialize(work: () => Promise<void>): Promise<void> {
    const result = this.running.then(work);
    this.running = result.catch(() => undefined);
    return result;
  }
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
