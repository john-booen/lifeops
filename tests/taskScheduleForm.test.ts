import { describe, expect, it, vi } from "vitest";
import type { LifeOpsTaskInput } from "../src/types";
const state = vi.hoisted(() => ({ settings: [] as Array<{ name: string; text?: any; dropdown?: any; button?: any }> }));
vi.mock("obsidian", () => ({ Setting: class {
  row: { name: string; text?: any; dropdown?: any; button?: any } = { name: "" };
  constructor() { state.settings.push(this.row); }
  setName(name: string) { this.row.name = name; return this; }
  setDesc() { return this; }
  addDropdown(configure: (d: any) => void) {
    const d: any = { options: {}, value: "", addOption(k: string, v: string) { d.options[k] = v; return d; }, setValue(v: string) { d.value = v; return d; }, onChange(f: (v: string) => void) { d.change = f; return d; } }; this.row.dropdown = d; configure(d); return this;
  }
  addText(configure: (t: any) => void) {
    const t: any = { value: "", inputEl: { type: "", setAttribute() {}, addEventListener() {} }, setValue(v: string) { t.value = v; return t; }, onChange(f: (v: string) => void) { t.change = f; return t; } }; this.row.text = t; configure(t); return this;
  }
  addButton(configure: (b: any) => void) {
    const b: any = { buttonEl: { setAttribute() {} }, setButtonText() { return b; }, setTooltip() { return b; }, onClick(f: () => void) { b.click = f; return b; } }; this.row.button = b; configure(b); return this;
  }
} }));
const { renderTaskScheduleForm } = await import("../src/taskScheduleForm");
function fixture(value: LifeOpsTaskInput) {
  const parent = { createEl: () => ({ createEl() {}, open: false }) } as unknown as HTMLElement;
  const render = vi.fn(() => { state.settings = []; renderTaskScheduleForm(parent, value, render); }); render();
  return { render, field: (name: string) => state.settings.find(row => row.name === name)! };
}
describe("task completion-window form", () => {
  it("opens an existing week as a window with its end date visible and leaves stored fields untouched", () => {
    const value: LifeOpsTaskInput = { title: "虚构一周归档", date: "2026-11-21", endDate: "2026-11-27", startTime: "16:15", endTime: "16:45" }, before = structuredClone(value);
    const ui = fixture(value);
    expect(ui.field("安排方式").dropdown.value).toBe("window");
    expect(ui.field("计划完成日期").text.value).toBe("2026-11-27");
    expect(value).toEqual(before);
  });
  it("allows an explicit fixed interval and changing back without discarding boundary clocks", () => {
    const value: LifeOpsTaskInput = { title: "虚构多日安排", date: "2026-11-21", endDate: "2026-11-27", startTime: "16:15", endTime: "16:45" };
    const ui = fixture(value); ui.field("安排方式").dropdown.change("fixed");
    expect(value.scheduleMode).toBe("fixed"); expect(ui.field("计划结束日期").text.value).toBe("2026-11-27");
    ui.field("安排方式").dropdown.change("window");
    expect(value).toMatchObject({ scheduleMode: "window", startTime: "16:15", endTime: "16:45", endDate: "2026-11-27" });
  });
  it("keeps the hard deadline when clearing the availability start and its planned clocks", () => {
    const value: LifeOpsTaskInput = { title: "虚构清除安排", date: "2026-11-21", endDate: "2026-11-27", startTime: "16:15", endTime: "16:45", scheduleMode: "window", dueDate: "2026-12-02", dueTime: "18:00" };
    const ui = fixture(value); ui.field("可开始日期").button.click();
    expect(value).toMatchObject({ date: "", endDate: "", startTime: "", endTime: "", scheduleMode: "fixed", dueDate: "2026-12-02", dueTime: "18:00" });
  });
  it("switches a legacy date-only task to a window when an end date is entered", () => {
    const value: LifeOpsTaskInput = { title: "虚构周内完成", date: "2026-11-23" };
    const ui = fixture(value); ui.field("计划结束日期").text.change("2026-11-30");
    expect(ui.field("安排方式").dropdown.value).toBe("window");
    expect(ui.field("计划完成日期").text.value).toBe("2026-11-30");
  });
});
