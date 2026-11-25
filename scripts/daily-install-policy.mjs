import {isAbsolute} from 'node:path';
import {assert, readRegularFile, sha256} from './verify-plugin-package.mjs';

const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
/** Installs are user interruptions, including versions installed before this policy. */
export function assertDailyInstallPolicy({version, history, authorization = {}, now = new Date()}) {
  assert(Number.isFinite(now.getTime()), '安装时钟无效');
  const local = new Date(now.getTime() + 8 * 60 * 60 * 1000), day = local.toISOString().slice(0, 10);
  assert(local.getUTCHours() >= 7, '上海00:00–07:00不安装；继续独立工作，保留现有日用程序');
  assert(Array.isArray(history) && history.length > 0 && history.every(row => typeof row.version === 'string' && timestamp(row.installedAt)), '缺少已核对的安装历史');
  const monday = new Date(local); monday.setUTCDate(local.getUTCDate() - (local.getUTCDay() + 6) % 7);
  const weekStart = monday.toISOString().slice(0, 10);
  const weekly = history.filter(row => {
    const date = new Date(Date.parse(row.installedAt) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return date >= weekStart && date <= day;
  });
  const emergency = authorization.emergency;
  if (emergency) {
    assert(['data_loss', 'unusable'].includes(emergency.kind) && /^[a-f0-9]{64}$/u.test(emergency.evidenceSha256 ?? ''), '紧急通道仅限有依据的数据丢失或不可使用');
    return {kind: 'emergency', day, previousWeeklyInstalls: weekly.length, reason: emergency.kind};
  }
  assert(!history.some(row => row.version === version), '该批次已安装，不能重复重载日用程序');
  const transition = authorization.transition;
  if (transition) {
    assert(transition.version === version && /^\d{4}-\d{2}-\d{2}$/u.test(transition.notBefore ?? '')
      && /^\d{4}-\d{2}-\d{2}$/u.test(transition.notAfter ?? '') && day >= transition.notBefore && day <= transition.notAfter
      && /^[a-f0-9]{64}$/u.test(transition.evidenceSha256 ?? ''), '专项合批授权与本次版本或日期不符');
    return {kind: 'authorized-transition', day, previousWeeklyInstalls: weekly.length};
  }
  assert(weekly.length < 2, '本周已达两次常规安装，继续开发并保留现有日用程序');
  return {kind: 'regular', day, previousWeeklyInstalls: weekly.length};
}

/** The private policy references actual hashed receipts and the adopted decision. */
export async function verifyDailyInstallPolicy(path, version, now = new Date()) {
  assert(typeof path === 'string' && isAbsolute(path), '真实日用安装须提供库外安装策略');
  const policy = JSON.parse((await readRegularFile(path)).toString('utf8'));
  assert(Array.isArray(policy.historyReceipts), '安装策略缺少历史凭据');
  const history = [];
  for (const ref of policy.historyReceipts) {
    assert(isAbsolute(ref.path) && /^[a-f0-9]{64}$/u.test(ref.sha256), '安装凭据引用无效');
    const bytes = await readRegularFile(ref.path); assert(sha256(bytes) === ref.sha256, '安装凭据发生变化');
    const receipt = JSON.parse(bytes.toString('utf8'));
    assert(receipt.heartbeat === true && receipt.backupHashesVerified === true, '历史凭据未证实成功安装');
    history.push({version: receipt.version, installedAt: receipt.installedAt});
  }
  const authorization = policy.authorization ?? {};
  for (const decision of [authorization.transition, authorization.emergency].filter(Boolean)) {
    assert(isAbsolute(decision.evidencePath), '安装授权缺少原件');
    assert(sha256(await readRegularFile(decision.evidencePath)) === decision.evidenceSha256, '安装授权原件发生变化');
  }
  return assertDailyInstallPolicy({version, history, authorization, now});
}
