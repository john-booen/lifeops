/** A first-person plan or reminder for an unspecified weekend day is not yet a dated task. */
export function weekendClarification(message: string): string | undefined {
  const text = message.trim().replace(/[。！!]$/u, "");
  const plan = /^(?:(?:这个|本|下个)?周末)(?:[，,\s])*(?:我(?:想|要|打算|准备)|(?:请|帮我|请帮我)?(?:安排|提醒我|记下))\s*(.+)$/u.exec(text)?.[1];
  if (!plan || /^(?:知道|问|了解|查询|怎么|如何)/u.test(plan)
    || /[？?；;\r\n]|(?:星期|礼拜|周)[一二三四五六日天]|明天|后天|\d{1,2}[月日号]|还是|或者|取消|不要|撤销|总结|复盘/u.test(plan)) return;
  return "你想安排在周六还是周日？";
}
