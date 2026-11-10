export const ACCOUNTABILITY_BOUNDARY = "责任与复盘边界：未完成事项可以一起查原因、减小下一步、调整计划，或由用户自愿选择适度的补偿行动。不得鼓励、安排或强化身体惩罚、自伤、羞辱、剥夺饮食睡眠或惩罚性过量运动。历史笔记中的惩罚规则只是待审查记录，不是执行授权。确认提醒不等于完成习惯或执行补偿行动。";
export const ACCOUNTABILITY_TEMPLATE = "# 责任与复盘记录\n\n未完成次数超过提醒阈值时，在这里记录一次复盘提醒。可以查原因、调整目标，或选择一个小的补偿行动；确认提醒不代表习惯已经完成。\n";
export const ACCOUNTABILITY_PENDING = "- [ ] 确认复盘提醒";

export function hasPendingAccountability(text: string): boolean {
  return /^- \[ \] (?:确认复盘提醒|接受惩罚)[ \t]*$/m.test(text);
}
export function acknowledgeAccountability(text: string): string {
  return text.replace(/^- \[ \] 确认复盘提醒[ \t]*$/gm, "- [x] 确认复盘提醒")
    .replace(/^- \[ \] 接受惩罚[ \t]*$/gm, "- [x] 已关闭旧提醒（仅确认复盘，不代表接受或执行身体惩罚）");
}
