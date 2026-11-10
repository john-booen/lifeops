import { describe, expect, it, vi } from "vitest";
import {
  createNeuralRecordsModel,
  type NeuralRecordDetail,
  type NeuralRecordsAdapter,
  type NeuralRecordsState,
  type NeuralRecordSummary
} from "../src/panel/neuralRecordsModel";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function summary(id: string, domain: NeuralRecordSummary["domain"] = "life"): NeuralRecordSummary {
  return { id, path: `${domain}/${id}.md`, title: `记录 ${id}`, domain, kind: "日记", date: "2026-10-22", updatedAt: "2026-10-23" };
}

function detail(id: string, domain: NeuralRecordSummary["domain"] = "life"): NeuralRecordDetail {
  return { ...summary(id, domain), body: `正文 ${id}`, relations: [{ id: `source-${id}`, title: "来源", path: "sources/fictional.md", kind: "source" }] };
}

function adapter() {
  return {
    list: vi.fn<NeuralRecordsAdapter["list"]>().mockResolvedValue([summary("a"), summary("b")]),
    read: vi.fn<NeuralRecordsAdapter["read"]>().mockImplementation(async id => detail(id)),
    open: vi.fn<NeuralRecordsAdapter["open"]>().mockResolvedValue(undefined)
  };
}

describe("read-only neural records model", () => {
  it("loads summaries without automatically reading or opening a record", async () => {
    const source = adapter();
    const onState = vi.fn();
    const model = createNeuralRecordsModel(source, onState);
    expect(model.getState()).toMatchObject({ domain: "all", phase: "idle", selectedId: null, detail: null, query: "", opening: false, error: null });
    await model.start();
    expect(source.list).toHaveBeenCalledWith({ domain: "all", signal: expect.any(AbortSignal) });
    expect(model.getState()).toMatchObject({ phase: "ready", records: [summary("a"), summary("b")], selectedId: null, detail: null });
    expect(source.read).not.toHaveBeenCalled();
    expect(source.open).not.toHaveBeenCalled();
    expect(onState.mock.calls.map(([state]) => state.phase)).toEqual(["loading-list", "ready"]);
  });

  it.each(["resolve", "reject"] as const)("ignores an old list %s after switching domain", async result => {
    const oldList = deferred<readonly NeuralRecordSummary[]>();
    const newList = deferred<readonly NeuralRecordSummary[]>();
    const source = adapter();
    source.list.mockReturnValueOnce(oldList.promise).mockReturnValueOnce(newList.promise);
    const onState = vi.fn();
    const model = createNeuralRecordsModel(source, onState);
    const oldRequest = model.start();
    const oldSignal = source.list.mock.calls[0][0].signal;
    const newRequest = model.setDomain("tasks");
    expect(oldSignal.aborted).toBe(true);
    newList.resolve([summary("task", "tasks")]);
    await newRequest;
    const current = model.getState();
    const emissions = onState.mock.calls.length;
    if (result === "resolve") oldList.resolve([summary("old")]);
    else oldList.reject(new Error("old failure"));
    await oldRequest;
    expect(model.getState()).toEqual(current);
    expect(model.getState()).toMatchObject({ domain: "tasks", records: [summary("task", "tasks")], phase: "ready", error: null });
    expect(onState).toHaveBeenCalledTimes(emissions);
  });

  it.each(["resolve", "reject"] as const)("ignores an old read %s after selecting a new record", async result => {
    const oldRead = deferred<NeuralRecordDetail>();
    const newRead = deferred<NeuralRecordDetail>();
    const source = adapter();
    source.read.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    const model = createNeuralRecordsModel(source, vi.fn());
    await model.start();
    const oldRequest = model.select("a");
    const oldSignal = source.read.mock.calls[0][1].signal;
    const newRequest = model.select("b");
    expect(oldSignal.aborted).toBe(true);
    newRead.resolve(detail("b"));
    await newRequest;
    const current = model.getState();
    if (result === "resolve") oldRead.resolve(detail("a"));
    else oldRead.reject(new Error("old failure"));
    await oldRequest;
    expect(model.getState()).toEqual(current);
    expect(model.getState()).toMatchObject({ phase: "ready", selectedId: "b", detail: detail("b"), error: null });
  });

  it("clears the prior selection and detail as soon as domain changes", async () => {
    const source = adapter();
    const next = deferred<readonly NeuralRecordSummary[]>();
    const model = createNeuralRecordsModel(source, vi.fn());
    await model.start();
    await model.select("a");
    source.list.mockReturnValueOnce(next.promise);
    const request = model.setDomain("projects");
    expect(model.getState()).toMatchObject({ domain: "projects", phase: "loading-list", records: [], selectedId: null, detail: null, error: null });
    next.resolve([summary("p", "projects")]);
    await request;
    expect(source.read).toHaveBeenCalledTimes(1);
  });

  it("retries a failed list with reload and a failed read by reselecting", async () => {
    const source = adapter();
    source.list.mockRejectedValueOnce(new Error("列表暂不可用"));
    source.read.mockRejectedValueOnce(new Error("详情暂不可用"));
    const model = createNeuralRecordsModel(source, vi.fn());
    await model.start();
    expect(model.getState()).toMatchObject({ phase: "error", error: "记录列表加载失败，请重试。", records: [] });
    await model.reload();
    expect(model.getState()).toMatchObject({ phase: "ready", error: null });
    await model.select("a");
    expect(model.getState()).toMatchObject({ phase: "error", error: "记录正文加载失败，请重试。", selectedId: "a", detail: null });
    await model.select("a");
    expect(model.getState()).toMatchObject({ phase: "ready", error: null, selectedId: "a", detail: detail("a") });
    expect(source.list).toHaveBeenCalledTimes(2);
    expect(source.read).toHaveBeenCalledTimes(2);
  });

  it("does not read an unlisted id and rejects a detail with a mismatched id", async () => {
    const source = adapter();
    const model = createNeuralRecordsModel(source, vi.fn());
    await model.start();
    await model.select("unlisted");
    expect(source.read).not.toHaveBeenCalled();
    expect(model.getState()).toMatchObject({ phase: "error", selectedId: null, detail: null });
    expect(model.getState().error).toBeTruthy();
    source.read.mockResolvedValueOnce(detail("wrong-id"));
    await model.select("a");
    expect(model.getState()).toMatchObject({ phase: "error", selectedId: "a", detail: null, error: "记录标识与所选记录不一致，请刷新后重试。" });
    await model.openSelected();
    expect(source.open).not.toHaveBeenCalled();
  });

  it("copies adapter data and observer snapshots including detail relations", async () => {
    const source = adapter();
    const listRecord = summary("a");
    const list = [listRecord];
    const readRecord = detail("a");
    const relation = readRecord.relations[0];
    const relations = readRecord.relations as Array<typeof relation>;
    source.list.mockResolvedValueOnce(list);
    source.read.mockResolvedValueOnce(readRecord);
    const snapshots: NeuralRecordsState[] = [];
    const model = createNeuralRecordsModel(source, state => { snapshots.push(state); });
    await model.start();
    listRecord.title = "adapter 改写";
    listRecord.date = "2099-01-01";
    list.push(summary("injected"));
    const listSnapshot = snapshots.at(-1)!;
    listSnapshot.records[0].title = "observer 改写";
    (listSnapshot.records as NeuralRecordSummary[]).push(summary("observer"));
    await model.select("a");
    readRecord.body = "adapter 改写正文";
    readRecord.title = "adapter 改写标题";
    readRecord.date = "2099-01-02";
    relation.title = "adapter 改写关系";
    relations.push({ id: "injected", title: "注入", kind: "link" });
    const callbackSnapshot = snapshots.at(-1)!;
    callbackSnapshot.detail!.body = "observer 改写正文";
    callbackSnapshot.detail!.relations[0].title = "observer 改写关系";
    const returnedSnapshot = model.getState();
    returnedSnapshot.records[0].title = "getState 改写";
    returnedSnapshot.detail!.relations[0].title = "getState 改写关系";
    expect(model.getState()).toMatchObject({ records: [summary("a")], detail: detail("a") });
  });

  it("stores search text without listing, reading, or opening", async () => {
    const source = adapter();
    const model = createNeuralRecordsModel(source, vi.fn());
    await model.start();
    await model.select("a");
    source.list.mockClear(); source.read.mockClear(); source.open.mockClear();
    model.setQuery("  晨间 fictional  ");
    expect(model.getState()).toMatchObject({ query: "  晨间 fictional  ", detail: detail("a") });
    expect(source.list).not.toHaveBeenCalled();
    expect(source.read).not.toHaveBeenCalled();
    expect(source.open).not.toHaveBeenCalled();
  });

  it("requires an explicit selection and prevents duplicate opens while allowing failure retry", async () => {
    const source = adapter();
    const firstOpen = deferred<void>();
    source.open.mockReturnValueOnce(firstOpen.promise);
    const model = createNeuralRecordsModel(source, vi.fn());
    await model.start();
    await model.openSelected();
    expect(source.open).not.toHaveBeenCalled();
    await model.select("a");
    const request = model.openSelected();
    await model.openSelected();
    expect(source.open).toHaveBeenCalledTimes(1);
    expect(source.open).toHaveBeenCalledWith("a", { signal: expect.any(AbortSignal) });
    expect(model.getState().opening).toBe(true);
    firstOpen.reject(new Error("无法打开原文"));
    await request;
    expect(model.getState()).toMatchObject({ opening: false, phase: "error", error: "原文打开失败，请重试。", detail: detail("a") });
    await model.openSelected();
    expect(source.open).toHaveBeenCalledTimes(2);
    expect(model.getState()).toMatchObject({ opening: false, phase: "ready", error: null, detail: detail("a") });
  });

  it.each(["", "   "])("does not open a record with an empty source path %j", async path => {
    const source = adapter();
    source.read.mockResolvedValueOnce({ ...detail("a"), path });
    const model = createNeuralRecordsModel(source, vi.fn());
    await model.start();
    await model.select("a");
    await model.openSelected();
    expect(source.open).not.toHaveBeenCalled();
    expect(model.getState()).toMatchObject({ selectedId: "a", opening: false, phase: "ready", detail: { path } });
  });

  it.each(["list", "read", "open"] as const)("shows only a fixed safe message for %s adapter failures", async operation => {
    const privateText = "FICTIONAL_SECRET_sk-example /fictional/private-note.md 正文片段：不可显示";
    for (const failure of [new Error(privateText), privateText]) {
      const source = adapter();
      const observedErrors: Array<string | null> = [];
      const model = createNeuralRecordsModel(source, state => { observedErrors.push(state.error); });
      let expected: string;
      if (operation === "list") {
        source.list.mockRejectedValueOnce(failure);
        await model.start();
        expected = "记录列表加载失败，请重试。";
      } else {
        await model.start();
        if (operation === "read") {
          source.read.mockRejectedValueOnce(failure);
          await model.select("a");
          expected = "记录正文加载失败，请重试。";
        } else {
          await model.select("a");
          source.open.mockRejectedValueOnce(failure);
          await model.openSelected();
          expected = "原文打开失败，请重试。";
        }
      }
      expect(model.getState()).toMatchObject({ phase: "error", error: expected });
      expect(observedErrors.filter(Boolean)).toEqual([expected]);
      expect(JSON.stringify(observedErrors)).not.toContain(privateText);
      expect(model.getState().error).not.toMatch(/FICTIONAL_SECRET|private-note|正文片段/);
    }
  });

  it.each(["selection", "domain"] as const)("cancels an open when %s changes and ignores its late failure", async action => {
    const source = adapter();
    const held = deferred<void>();
    source.open.mockReturnValueOnce(held.promise);
    const model = createNeuralRecordsModel(source, vi.fn());
    await model.start();
    await model.select("a");
    const request = model.openSelected();
    const signal = source.open.mock.calls[0][1].signal;
    if (action === "selection") await model.select("b");
    else await model.setDomain("tasks");
    expect(signal.aborted).toBe(true);
    const current = model.getState();
    held.reject(new Error("old open failure"));
    await request;
    expect(model.getState()).toEqual(current);
    expect(model.getState().opening).toBe(false);
    expect(model.getState().error).toBeNull();
  });

  it.each(["list", "read", "open"] as const)("cancels pending %s on dispose and ignores both later results and new operations", async operation => {
    const source = adapter();
    const pendingList = deferred<readonly NeuralRecordSummary[]>();
    const pendingRead = deferred<NeuralRecordDetail>();
    const pendingOpen = deferred<void>();
    const onState = vi.fn();
    const model = createNeuralRecordsModel(source, onState);
    let request: Promise<void>;
    let signal: AbortSignal;
    if (operation === "list") {
      source.list.mockReturnValueOnce(pendingList.promise);
      request = model.start();
      signal = source.list.mock.calls[0][0].signal;
    } else {
      await model.start();
      if (operation === "read") {
        source.read.mockReturnValueOnce(pendingRead.promise);
        request = model.select("a");
        signal = source.read.mock.calls[0][1].signal;
      } else {
        await model.select("a");
        source.open.mockReturnValueOnce(pendingOpen.promise);
        request = model.openSelected();
        signal = source.open.mock.calls[0][1].signal;
      }
    }
    model.dispose();
    model.dispose();
    expect(signal.aborted).toBe(true);
    const closedState = model.getState();
    const emissions = onState.mock.calls.length;
    const calls = [source.list.mock.calls.length, source.read.mock.calls.length, source.open.mock.calls.length];
    if (operation === "list") pendingList.resolve([summary("late")]);
    else if (operation === "read") pendingRead.reject(new Error("late read failure"));
    else pendingOpen.reject(new Error("late open failure"));
    await request;
    await model.start(); await model.reload(); await model.setDomain("tasks"); await model.select("b"); await model.openSelected();
    model.setQuery("closed query");
    expect(model.getState()).toEqual(closedState);
    expect(onState).toHaveBeenCalledTimes(emissions);
    expect([source.list.mock.calls.length, source.read.mock.calls.length, source.open.mock.calls.length]).toEqual(calls);
  });

  it("releases the loaded record and search state on dispose without emitting or reopening", async () => {
    const source = adapter();
    const onState = vi.fn();
    const model = createNeuralRecordsModel(source, onState);
    await model.start();
    await model.select("a");
    model.setQuery("private search");
    expect(model.getState()).toMatchObject({ records: [summary("a"), summary("b")], selectedId: "a", detail: detail("a"), query: "private search" });
    const emissions = onState.mock.calls.length;
    const calls = [source.list.mock.calls.length, source.read.mock.calls.length, source.open.mock.calls.length];
    model.dispose();
    model.dispose();
    const released = { domain: "all", query: "", records: [], selectedId: null, detail: null, phase: "idle", error: null, opening: false };
    expect(model.getState()).toEqual(released);
    await model.start(); await model.reload(); await model.setDomain("tasks"); await model.select("b"); await model.openSelected();
    model.setQuery("closed query");
    expect(model.getState()).toEqual(released);
    expect(onState).toHaveBeenCalledTimes(emissions);
    expect([source.list.mock.calls.length, source.read.mock.calls.length, source.open.mock.calls.length]).toEqual(calls);
  });

  it("does not start adapter I/O if the loading callback disposes the model", async () => {
    const source = adapter();
    let model!: ReturnType<typeof createNeuralRecordsModel>;
    model = createNeuralRecordsModel(source, state => { if (state.phase === "loading-list") model.dispose(); });
    await model.start();
    expect(source.list).not.toHaveBeenCalled();
    expect(source.read).not.toHaveBeenCalled();
    expect(source.open).not.toHaveBeenCalled();
  });
});
