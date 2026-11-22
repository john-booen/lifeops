import { expect, it, vi } from "vitest";
import { explicitRecentTaskTimeChange } from "../src/agent/taskTimeCorrection";
vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, TFolder: class {}, Notice: class {}, normalizePath: (s: string) => s, parseYaml: JSON.parse, stringifyYaml: JSON.stringify }));
const previous={id:"task-fiction",title:"虚构纸样盒"};
it.each(["如果刚刚那条改成下午四点", "不要把刚才那条改到下午四点", "刚才那条改成下午四点还是五点", "刚才那条改成下午四点再新建一条", "刚才那条改成三点", "刚才那条改成2026-02-30下午四点", "刚才那条改成下午25点", "刚才那条改成下午四点前", "刚才那条改成下午四点到五点", "引用：刚才那条改成下午四点"])("leaves conditional, ambiguous or compound requests to the existing path: %s", message=>{expect(explicitRecentTaskTimeChange(message,"2026-11-21",previous)).toBeUndefined();});
it("requires the immediately verified task receipt",()=>{expect(explicitRecentTaskTimeChange("刚刚那条改成明天16:00","2026-11-21")).toBeUndefined();});
it("keeps an explicit ISO date and 24-hour clock",()=>{expect(explicitRecentTaskTimeChange("刚刚那条改成2026-11-24 16:00","2026-11-21",previous)).toEqual({taskIdOrTitle:previous.id,time:"16:00",date:"2026-11-24"});});
it("does not invent a date when only the clock is changed",()=>{expect(explicitRecentTaskTimeChange("刚刚那条再改到下午三点半。","2026-11-21",previous)).toEqual({taskIdOrTitle:previous.id,time:"15:30"});});

it.each(["把刚才那条改到明天下午四点。","请把刚才那条的时间改成明天下午四点。","帮我把刚刚这项待办的时间改为明天下午四点。","将上一条任务调整到明天下午四点。","请把刚才那个任务改到明天下午四点。","不对，请把刚刚那条改到明天下午四点。"])("binds a plain recent-reference imperative without extra model lookup: %s",message=>{expect(explicitRecentTaskTimeChange(message,"2026-11-21",previous)).toEqual({taskIdOrTitle:previous.id,time:"16:00",date:"2026-11-22"});});
it("treats tonight as an explicit current date instead of retaining a future task date",()=>{expect(explicitRecentTaskTimeChange("把刚才那条改到今晚八点","2026-11-21",previous)).toEqual({taskIdOrTitle:previous.id,time:"20:00",date:"2026-11-21"});});
it.each(["请把刚才那两条改到下午四点","不要把上一条改到下午四点","引用：请把刚才那条改到下午四点","把刚才那条改到明天今晚八点"])("does not turn plural, rejected, quoted or contradictory requests into a write: %s",message=>{expect(explicitRecentTaskTimeChange(message,"2026-11-21",previous)).toBeUndefined();});

it("does not force an interval or deadline task through a single-point correction",()=>{expect(explicitRecentTaskTimeChange("请把刚才那条改到下午四点","2026-11-21",{...previous,startTime:"15:00",endTime:"17:00"})).toBeUndefined();});

it.each(["不对，刚刚那条改成下午三点十五，日期不变。","请把上一条时间改到下午三点十五，保持其他信息不变。"])("keeps an explicit preservation clause without reinterpreting it as a deadline: %s",message=>{expect(explicitRecentTaskTimeChange(message,"2026-11-21",{...previous,date:"2099-02-04"})).toEqual({taskIdOrTitle:previous.id,time:"15:15"});});
it("does not discard a conflicting explicit request to retain the date",()=>{expect(explicitRecentTaskTimeChange("刚刚那条改到明天下午四点，日期不变","2026-11-21",{...previous,date:"2099-02-04"})).toBeUndefined();});
