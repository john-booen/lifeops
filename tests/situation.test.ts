import {describe,expect,it} from "vitest";
import {buildSituation,situationContextBlock,situationToMarkdown} from "../src/situation";
import {getTimeContext} from "../src/timeContext";

describe("situation without media inputs",()=>{
 it("retains clock context without inventing device observations",()=>{
  const now=new Date(2026,10,5,10,0),time=getTimeContext(now),situation=buildSituation({time,generatedAt:now.toISOString()});
  expect(situation.time.date).toBe(time.date);expect(situation.evidence.map(item=>item.source)).toEqual(["time"]);
  expect(situationToMarkdown(situation)).not.toMatch(/camera:|desktop:/);
  expect(situationContextBlock(situation).content).toBe(situationToMarkdown(situation));
 });
 it("retains an explicit voice fatigue signal after media removal",()=>{
  const time=getTimeContext(new Date(2026,10,5,10,0));
  const situation=buildSituation({time,voice:{isActive:true,lastUserMessage:"纯虚构：我有点累。",lastSentiment:{valence:0,urgency:0,frustration:0,anxiety:0,fatigue:0.8,excitement:0}}});
  expect(situation.evidence.map(item=>item.source)).toEqual(["time","voice"]);
  expect(situation.fusion.suggestedCiciMode).toBe("health_care");expect(situation.fusion.suggestedCiciAction).toBe("encourage");
 });
});
