import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createThreadFollowupRefreshBudget,startThreadFollowupRefresh} from './thread-followup-refresh';

beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime('2026-09-12T12:00:00Z');});
afterEach(()=>vi.useRealTimers());
function setup(){
 const refresh=vi.fn(),onFinished=vi.fn(),budget=createThreadFollowupRefreshBudget(Date.now());
 return {refresh,onFinished,budget,isVisible:()=>true};
}
it('discovers follow-ups with at most twelve refreshes and stops after two minutes',()=>{
 const input=setup(),stop=startThreadFollowupRefresh(input);
 vi.advanceTimersByTime(9_999);expect(input.refresh).not.toHaveBeenCalled();
 vi.advanceTimersByTime(1);expect(input.refresh).toHaveBeenCalledTimes(1);
 vi.advanceTimersByTime(110_000);expect(input.refresh).toHaveBeenCalledTimes(12);expect(input.onFinished).toHaveBeenCalledTimes(1);
 vi.advanceTimersByTime(600_000);expect(input.refresh).toHaveBeenCalledTimes(12);stop();
});
it('preserves the spent budget and original deadline when refreshed props restart an effect',()=>{
 const input=setup(),expiresAt=input.budget.expiresAt,first=startThreadFollowupRefresh(input);
 vi.advanceTimersByTime(40_000);first();expect(input.refresh).toHaveBeenCalledTimes(4);
 const second=startThreadFollowupRefresh(input);vi.advanceTimersByTime(80_000);
 expect(input.refresh).toHaveBeenCalledTimes(12);expect(input.budget.expiresAt).toBe(expiresAt);second();
 const third=startThreadFollowupRefresh(input);vi.advanceTimersByTime(60_000);
 expect(input.refresh).toHaveBeenCalledTimes(12);third();
});
it('does not poll a hidden page or accumulate catch-up requests when it becomes visible',()=>{
 const input=setup();let visible=false;
 const stop=startThreadFollowupRefresh({...input,isVisible:()=>visible});
 vi.advanceTimersByTime(60_000);expect(input.refresh).not.toHaveBeenCalled();visible=true;
 vi.advanceTimersByTime(60_000);expect(input.refresh).toHaveBeenCalledTimes(6);expect(input.onFinished).toHaveBeenCalledTimes(1);
 vi.advanceTimersByTime(60_000);expect(input.refresh).toHaveBeenCalledTimes(6);stop();
});
it('cancels on unmount and permits a new bounded window only with a new explicit budget',()=>{
 const input=setup(),stop=startThreadFollowupRefresh(input);stop();vi.advanceTimersByTime(120_000);
 expect(input.refresh).not.toHaveBeenCalled();expect(input.onFinished).not.toHaveBeenCalled();
 const next=startThreadFollowupRefresh({...input,budget:createThreadFollowupRefreshBudget(Date.now())});
 vi.advanceTimersByTime(180_000);expect(input.refresh).toHaveBeenCalledTimes(12);expect(input.onFinished).toHaveBeenCalledTimes(1);next();
});
it('does not issue a late request when a suspended browser resumes after the deadline',()=>{
 const input=setup(),stop=startThreadFollowupRefresh(input);vi.advanceTimersByTime(0);
 vi.setSystemTime(Date.now()+180_000);vi.advanceTimersByTime(10_000);
 expect(input.refresh).not.toHaveBeenCalled();expect(input.onFinished).toHaveBeenCalledTimes(1);stop();
});
