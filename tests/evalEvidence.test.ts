import { expect, it } from "vitest";
import { serializeJudgeEvidence, type JudgeEvidenceEntry } from "./eval/judgeEvidence";
const entry = (phase: JudgeEvidenceEntry["phase"], name: string, output: string): JudgeEvidenceEntry => ({phase,name,output});
it("keeps both current-turn originals when setup alone exceeds the former cut limit", () => {
  const before = Array.from({length:12},(_,i)=>entry("prelude","setup-"+i,"background ".repeat(500)));
  const current = [entry("current_turn","get_summaries","10/28 original"),entry("current_turn","get_summaries","11/04 original")];
  const packet = JSON.parse(serializeJudgeEvidence([...before,...current]));
  expect(packet.evidence.slice(0,2)).toEqual(current);expect(packet.currentTurnComplete).toBe(true);expect(packet.omittedEarlierEntries).toBeGreaterThan(0);
});
it("keeps a whole current read larger than the soft budget without clipping its source body", () => {
  const current=entry("current_turn","get_summaries",'"quoted original"\n'.repeat(180));
  const packet=JSON.parse(serializeJudgeEvidence([entry("prelude","setup","old"),current],1000,10_000));
  expect(packet.evidence).toEqual([current]);expect(packet.omittedEarlierEntries).toBe(1);
});
it("rejects an unmeasurably large current read instead of judging truncated material", () => {
  expect(()=>serializeJudgeEvidence([entry("current_turn","get_summaries","x".repeat(2000))],500,1000)).toThrow("未发送残缺材料");
});
it("preserves source strings, within-phase order and caller-owned entries", () => {
  const rows=[entry("fixture","fixture","initial"),entry("current_turn","first","a\n\"b"),entry("prelude","old","setup"),entry("current_turn","second","c")],before=JSON.stringify(rows);
  const packet=JSON.parse(serializeJudgeEvidence(rows));
  expect(packet.evidence).toEqual([rows[1],rows[3],rows[0],rows[2]]);expect(packet.omittedEarlierEntries).toBe(0);expect(JSON.stringify(rows)).toBe(before);
});
