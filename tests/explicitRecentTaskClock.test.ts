import { expect, it, vi } from "vitest";
import { explicitRecentTaskTimeChange } from "../src/agent/taskTimeCorrection";
vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, TFolder: class {}, Notice: class {}, normalizePath: (s: string) => s, parseYaml: JSON.parse, stringifyYaml: JSON.stringify }));
const previous={id:"task-fiction",title:"虚构纸样盒"};
it.each(["如果刚刚那条改成下午四点", "不要把刚才那条改到下午四点", "刚才那条改成下午四点还是五点", "刚才那条改成下午四点再新建一条", "刚才那条改成三点", "刚才那条改成2026-02-30下午四点", "刚才那条改成下午25点", "刚才那条改成下午四点前", "刚才那条改成下午四点到五点", "引用：刚才那条改成下午四点"])("leaves conditional, ambiguous or compound requests to the existing path: %s", message=>{expect(explicitRecentTaskTimeChange(message,"2026-11-21",previous)).toBeUndefined();});
it("requires the immediately verified task receipt",()=>{expect(explicitRecentTaskTimeChange("刚刚那条改成明天16:00","2026-11-21")).toBeUndefined();});
it("keeps an explicit ISO date and 24-hour clock",()=>{expect(explicitRecentTaskTimeChange("刚刚那条改成2026-11-24 16:00","2026-11-21",previous)).toEqual({taskIdOrTitle:previous.id,time:"16:00",date:"2026-11-24"});});
it("does not invent a date when only the clock is changed",()=>{expect(explicitRecentTaskTimeChange("刚刚那条再改到下午三点半。","2026-11-21",previous)).toEqual({taskIdOrTitle:previous.id,time:"15:30"});});
