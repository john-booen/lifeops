/** A simple lookup may finish at the verified list; compound requests continue. */
export function simpleReadOnlyTaskLookup(message: string): boolean {
  const text = message.trim();
  if (text.length > 200 || !/^(?:请|麻烦)?(?:帮我)?(?:查|找|列出|列一下)/u.test(text)) return false;
  const clause = /(?:^|[，,。；;\s])(?:先)?(?:(?:不要|不)(?:做任何|做)?(?:修改|改动|调整)|只查不改|只看不改|只读即可)(?=$|[，,。；;\s])/u;
  if (!clause.test(text) && !/(?:任务|待办)/u.test(text)) return false;
  const request = text.replace(clause, " ").replace(/(?:未完成|已完成)/gu, "");
  return !/(?:解释|分析|为什么|原因|建议|规划|安排|优先|排序|比较|统计|完成率|如何|怎么|顺便|然后|之后|接着|同时|并|修改|更正|调整|改名|改成|改为|改到|删除|新建|创建|挪到|移到|定在|设为|标记|确认|执行|完成)/u.test(request);
}
