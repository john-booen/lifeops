import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ fields: [] as any[], list: vi.fn(), preview: vi.fn(), select: vi.fn(), extract: vi.fn(), scope: "fictional-scope" }));
vi.mock("obsidian", () => {
  const element = (tag = "div", info: any = {}): any => {
    const node = { tag, info, children: [] as any[], text: info.text ?? "", value: info.value ?? "", disabled: false, selectionStart: 0, selectionEnd: 0, readOnly: false,
      onclick: undefined as any, onchange: undefined as any, addClass() {}, setText(text: string) { this.text = text; }, empty() { this.children = []; this.text = ""; },
      createEl(tag: string, info?: any) { const child = element(tag, info); this.children.push(child); return child; }, createDiv(info?: any) { return this.createEl("div", info); } };
    fake.fields.push(node); return node;
  };
  return { Modal: class { titleEl = element(); contentEl = element(); constructor(public app: unknown) {} open() { (this as any).onOpen(); } close() { (this as any).onClose(); } } };
});
vi.mock("../src/features/externalVault/catalog", () => ({ externalVaultScope: () => fake.scope }));
vi.mock("../src/features/externalVault/selectedJournals", () => ({ SELECTED_JOURNAL_MAX_ITEMS: 3, listSelectableExternalJournals: fake.list, previewExternalJournal: fake.preview,
  selectExternalJournalExcerpt: fake.select, extractSelectedExternalJournalSignals: fake.extract }));
const { ExternalJournalSelectionModal } = await import("../src/features/externalVault/selectionUi");
let host: any, modal: InstanceType<typeof ExternalJournalSelectionModal>;
const first = "external-vault/虚构资料/2026-11-04晚.md", second = "external-vault/虚构资料/2026-11-05晚.md";
const data = (reference = first) => ({ reference, date: reference === first ? "2026-11-04" : "2026-11-05", period: "晚", sourceHash: "a".repeat(64), scope: "fictional-scope", text: "未选择的虚构句。\n选中的虚构原话。" });
const live = () => {
  const fields: any[] = [];
  const visit = (node: any) => { fields.push(node); node.children.forEach(visit); }; visit(modal.contentEl); return fields;
};
const field = (tag: string, label?: string) => live().find(node => node.tag === tag && (!label || node.info.text === label || node.info.attr?.["aria-label"] === label));
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
const add = async (reference = first) => { const picker = field("select"); picker.value = reference; picker.onchange(); await field("button", "本机预览原文").onclick(); field("textarea", "准备发送的连续原文片段").value = "选中的虚构原话。"; field("button", "加入待发送片段").onclick(); };
beforeEach(async () => {
  vi.useFakeTimers(); fake.fields.length = 0; fake.scope = "fictional-scope"; fake.list.mockReset(); fake.preview.mockReset(); fake.select.mockReset(); fake.extract.mockReset();
  fake.list.mockResolvedValue([{ reference: first, label: "2026-11-04 · 虚构晚记" }, { reference: second, label: "2026-11-05 · 虚构晚记" }]);
  fake.preview.mockImplementation(async (_store, reference) => data(reference));
  fake.select.mockImplementation((preview, excerpt) => { if (!excerpt || !preview.text.includes(excerpt)) throw Error("请选择连续原文"); const { text, ...source } = preview; return { ...source, excerpt, excerptHash: "b".repeat(64) }; });
  fake.extract.mockResolvedValue({ saved: 1, existing: 0 });
  host = { app: {}, store: { settings: { ai: { provider: "custom", endpoint: "https://fixture.invalid", model: "fictional", dataDisclosureAccepted: true } } },
    refreshViews: vi.fn(async () => {}), observeProvider: vi.fn(async (_stage, _channel, callback, signal) => callback({ signal }, host.store, { extractJournalSignals: vi.fn() }, () => {})) };
  modal = new ExternalJournalSelectionModal(host); modal.onOpen(); await flush();
});
afterEach(() => { modal.close(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("lists and previews only on the local side, with no provider request until explicitly submitted", async () => {
  expect(field("button", "整理所选片段").disabled).toBe(true); await add();
  expect(fake.preview).toHaveBeenCalledTimes(1); expect(host.observeProvider).not.toHaveBeenCalled(); expect(fake.extract).not.toHaveBeenCalled();
  expect(field("textarea", "日记原文，仅本机预览").readOnly).toBe(true);
  await field("button", "整理所选片段").onclick(); expect(host.observeProvider).toHaveBeenCalledTimes(1);
  const chosen = fake.extract.mock.calls[0][1]; expect(chosen).toHaveLength(1); expect(chosen[0].excerpt).toBe("选中的虚构原话。"); expect(chosen[0]).not.toHaveProperty("text");
  expect(field("p").text).toContain("本机"); expect(live().some(node => node.text.includes("已保存1段"))).toBe(true);
});
it("uses exact highlighted text, supports two dates in one submission and removes unsubmitted excerpts", async () => {
  await field("button", "本机预览原文").onclick(); const original = field("textarea", "日记原文，仅本机预览");
  original.selectionStart = original.value.indexOf("选中的"); original.selectionEnd = original.value.length;
  field("button", "加入待发送片段").onclick(); await add(second);
  expect(live().filter(node => node.tag === "pre")).toHaveLength(2); field("button", "移除这段").onclick();
  await field("button", "整理所选片段").onclick(); expect(fake.extract.mock.calls[0][1].map((item: any) => item.reference)).toEqual([second]);
});
it("rejects changed text and does not preselect an entire original", async () => {
  await field("button", "本机预览原文").onclick(); expect(field("textarea", "准备发送的连续原文片段").value).toBe("");
  field("textarea", "准备发送的连续原文片段").value = "原文没有这句"; field("button", "加入待发送片段").onclick();
  expect(field("button", "整理所选片段").disabled).toBe(true); expect(host.observeProvider).not.toHaveBeenCalled();
});
it("allows local preview while the model is off and explains the missing send configuration", async () => {
  host.store.settings.ai.provider = "off"; await add(); await field("button", "整理所选片段").onclick();
  expect(fake.preview).toHaveBeenCalled(); expect(host.observeProvider).not.toHaveBeenCalled(); expect(live().some(node => node.text.includes("配置文字模型"))).toBe(true);
});
it("owns the submitted batch and blocks repeated clicks and removal during a pending request", async () => {
  await add(); let release!: (value: any) => void; fake.extract.mockReturnValue(new Promise(done => { release = done; }));
  const submit = field("button", "整理所选片段"), remove = field("button", "移除这段"), pending = submit.onclick(); await flush();
  await submit.onclick(); remove.onclick(); expect(fake.extract).toHaveBeenCalledTimes(1); expect(fake.extract.mock.calls[0][1]).toHaveLength(1);
  release({ saved: 1, existing: 0 }); await pending; expect(live().filter(node => node.tag === "pre")).toHaveLength(1);
});
it("keeps the batch available after interruption so retry can skip saved excerpts", async () => {
  await add(); fake.extract.mockRejectedValueOnce(Error("fictional interruption")); await field("button", "整理所选片段").onclick();
  expect(field("button", "整理所选片段").disabled).toBe(false); expect(live().some(node => node.text.includes("跳过已保存片段"))).toBe(true);
  fake.extract.mockResolvedValue({ saved: 0, existing: 1 }); await field("button", "整理所选片段").onclick(); expect(live().some(node => node.text.includes("1段已有结果"))).toBe(true);
});
it("removes stale queued excerpts when a newer original is previewed, without silently selecting its new content", async () => {
  await add(); fake.preview.mockResolvedValue({ ...data(), sourceHash: "c".repeat(64) });
  await field("button", "本机预览原文").onclick(); expect(live().filter(node => node.tag === "pre")).toHaveLength(0);
  expect(field("button", "整理所选片段").disabled).toBe(true); expect(live().some(node => node.text.includes("已移出1段旧版本"))).toBe(true); expect(host.observeProvider).not.toHaveBeenCalled();
});
it.each(["scope", "store"])("clears old originals and refuses stale handlers after %s changes", async change => {
  await add(); const old = field("button", "整理所选片段"); if (change === "scope") fake.scope = "changed"; else host.store = { settings: host.store.settings };
  await vi.advanceTimersByTimeAsync(500); expect(live().some(node => node.tag === "textarea" || node.tag === "pre")).toBe(false);
  await old.onclick(); expect(fake.extract).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it("does not display a late preview or result after closing and releases its timer", async () => {
  let release!: (value: any) => void; fake.preview.mockReturnValue(new Promise(done => { release = done; }));
  const pending = field("button", "本机预览原文").onclick(); modal.close(); release(data()); await pending;
  expect(modal.contentEl.children).toEqual([]); expect(host.observeProvider).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
