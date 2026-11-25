/** These are write guards, not shortcuts that guess and execute a user's task. */
export function outsideQuotedTaskText(message: string): string {
  return message.replace(/「[^「」]*」|『[^『』]*』|“[^“”]*”|‘[^‘’]*’|"[^"\r\n]*"|'[^'\r\n]*'/gu, '');
}
export function taskConfirmationRequested(message: string): boolean {
  const outside = outsideQuotedTaskText(message).replace(/(?:不用|无需|不必)(?:再)?(?:等我|等待我|等)?确认/gu, '');
  return /(?:等|待)(?:我|本人)?(?:确认|同意)|(?:确认|同意)(?:后|之后|以后)|先[^。！？\n]{0,12}(?:待确认|确认卡|确认)/u.test(outside);
}
export function taskCreationPolicy(message = ''): {wait: boolean; denied: boolean} {
  const outside = outsideQuotedTaskText(message).trim();
  const wait = taskConfirmationRequested(message) || /[?？]$|(?:吗|呢)$/u.test(outside);
  const example = /(?:这|那)(?:只是|仅是|仅仅是|是)?(?:举个|举的|一个)?(?:例子|示例)|(?:^|[，,。；;\s])(?:例如|比如|举例(?:来说)?|假如|假设|如果|要是)(?:[，,：:\s]|我|明天|今天|后天|下周|你)/u.test(outside);
  const cancelled = /算了|(?:取消(?:了)?|不用了?|不建了)[。！!\s]*$|(?:取消)(?:这(?:个|项|条)?|刚才的)?(?:创建|新建|保存|安排)/u.test(outside);
  const noWrite = /(?:不要|不用|别|先别|暂不)(?:再)?(?:创建|新建|建(?:立)?|保存|执行)/u.test(outside);
  return {wait, denied: example || cancelled || !wait && noWrite};
}
export function stripTaskWaitSuffix(value: string): string {
  return value.replace(/[，,；;\s]*(?:(?:等|待)我(?:确认|同意)|(?:先[^。！？\n]{0,12}(?:确认卡|待确认))(?:再保存)?|确认后(?:再)?保存)[。！!\s]*$/u, '').trim();
}
export function taskCreationTitle(title: string, userMessage = ''): string {
  if (!taskConfirmationRequested(userMessage)) return title;
  const quoted = [...userMessage.matchAll(/「([^「」]*)」|『([^『』]*)』|“([^“”]*)”|"([^"\r\n]*)"/gu)].flatMap(match => match.slice(1).filter(Boolean));
  return quoted.includes(title) ? title : stripTaskWaitSuffix(title);
}
