import { guardedOperationIdentity } from "../../dataFoundation/factOperation";
import { fileRevision } from "../../operationIdentity";
import type { StoreHost } from "../../store/settingsSlice";
import { ideaNoteFromMarkdown, isIdeaNotePath, readIdeaProperties, readIdeaSource, splitIdeaNote, type IdeaFields, type IdeaNote } from "./notes";

export interface PreparedIdeaNote { path: string; revision: string; header: string }

export async function prepareIdeaNoteRegistration(store: StoreHost, path: string, revision: string, fields: IdeaFields): Promise<PreparedIdeaNote> {
  if (!isIdeaNotePath(store, path)) throw new Error("请选择想法文件夹中的原笔记。");
  const raw = await readIdeaSource(store, path);
  if (fileRevision(raw) !== revision || readIdeaProperties(raw).lifeops !== undefined) throw new Error("笔记属性已变化，请重新核对。");
  const original = splitIdeaNote(raw);
  const folder = store.path(store.settings.folders.aiReports, "System");
  const scratchPath = store.path(folder, "LifeOps属性暂存-" + fields.ideaId + ".md");
  await store.ensureFolder(folder);
  const initial = original.yaml.trim() ? "---\n" + original.yaml.trimEnd() + "\n---\n" : "";
  const scratch = await store.app.vault.create(scratchPath, initial + "# LifeOps 属性暂存\n");
  try {
    await store.app.fileManager.processFrontMatter(scratch, frontmatter => Object.assign(frontmatter, fields));
    const rendered = splitIdeaNote(await store.app.vault.read(scratch));
    const eol = original.newline, yaml = rendered.yaml.trimEnd().replace(/\r?\n/g, eol);
    const header = original.bom + "---" + eol + yaml + eol + "---" + eol;
    if (!ideaNoteFromMarkdown(path, store.getFile(path)?.basename ?? "", header + original.body)) throw new Error("无法生成想法属性。");
    return { path, revision, header };
  } finally { await store.app.vault.delete(scratch); }
}

export async function applyIdeaNoteRegistration(store: StoreHost, prepared: PreparedIdeaNote): Promise<IdeaNote> {
  const identity = guardedOperationIdentity(store);
  if (!identity || identity.purpose === "derived") throw new Error("请先确认想法登记。");
  const { path, revision, header } = prepared;
  const file = isIdeaNotePath(store, path) ? store.getFile(path) : null;
  if (!file || file.path !== path || fileRevision(await readIdeaSource(store, path)) !== revision) throw new Error("原笔记已变化，请重新核对。");
  const saved = await store.app.vault.process(file, current => {
    if (fileRevision(current) !== revision) throw new Error("原笔记已变化，请重新核对。");
    return header + splitIdeaNote(current).body;
  });
  return ideaNoteFromMarkdown(path, file.basename, saved)!;
}
