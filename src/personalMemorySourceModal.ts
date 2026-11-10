import { Modal, type App } from "obsidian";
import { personalMemorySourceAssessment, type PersonalMemoryRecord } from "./personalMemory";

export function memoryConfirmationSourceText(record: PersonalMemoryRecord, sourceId: string): string[] {
  const source = record.sourceRefs.find(ref => ref.sourceId === sourceId);
  if (!source) return ["这条来源已经变化，请关闭后重新核对。"];
  const verified = record[personalMemorySourceAssessment]?.verifiedSourceIds.includes(sourceId);
  return [
    record.content,
    verified ? "这条理解有可核对的本地确认依据。" : "这条来源未作为当前内容的确认依据，可能已被后续纠正取代，或记录暂时无法核实。原记忆保留，你可以重新确认或纠正。",
    `记录时间：${Number.isFinite(Date.parse(source.capturedAt)) ? new Date(source.capturedAt).toLocaleString("zh-CN") : "待核对"}`,
    record.confirmationReceipt?.operationId === sourceId && verified
      ? "本条记忆保留了独立确认凭据。较早操作从近期列表移出后，仍可追溯这次确认。"
      : "详细操作记录可能因保留范围而不在近期列表中。"
  ];
}

export function openPersonalMemorySourceModal(app: App, record: PersonalMemoryRecord, sourceId: string): void {
  const modal = new Modal(app);
  modal.titleEl.setText("这条理解的确认来源");
  for (const text of memoryConfirmationSourceText(record, sourceId)) modal.contentEl.createEl("p", { text });
  modal.contentEl.createEl("p", { text: "此窗口只供查看。纠正或停止使用，请回到这条记忆的操作按钮。" });
  modal.open();
}
