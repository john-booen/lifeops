export type NeuralDomain = "life" | "tasks" | "learning" | "projects" | "trading";

export interface NeuralRecordSummary {
  id: string;
  path: string;
  title: string;
  domain: NeuralDomain;
  date?: string;
  updatedAt?: string;
  kind?: string;
}

export interface NeuralRecordRelation {
  id: string;
  title: string;
  path?: string;
  kind: "link" | "source" | "task" | "project";
}

export interface NeuralRecordDetail extends NeuralRecordSummary {
  body: string;
  relations: readonly NeuralRecordRelation[];
}

export interface NeuralRecordsAdapter {
  list(input: { domain: NeuralDomain | "all"; signal: AbortSignal }): Promise<readonly NeuralRecordSummary[]>;
  read(id: string, input: { signal: AbortSignal }): Promise<NeuralRecordDetail>;
  open(id: string, input: { signal: AbortSignal }): Promise<void>;
}

export interface NeuralRecordsState {
  domain: NeuralDomain | "all";
  query: string;
  records: readonly NeuralRecordSummary[];
  selectedId: string | null;
  detail: NeuralRecordDetail | null;
  phase: "idle" | "loading-list" | "loading-detail" | "ready" | "error";
  error: string | null;
  opening: boolean;
}

export type State = NeuralRecordsState;

export interface NeuralRecordsModel {
  start(): Promise<void>;
  setDomain(domain: NeuralDomain | "all"): Promise<void>;
  select(id: string): Promise<void>;
  setQuery(query: string): void;
  openSelected(): Promise<void>;
  reload(): Promise<void>;
  dispose(): void;
  getState(): NeuralRecordsState;
}

function copySummary(record: NeuralRecordSummary): NeuralRecordSummary {
  return {
    id: record.id,
    path: record.path,
    title: record.title,
    domain: record.domain,
    date: record.date,
    updatedAt: record.updatedAt,
    kind: record.kind
  };
}

function copyDetail(record: NeuralRecordDetail): NeuralRecordDetail {
  return {
    ...copySummary(record),
    body: record.body,
    relations: record.relations.map(relation => ({
      id: relation.id,
      title: relation.title,
      path: relation.path,
      kind: relation.kind
    }))
  };
}

export function createNeuralRecordsModel(
  adapter: NeuralRecordsAdapter,
  onState: (state: NeuralRecordsState) => void
): NeuralRecordsModel {
  let state: NeuralRecordsState = {
    domain: "all",
    query: "",
    records: [],
    selectedId: null,
    detail: null,
    phase: "idle",
    error: null,
    opening: false
  };
  let disposed = false;
  let generation = 0;
  let listController: AbortController | null = null;
  let readController: AbortController | null = null;
  let openController: AbortController | null = null;

  // Neither observers nor adapter-owned objects can change the model's state.
  function getState(): NeuralRecordsState {
    return {
      ...state,
      records: state.records.map(copySummary),
      detail: state.detail ? copyDetail(state.detail) : null
    };
  }

  function update(patch: Partial<NeuralRecordsState>): void {
    if (disposed) return;
    state = { ...state, ...patch };
    onState(getState());
  }

  function cancelPending(): void {
    generation += 1;
    listController?.abort();
    readController?.abort();
    openController?.abort();
    listController = null;
    readController = null;
    openController = null;
  }

  // The generation also protects adapters that do not honor AbortSignal.
  function current(requestGeneration: number, controller: AbortController): boolean {
    return !disposed && generation === requestGeneration && !controller.signal.aborted;
  }

  async function load(domain: NeuralDomain | "all"): Promise<void> {
    if (disposed) return;
    cancelPending();
    const requestGeneration = generation;
    const controller = new AbortController();
    listController = controller;
    update({ domain, records: [], selectedId: null, detail: null, phase: "loading-list", error: null, opening: false });
    // A callback may itself close the view or switch the domain.
    if (!current(requestGeneration, controller)) return;
    try {
      const records = await adapter.list({ domain, signal: controller.signal });
      if (!current(requestGeneration, controller)) return;
      const ownedRecords = records.map(copySummary);
      listController = null;
      update({ records: ownedRecords, phase: "ready", error: null });
    } catch {
      if (!current(requestGeneration, controller)) return;
      listController = null;
      update({ phase: "error", error: "记录列表加载失败，请重试。" });
    }
  }

  async function select(id: string): Promise<void> {
    if (disposed) return;
    const listed = state.records.some(record => record.id === id);
    cancelPending();
    if (!listed) {
      update({ selectedId: null, detail: null, phase: "error", error: "所选记录不在当前列表中，请刷新后重试。", opening: false });
      return;
    }
    const requestGeneration = generation;
    const controller = new AbortController();
    readController = controller;
    update({ selectedId: id, detail: null, phase: "loading-detail", error: null, opening: false });
    if (!current(requestGeneration, controller)) return;
    try {
      const record = await adapter.read(id, { signal: controller.signal });
      if (!current(requestGeneration, controller)) return;
      if (record.id !== id) {
        readController = null;
        update({ detail: null, phase: "error", error: "记录标识与所选记录不一致，请刷新后重试。" });
        return;
      }
      const ownedDetail = copyDetail(record);
      readController = null;
      update({ detail: ownedDetail, phase: "ready", error: null });
    } catch {
      if (!current(requestGeneration, controller)) return;
      readController = null;
      update({ detail: null, phase: "error", error: "记录正文加载失败，请重试。" });
    }
  }

  async function openSelected(): Promise<void> {
    if (disposed || state.opening || state.selectedId === null || !state.detail || !state.detail.path.trim()) return;
    const id = state.selectedId;
    const requestGeneration = generation;
    const controller = new AbortController();
    openController = controller;
    update({ opening: true, phase: "ready", error: null });
    if (!current(requestGeneration, controller)) return;
    try {
      await adapter.open(id, { signal: controller.signal });
      if (!current(requestGeneration, controller)) return;
      openController = null;
      update({ opening: false, phase: "ready", error: null });
    } catch {
      if (!current(requestGeneration, controller)) return;
      openController = null;
      update({ opening: false, phase: "error", error: "原文打开失败，请重试。" });
    }
  }

  return {
    start: () => load(state.domain),
    setDomain: load,
    select,
    setQuery: query => { if (!disposed) update({ query }); },
    openSelected,
    reload: () => load(state.domain),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancelPending();
      // A closed view must release the model-owned copy of the loaded record.
      state = { ...state, query: "", records: [], selectedId: null, detail: null, phase: "idle", error: null, opening: false };
    },
    getState
  };
}
