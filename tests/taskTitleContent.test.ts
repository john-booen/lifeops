import {expect,it} from 'vitest';
import {explicitScheduledTaskTitle} from '../src/taskReference';

it.each(['明天下午三点前给虚构蓝鲸盒贴标签。','下周三15:00前给虚构蓝鲸盒贴标签。','后天上午十点前给虚构蓝鲸盒贴标签。'])('preserves the full action after a parsed date and completion clock: %s',message=>{
 expect(explicitScheduledTaskTitle('虚构蓝鲸盒贴标签',message)).toBe('给虚构蓝鲸盒贴标签');
});
it.each(['明天下午三点前给虚构蓝鲸盒贴标签，再整理其他盒子。','明天下午三点到四点给虚构蓝鲸盒贴标签。','明天十五点六十分前给虚构蓝鲸盒贴标签。','昨天讨论了明天下午三点前给虚构蓝鲸盒贴标签。'])('does not expand a title from multiple clauses or an unverifiable schedule: %s',message=>{
 expect(explicitScheduledTaskTitle('虚构蓝鲸盒贴标签',message)).toBe('虚构蓝鲸盒贴标签');
});
it.each(['明天下午三点前提醒虚构叶宁给纸盒贴标签。','明天下午三点前提醒我给纸盒贴标签。'])('keeps reminder request words out of an otherwise complete model title: %s',message=>{
 const title=message.includes('提醒我')?'给纸盒贴标签':'虚构叶宁给纸盒贴标签';
 expect(explicitScheduledTaskTitle(title,message)).toBe(title);
});
it('preserves an explicitly supplied literal reminder title',()=>{
 const title='提醒虚构叶宁给纸盒贴标签';
 expect(explicitScheduledTaskTitle(title,'明天下午三点前提醒虚构叶宁给纸盒贴标签。')).toBe(title);
});
