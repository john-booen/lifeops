import { describe, expect, it, vi } from "vitest";
import type { GoalInput, ProjectCommand, ProjectSnapshot } from "../src/projectContinuity";
vi.mock("obsidian", () => ({
  Plugin: class {}, Notice: class {}, Modal: class {}, TFile: class {}, TFolder: class {}, ItemView: class {}, PluginSettingTab: class {}, Setting: class {},
  Platform: { isDesktopApp: false }, normalizePath: (path: string) => path, requestUrl: vi.fn(() => { throw new Error("Unexpected network"); }), setIcon: vi.fn()
}));
vi.mock("../src/lifeOpsView", () => ({ LIFEOPS_VIEW_TYPE: "lifeops", LifeOpsView: class {} }));
vi.mock("../src/settingsTab", () => ({ LifeOpsSettingTab: class {} }));
const { default: LifeOpsPlugin } = await import("../src/main");
const { ProjectBoardModal } = await import("../src/projectBoard");
function command(): ProjectCommand {
  const input: GoalInput = { title: "确认时的名称", reason: "理由", successCriteria: "标准", timeBoundary: "", constraints: "", nextStep: "", reviewOn: "", sourcePath: "", state: "agreed", stateNote: "" };
  return { kind: "save_goal", input };
}
describe("project submission authorization snapshot", () => {
  it("freezes the actual plugin entry's args and execution payload before an async claim can observe later form edits", async () => {
    const plugin: any = Object.create(LifeOpsPlugin.prototype);
    plugin.unloaded = false; plugin.lifecycleGeneration = 1;
    let release!: () => void; const waiting = new Promise<void>(resolve => release = resolve);
    let registered: any, executed: any;
    plugin.createAgentRuntime = () => ({ executeLocalOperation: async (_name: string, args: any, execute: (scope: any) => Promise<void>) => {
      registered = JSON.parse(JSON.stringify(args)); await waiting;
      await execute({ applyProjectCommand: async (payload: any) => { executed = payload; return "goal-id"; } });
      return { success: true };
    } });
    const original: any = command(), saving = plugin.saveProjectCommand(original, "absent", "local:submitted");
    original.input.title = "提交之后改动的名称"; release();
    expect(await saving).toBe("goal-id"); expect(registered.command.input.title).toBe("确认时的名称"); expect(executed.input.title).toBe("确认时的名称");
  });
  it("freezes the board payload before hashing its operation ID and calling the controller", async () => {
    const board: any = Object.create(ProjectBoardModal.prototype); board.closed = true;
    let submitted: any, id = "";
    board.controller = { saveProjectCommand: async (payload: any, _revision: string, operationId: string) => { submitted = payload; id = operationId; } };
    const original: any = command(); const snapshot = { revision: "absent" } as ProjectSnapshot;
    const saving = board.save(snapshot, original, "local:form"); original.input.title = "后来改动"; await saving;
    expect(submitted.input.title).toBe("确认时的名称"); expect(id).toMatch(/^local:form:[a-f0-9]{16}$/);
  });
});
