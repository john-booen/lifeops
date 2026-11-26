import type { StoreHost } from "../../src/store/settingsSlice";

export async function prepareTaskSubjectFixture(store: StoreHost): Promise<void> {
  if (!(await store.readPath("TEST_VAULT_ONLY.md")).includes("内容全部为虚构数据")) throw Error("只允许虚构夹具。");
  await store.writeTaskDb({ ...await store.readTaskDb(), tasks: [] });
  for (let i = 1; i <= 4; i++) await store.createTask({ title: "虚构连续改期纸样0" + i, date: "2026-11-09",
    startTime: String(18 + i) + ":00", endTime: String(18 + i) + ":30" });
  await store.createTask({ title: "虚构周六银杏邮箱设置", date: "2026-11-14", time: "10:00" });
}
