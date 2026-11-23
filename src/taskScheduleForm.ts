import { Setting } from "obsidian";
import type { LifeOpsTaskInput } from "./types";
import { taskScheduleMode } from "./taskSchedule";

export function renderTaskScheduleForm(parent: HTMLElement, value: LifeOpsTaskInput, render: () => void): void {
  const windowMode = taskScheduleMode({ date: value.date ?? "", endDate: value.endDate ?? "", startTime: value.startTime, endTime: value.endTime, scheduleMode: value.scheduleMode }) === "window";
  new Setting(parent).setName("安排方式").setDesc("期间完成适合跨天、跨周、跨月分次推进；固定安排用于具体工作时段。").addDropdown(dropdown => {
    dropdown.addOption("fixed", "固定安排").addOption("window", "期间完成").setValue(windowMode ? "window" : "fixed").onChange(next => {
      value.scheduleMode = next as "fixed" | "window"; render();
    });
  });
  parent.createEl("p", { cls: "lifeops-muted", text: windowMode ? "这段期间内分次完成，不视为每天必须完成或全天占用。时刻可留空；硬截止另填，完成后才记录实际完成时间。" : "只想几点前完成，填写计划结束即可。要安排工作区间，再填写开始时刻。这里都是计划，完成任务后才记录实际完成时间。" });
  field(parent, windowMode ? "可开始日期" : "安排日期", "哪天开始；时刻可留空。清空日期会同时清空本次计划时刻。", value.date, "date", next => {
    value.date = next;
    if (!next) { value.endDate = ""; value.startTime = ""; value.endTime = ""; value.time = ""; value.scheduleMode = "fixed"; render(); }
  });
  const changeEndDate = (next: string) => {
    value.endDate = next;
    if (value.scheduleMode === undefined && next && next !== value.date) render();
  };
  if (windowMode) field(parent, "计划完成日期", "可跨周或跨月；这一天之前分次推进，不等于每天全天安排。", value.endDate, "date", changeEndDate);
  field(parent, windowMode ? "可开始时刻（可选）" : "计划开始", windowMode ? "期间任务的时刻只是范围边界，不占用中间每一天。" : "可选，明确几点开始；不填写就不占用工作区间。", value.startTime, "time", next => { value.startTime = next; });
  field(parent, windowMode ? "希望完成时刻（可选）" : "计划结束／希望完成", "例如12:00；只填这一项表示希望12点前完成，不推测开始时间。", value.endTime, "time", next => { value.endTime = next; });
  const more = parent.createEl("details", { cls: "lifeops-task-time-details" });
  more.open = Boolean(value.endDate || value.dueDate || value.dueTime || value.time);
  more.createEl("summary", { text: "跨天、必须截止与原有时刻（可选）" });
  if (!windowMode) field(more, "计划结束日期", "跨天时填写；分次推进请选择期间完成。", value.endDate, "date", changeEndDate);
  field(more, "必须截止日期", "另有交付或约定的硬期限才填写，和计划安排独立；不会复制计划结束。", value.dueDate, "date", next => {
    value.dueDate = next;
    if (!next) { value.dueTime = ""; render(); }
  });
  field(more, "必须截止时刻", "可选，须同时有截止日期。", value.dueTime, "time", next => { value.dueTime = next; });
  if (value.time) field(more, "原安排时刻", "保留旧记录的单个时刻；含义尚未确认，不自动变成开始或结束。可清除后重新安排区间。", value.time, "time", next => { value.time = next; });
}

function field(parent: HTMLElement, label: string, description: string, value: string | undefined, kind: "date" | "time", onChange: (value: string) => void): void {
  let input: import("obsidian").TextComponent;
  new Setting(parent).setName(label).setDesc(description).addText(text => {
    input = text; text.inputEl.type = kind; text.inputEl.setAttribute("aria-label", label);
    text.inputEl.addEventListener("pointerdown", () => { try { text.inputEl.showPicker?.(); } catch { /* Native input remains usable. */ } });
    text.setValue(value ?? "").onChange(next => onChange(next.trim()));
  }).addButton(button => {
    button.setButtonText("清除").setTooltip(`清除${label}`).onClick(() => { input.setValue(""); onChange(""); });
    button.buttonEl.setAttribute("aria-label", `清除${label}`);
  });
}
