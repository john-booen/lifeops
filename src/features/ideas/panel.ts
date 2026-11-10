import { Notice } from "obsidian";
import { todayString } from "../../date";
import { listIdeaCandidates } from "./candidates";
import { openIdeaCandidates, type IdeaUiHost } from "./candidateReview";
import { IDEA_STATES, ideaDaysStalled, isIdeaNotePath, isIdeaStatus, listIdeas, type IdeaNote } from "./notes";
import { ideaIsStalled, ideaRemindersSinceProgress, setIdeaStatus } from "./progress";

export function mountIdeaPanel(host: IdeaUiHost, container: HTMLElement): () => Promise<void> {
  const details = container.createEl("details", { cls: "lifeops-idea-panel" });
  const summary = details.createEl("summary", { text: "想法" });
  const body = details.createDiv();
  let generation = 0;
  const refresh = async () => {
    const current = ++generation;
    try {
      const [ideas, candidates] = await Promise.all([listIdeas(host.store), listIdeaCandidates(host.store)]);
      if (current !== generation || !details.isConnected) return;
      summary.setText("想法 · 已登记 " + ideas.length + " · 新发现 " + candidates.length);
      body.empty();
      const review = body.createEl("button", { text: candidates.length ? "核对 " + candidates.length + " 个新想法" : "查找历史想法",
        attr: { type: "button" } });
      review.onclick = () => openIdeaCandidates(host);
      if (!ideas.length) body.createEl("p", { text: "还没有已登记的想法。可以对管家说「记下这个想法」。", cls: "lifeops-muted" });
      const today = todayString();
      for (const [status, label] of Object.entries(IDEA_STATES)) {
        const group = ideas.filter(idea => idea.status === status);
        if (!group.length) continue;
        const section = body.createEl("section");
        section.createEl("h3", { text: label + " · " + group.length });
        for (const idea of group) renderIdeaRow(host, section, idea, today, refresh);
      }
    } catch {
      if (current === generation && details.isConnected) {
        body.empty();
        body.createEl("p", { text: "想法暂时无法读取，请核对设置。", cls: "lifeops-muted" });
      }
    }
  };
  void refresh();
  return refresh;
}

function renderIdeaRow(host: IdeaUiHost, parent: HTMLElement, idea: IdeaNote, today: string, refresh: () => Promise<void>): void {
  const row = parent.createDiv({ cls: "lifeops-idea-row" });
  const open = row.createEl("button", { text: idea.title, attr: { type: "button" } });
  open.onclick = async () => {
    const file = isIdeaNotePath(host.store, idea.path) ? host.store.getFile(idea.path) : null;
    if (file?.path === idea.path) await host.app.workspace.getLeaf(false).openFile(file, { state: { mode: "preview" } });
    else new Notice("想法已移动，请刷新列表。");
  };
  const stalled = ideaIsStalled(idea, today);
  row.createEl("p", { text: (stalled ? "已停滞 " : "距上次进展 ") + ideaDaysStalled(idea.lastProgress, today) + " 天 · 下次检查 " + idea.nextReview });
  const needsDecision = stalled && ideaRemindersSinceProgress(idea, today).length >= 3;
  if (needsDecision) row.createEl("p", { text: "已提醒 3 次，请选择继续、暂停或放弃。" });
  row.createEl("p", { text: "下一步 " + (idea.nextAction || "待填写") });
  const select = row.createEl("select", { attr: { "aria-label": "修改 " + idea.title + " 的状态" } });
  for (const [value, label] of Object.entries(IDEA_STATES)) select.createEl("option", { text: label, attr: { value } });
  select.value = idea.status;
  const resume = needsDecision ? row.createEl("button", { text: "继续", attr: { type: "button" } }) : undefined;
  const save = async (status: IdeaNote["status"] | "continue") => {
    select.disabled = true;
    if (resume) resume.disabled = true;
    try {
      await host.saveLocalOperation("local_set_idea_status", { id: idea.ideaId, status }, async store => {
        await setIdeaStatus(store, idea, status);
      });
      new Notice("想法状态已更新，可在最近操作中撤销。");
      await refresh();
      await host.refreshViews().catch(() => undefined);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "暂时无法修改状态。");
      select.value = idea.status;
    } finally { select.disabled = false; if (resume) resume.disabled = false; }
  };
  select.onchange = () => {
    const status = select.value;
    if (isIdeaStatus(status) && status !== idea.status) void save(status);
  };
  if (resume) resume.onclick = () => void save("continue");
}
