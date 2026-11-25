import {expect,it} from 'vitest';
// @ts-expect-error Release helpers run directly under Node.
import {assertDailyInstallPolicy} from '../scripts/daily-install-policy.mjs';
const history=[{version:'0.5.130',installedAt:'2026-11-25T11:00:00Z'},{version:'0.5.131',installedAt:'2026-11-25T12:51:00Z'}];
const check=(patch:Record<string,unknown>={})=>assertDailyInstallPolicy({version:'0.5.132',history,now:new Date('2026-11-26T00:00:00Z'),...patch});
it.each(['2026-11-25T16:00:00Z','2026-11-25T22:59:59Z'])('never installs during Shanghai quiet hours, including a claimed emergency: %s',now=>{
  expect(()=>check({now:new Date(now),authorization:{emergency:{kind:'unusable',evidenceSha256:'a'.repeat(64)}}})).toThrow('00:00');
});
it('counts previous installs and permits the next regular week without waiting on a calendar milestone',()=>{
  expect(()=>check()).toThrow('两次');expect(check({now:new Date('2026-11-30T00:00:00Z')})).toMatchObject({kind:'regular',previousWeeklyInstalls:0});
});
it('permits only the specifically adopted transition batch and refuses repeats or expired authorization',()=>{
  const transition={version:'0.5.132',notBefore:'2026-11-25',notAfter:'2026-11-27',evidenceSha256:'a'.repeat(64)};
  expect(check({authorization:{transition}})).toMatchObject({kind:'authorized-transition',previousWeeklyInstalls:2});
  expect(()=>check({history:[...history,{version:'0.5.132',installedAt:'2026-11-26T00:00:00Z'}],authorization:{transition}})).toThrow('重复');
  expect(()=>check({now:new Date('2026-11-28T00:00:00Z'),authorization:{transition}})).toThrow('专项');
});
it('keeps an evidenced emergency separate and rejects treating ordinary fixes as emergencies',()=>{
  expect(check({authorization:{emergency:{kind:'data_loss',evidenceSha256:'a'.repeat(64)}}})).toMatchObject({kind:'emergency',reason:'data_loss'});
  expect(()=>check({authorization:{emergency:{kind:'ordinary_bugfix',evidenceSha256:'a'.repeat(64)}}})).toThrow('紧急');
});
