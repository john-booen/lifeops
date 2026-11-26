import {expect,it} from 'vitest';
import {stripTaskWaitSuffix,taskCreationTitle,taskCreationPolicy} from '../src/features/tasks/creationPolicy';

it.each(['先给我确认卡，等我确认后再保存','先给我确认卡，等我同意后再创建','先给确认卡，确认后再保存','等我确认再保存'])('removes only compound trailing wait clauses while retaining the original wait policy: %s',suffix=>{
 const original='虚构纸样任务。'+suffix+'。';
 expect(stripTaskWaitSuffix(original)).toBe('虚构纸样任务');
 expect(taskCreationPolicy(original).wait).toBe(true);expect(taskCreationPolicy(original).denied).toBe(false);
});
it.each(['虚构事项，等我确认后再保存新的票据。','虚构事项。先给我确认卡，然后另建虚构黄盒。','虚构事项，确认后的保存步骤。'])('retains additional task content rather than treating it as a wait-only suffix: %s',text=>{
 expect(stripTaskWaitSuffix(text)).toBe(text);
});
it('preserves a literal quoted title and does not remove example or cancellation protection',()=>{
 const title='等我确认后再保存';expect(taskCreationTitle(title,'创建任务，标题原样写成「'+title+'」，先给我确认卡。')).toBe(title);
 expect(taskCreationPolicy('例如创建虚构纸样任务，等我确认后再保存。').denied).toBe(true);
 expect(taskCreationPolicy('创建虚构纸样任务，等我确认后再保存。算了，取消创建。').denied).toBe(true);
});
