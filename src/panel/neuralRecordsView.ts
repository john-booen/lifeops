/**
 * Native, read-only records surface. Visual adaptation of the user-approved
 * luoluo-121/neural-creator-dashboard (MIT), pinned in the preview archive.
 * All facts and operations stay behind the host's existing controller.
 */
import { createNeuralRecordsModel, type NeuralDomain, type NeuralRecordDetail,
  type NeuralRecordRelation, type NeuralRecordsAdapter, type NeuralRecordsState } from "./neuralRecordsModel";

export type NeuralNavigation = "home" | "today" | "records" | "assistant";
export interface NeuralRecordsViewOptions {
  onReturn(): void;
  initialDomain?: NeuralDomain;
  /** Existing host chrome can stay during the first staged integration. */
  embedded?: boolean;
  onNavigate?(page: NeuralNavigation): void | Promise<void>;
  onUtilities?(): void | Promise<void>;
  onOpenRelation?(relation: NeuralRecordRelation, context: { recordId: string; signal: AbortSignal }): void | Promise<void>;
  /** Render into a detached staging element; cleanup is called on replacement. */
  renderBody?(body: string, host: HTMLElement, record: NeuralRecordDetail,
    signal: AbortSignal): void | (() => void) | Promise<void | (() => void)>;
}

const domains: ReadonlyArray<{id: NeuralDomain | "all"; label: string}> = [
  {id:"all",label:"全部"},{id:"life",label:"日记生活"},{id:"tasks",label:"任务习惯"},
  {id:"learning",label:"学习写作"},{id:"projects",label:"事业项目"},{id:"trading",label:"交易复盘"}
];
const navigation: ReadonlyArray<{id:NeuralNavigation;label:string;en:string}> = [
  {id:"home",label:"网络空间",en:"Network"},{id:"today",label:"今天",en:"Today"},
  {id:"records",label:"记录库",en:"Records"},{id:"assistant",label:"智能助手",en:"Assistant"}
];
const relationLabels = {link:"明确链接",source:"记录来源",task:"关联任务",project:"关联项目"};
let serial = 0;

export function mountNeuralRecordsView(container: HTMLElement, adapter: NeuralRecordsAdapter,
  options: NeuralRecordsViewOptions) {
  const document = container.ownerDocument;
  const element = document.createElement("section");
  element.className = `lifeops-neural-ui${options.embedded?" is-embedded":""}`;
  element.id = `lifeops-neural-records-${++serial}`;
  element.setAttribute("aria-label", "LifeOps 记录库");
  container.append(element);
  let disposed = false, bodyController: AbortController | null = null;
  let bodyCleanup: (()=>void) | null = null, renderedDetail: NeuralRecordDetail | null = null;
  let actionVersion = 0;
  let listSignature = "";
  let relationSignature = "";
  let relationController: AbortController | null = null;

  function el<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, cls: string, text?: string) {
    const node = document.createElement(tag); node.className = cls;
    if (text !== undefined) node.textContent = text;
    parent.append(node); return node;
  }
  function button(parent: HTMLElement, cls: string, text: string, action: ()=>void) {
    const node = el(parent,"button",cls,text); node.type="button"; node.onclick=action; return node;
  }
  const top = el(element,"header","ln-topbar");
  top.hidden=Boolean(options.embedded);
  const brand = button(top,"ln-brand","",()=>runAction(options.onReturn));
  brand.setAttribute("aria-label","返回原界面");
  el(brand,"span","ln-brand-mark","✦").setAttribute("aria-hidden","true");
  const brandText=el(brand,"span","ln-brand-text");
  el(brandText,"b","","LIFEOPS");el(brandText,"small","","A CONNECTED LIFE");
  const nav = el(top,"nav","ln-nav");nav.setAttribute("aria-label","LifeOps 主导航");
  for(const item of navigation){
    const node=button(nav,`ln-nav-button ${item.id==="records"?"is-active":""}`,item.label,()=>{
      if(item.id!=="records"&&options.onNavigate)runAction(()=>options.onNavigate!(item.id));
    });
    el(node,"em","",item.en);
    if(item.id==="records")node.setAttribute("aria-current","page");
    else node.disabled=!options.onNavigate;
  }
  const tools=el(top,"div","ln-top-tools");
  if(options.onUtilities)button(tools,"ln-button ln-quiet-button","更多",()=>runAction(options.onUtilities!));
  button(tools,"ln-button","返回原界面",()=>runAction(options.onReturn));

  const page=el(element,"div","ln-page");
  const heading=el(page,"header","ln-page-heading");
  const copy=el(heading,"div","");el(copy,"p","ln-eyebrow","LOCAL LIBRARY");
  el(copy,"h1","","记录库");el(copy,"p","ln-caption","记录原文，连接思考。这里的选择与浏览不会修改记录。");
  el(heading,"span","ln-readonly","只读浏览");
  const toolbar=el(page,"div","ln-toolbar");
  const filters=el(toolbar,"div","ln-domain-filter");filters.setAttribute("role","group");filters.setAttribute("aria-label","记录领域");
  const domainButtons = new Map<string,HTMLButtonElement>();
  for(const domain of domains){
    const node=button(filters,"ln-filter",domain.label,()=>{void model.setDomain(domain.id);});
    domainButtons.set(domain.id,node);
  }
  const searchLabel=el(toolbar,"label","ln-search");
  el(searchLabel,"span","ln-sr-only","按标题或记录类型搜索");
  const search=el(searchLabel,"input","");search.type="search";search.placeholder="搜索记录标题…";
  search.autocomplete="off";search.setAttribute("aria-label","搜索记录标题");
  search.oninput=()=>model.setQuery(search.value);

  const statusRow=el(page,"div","ln-status-row");
  const status=el(statusRow,"p","ln-status");status.setAttribute("role","status");status.setAttribute("aria-live","polite");
  const retry=button(statusRow,"ln-button ln-retry","重新读取",()=>{void model.reload();});retry.hidden=true;
  const actionStatus=el(statusRow,"p","ln-action-status");actionStatus.setAttribute("role","status");
  const grid=el(page,"div","ln-records-grid");
  const listPanel=el(grid,"aside","ln-glass ln-record-list");listPanel.setAttribute("aria-label","记录列表");
  const listHead=el(listPanel,"header","ln-panel-heading");el(listHead,"h2","","我的记录");
  const count=el(listHead,"span","ln-count","0");
  const list=el(listPanel,"div","ln-record-buttons");
  const documentPanel=el(grid,"article","ln-glass ln-document");documentPanel.setAttribute("aria-label","记录正文");
  const meta=el(documentPanel,"div","ln-document-meta");
  const kind=el(meta,"span","");const date=el(meta,"time","");
  const title=el(documentPanel,"h2","ln-document-title","选择一条记录");
  const source=el(documentPanel,"p","ln-source");
  const body=el(documentPanel,"div","ln-document-body");
  body.setAttribute("tabindex","0");body.setAttribute("role","region");body.setAttribute("aria-label","当前记录正文");
  const documentActions=el(documentPanel,"footer","ln-document-actions");
  const open=button(documentActions,"ln-button ln-primary","在 Obsidian 中打开",()=>{void model.openSelected();});open.disabled=true;
  el(documentActions,"span","ln-caption","编辑和保存继续使用原来的记录入口");
  const relatedPanel=el(grid,"aside","ln-glass ln-related");relatedPanel.setAttribute("aria-label","关联与来源");
  const relatedHead=el(relatedPanel,"header","ln-panel-heading");el(relatedHead,"h2","","关联与来源");
  const relations=el(relatedPanel,"div","ln-relations");
  el(page,"p","ln-bottom-note","浏览保持原文；保存、确认与撤销沿用管家原有流程。");

  function stopBody() {
    bodyController?.abort();bodyController=null;
    try{bodyCleanup?.();}catch{/* Host cleanup must not retain this surface. */}
    bodyCleanup=null;
  }
  function showBody(detail:NeuralRecordDetail|null){
    if(renderedDetail===detail||(detail&&renderedDetail&&detail.id===renderedDetail.id
      &&detail.path===renderedDetail.path&&detail.body===renderedDetail.body))return;
    stopBody();renderedDetail=detail;body.replaceChildren();body.scrollTop=0;
    if(!detail){el(body,"p","ln-empty","从左侧选择记录，查看原文与已有的明确关联。");return;}
    if(!detail.body){el(body,"p","ln-empty","这条记录目前没有正文。");return;}
    if(!options.renderBody){el(body,"div","ln-plain-body",detail.body);return;}
    const pending=new AbortController();bodyController=pending;
    const staging=document.createElement("div");staging.className="ln-rendered-body";
    const snapshot=detail;
    el(body,"p","ln-empty","正在呈现原文…");
    Promise.resolve().then(()=>{
      if(pending.signal.aborted)return;
      return options.renderBody!(snapshot.body,staging,snapshot,pending.signal);
    }).then(cleanup=>{
      if(pending.signal.aborted||disposed||renderedDetail!==snapshot){if(typeof cleanup==="function")cleanup();return;}
      bodyCleanup=typeof cleanup==="function"?cleanup:null;body.replaceChildren(staging);
    }).catch(()=>{
      if(pending.signal.aborted||disposed||renderedDetail!==snapshot)return;
      body.replaceChildren();el(body,"div","ln-plain-body",snapshot.body);
    });
  }
  function draw(state:NeuralRecordsState){
    if(disposed)return;
    for(const [id,node] of domainButtons){node.setAttribute("aria-pressed",String(id===state.domain));}
    if(search.value!==state.query)search.value=state.query;
    const query=state.query.trim().toLocaleLowerCase();
    const visible=state.records.filter(record=>!query||`${record.title} ${record.kind??""}`.toLocaleLowerCase().includes(query));
    count.textContent=state.phase==="loading-list"?"…":`${visible.length}${query?` / ${state.records.length}`:""}`;
    listPanel.setAttribute("aria-busy",String(state.phase==="loading-list"));
      const signature=JSON.stringify({rows:visible.map(record=>[record.id,record.title,record.kind,record.date,record.updatedAt]),empty:state.phase==="loading-list"?"loading":query?"filter":"empty"});
    if(signature!==listSignature){
      listSignature=signature;
      const focused=Array.from(list.querySelectorAll<HTMLButtonElement>("button[data-record-id]")).find(node=>node===document.activeElement)?.dataset.recordId;
      const scrollTop=list.scrollTop;
      list.replaceChildren();
      if(!visible.length)el(list,"p","ln-empty",state.phase==="loading-list"?"正在读取记录…":query?"没有匹配的记录标题。":"这里暂时没有可显示的记录。");
      for(const record of visible){
        const item=button(list,"ln-record-button","",()=>{void model.select(record.id);});
        item.dataset.recordId=record.id;item.setAttribute("aria-label",`查看记录：${record.title}`);
        const itemText=el(item,"span","ln-record-copy");el(itemText,"strong","",record.title);
        el(itemText,"small","",[displayKind(record.kind),displayRecordDate(record.date)].filter(Boolean).join(" · "));
        if(focused===record.id)item.focus({preventScroll:true});
      }
      list.scrollTop=scrollTop;
    }
    for(const item of Array.from(list.querySelectorAll<HTMLButtonElement>("button[data-record-id]"))){
      const selected=item.dataset.recordId===state.selectedId;
      item.setAttribute("aria-pressed",String(selected));item.classList.toggle("is-selected",selected);
    }
    const detail=state.detail;
    documentPanel.setAttribute("aria-busy",String(state.phase==="loading-detail"));
    title.textContent=detail?.title??(state.phase==="loading-detail"?"正在读取原文…":"选择一条记录");
    source.textContent=detail?.path.trim()?detail.path:"来源路径未提供";source.hidden=!detail;
    kind.textContent=displayKind(detail?.kind)||domains.find(x=>x.id===detail?.domain)?.label||"";
    const updated=displayDate(detail?.updatedAt);
    date.textContent=detail?[displayRecordDate(detail.date),updated?`更新于 ${updated}`:""].filter(Boolean).join(" · "):"";
    date.removeAttribute("datetime");
    if(detail?.date&&displayRecordDate(detail.date)!=="日期未标注")date.dateTime=detail.date;
    showBody(detail);open.disabled=!detail?.path.trim()||state.opening;open.textContent=state.opening?"正在打开…":"在 Obsidian 中打开";
    const nextRelations = JSON.stringify([detail?.id, detail?.path, detail?.body, detail?.relations]);
    if (nextRelations !== relationSignature) {
    relationSignature = nextRelations;
    relationController?.abort();
    relationController = detail ? new AbortController() : null;
    const relationSignal = relationController?.signal;
    relations.replaceChildren();
    if(!detail?.relations.length)el(relations,"p","ln-empty",detail?"暂无已核对的明确关联。":"选择记录后查看关联。");
    for(const relation of detail?.relations??[]){
      const row=options.onOpenRelation&&relation.path?.trim()?button(relations,"ln-relation","",()=>runAction(()=>{
        if (disposed || relationSignal?.aborted || !detail || !relationSignal) return;
        return options.onOpenRelation!({...relation}, {recordId:detail.id,signal:relationSignal});
      })):el(relations,"div","ln-relation");
      if(options.onOpenRelation)row.setAttribute("aria-label",`打开关联：${relation.title}`);
      el(row,"span","ln-relation-title",relation.title);
      el(row,"small","",relationLabels[relation.kind]);
      if(relation.path)el(row,"small","ln-relation-path",relation.path);
    }
    }
    retry.hidden=state.phase!=="error";
    status.textContent=state.error??(state.phase==="loading-list"?"正在读取记录…":state.phase==="loading-detail"?"正在读取原文…":"");
    status.classList.toggle("is-error",Boolean(state.error));
  }
  function runAction(action:()=>void|Promise<void>){
    if(disposed)return;const version=++actionVersion;actionStatus.textContent="";
    Promise.resolve().then(()=>{if(!disposed&&version===actionVersion)return action();}).catch(()=>{
      if(!disposed&&version===actionVersion)actionStatus.textContent="这个入口暂时无法打开，请返回原界面重试。";
    });
  }
  const model=createNeuralRecordsModel(adapter,draw);
  draw(model.getState());
  // Set the entry filter immediately. A delayed startup must never overwrite a
  // domain the reader selects while the first list is still loading.
  const ready=options.initialDomain ? model.setDomain(options.initialDomain) : model.start();
  function destroy(){
    if(disposed)return;disposed=true;actionVersion++;relationController?.abort();relationController=null;model.dispose();stopBody();element.remove();
  }
  return {element,model,ready,destroy};
}

function displayDate(value:string|undefined):string {
  if(!value||!Number.isFinite(Date.parse(value)))return "";
  return new Date(value).toLocaleDateString("zh-CN",{year:"numeric",month:"2-digit",day:"2-digit"});
}

function displayRecordDate(value:string|undefined):string {
  if(!value||!/^\d{4}-\d{2}-\d{2}$/.test(value))return "日期未标注";
  const date=new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value?value:"日期未标注";
}

function displayKind(value:string|undefined):string {
  if(!value)return "";
  const labels:Record<string,string>={morning:"晨间日记",evening:"晚间日记",handwritten:"手写记录",review:"复盘",note:"笔记"};
  return labels[value]??value;
}
