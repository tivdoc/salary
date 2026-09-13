import {expect,it} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {legacySourceIntakeFixture} from './saved-legacy-source-intake.fixture';
import {savedLegacySourceIntake,effectiveLegacySourcePeriods} from './saved-legacy-source-intake';
import {sourceIntakeReadingCoverage} from './source-intake-coverage';
function fixture(answer?:unknown){const f=legacySourceIntakeFixture();if(answer)f.answerRow.answer=JSON.stringify(answer);f.input.journalSha256=canonicalSha256(f.journal);return f;}
it.each([
 ['2026-06-18','2026-07-17','partial_period',[]],
 ['2026-06-01','2026-06-30','single_month_identified',['2026-06']],
 ['2026-06-01','2026-07-31','multi_month_dispatch_required',['2026-06','2026-07']],
] as const)('distinguishes printed %s–%s without lending incomplete days to another month',(from,to,state,months)=>{
 const seed=fixture(),f=fixture({...seed.answer,value:{...seed.answer.value,period:{from,to}}}),saved=savedLegacySourceIntake(f.input),before=canonicalSha256(saved);
 expect(sourceIntakeReadingCoverage(saved,f.scope)).toMatchObject([{state,period:{from,to},months,version_id:f.document.version_id,source_sha256:f.document.sha256}]);
 if(state==='partial_period')expect(effectiveLegacySourcePeriods(f.scope,saved).periods).toEqual([]);
 expect(canonicalSha256(saved)).toBe(before);expect(saved.scopes[0].period_state).toBe('missing');expect(saved.scopes[0].topics).toHaveLength(9);
});
it.each(['unknown','unreadable'] as const)('keeps %s as its own identified result',action=>{
 const f=fixture({v:1,action});expect(sourceIntakeReadingCoverage(savedLegacySourceIntake(f.input),f.scope)).toMatchObject([{state:action,period:null,months:[]}]);
});
it('separates a missing printed period from a corrected source-kind software dependency',()=>{
 const seed=fixture();const absent=fixture({...seed.answer,value:{...seed.answer.value,period:null}});
 expect(sourceIntakeReadingCoverage(savedLegacySourceIntake(absent.input),absent.scope)[0].state).toBe('period_not_printed');
 const changed=fixture({...seed.answer,value:{...seed.answer.value,document_kind:'attendance'}});
 expect(sourceIntakeReadingCoverage(savedLegacySourceIntake(changed.input),changed.scope)[0]).toMatchObject({state:'kind_dispatch_required',kind:'attendance'});
});
it('does not expose a stale source reading as current coverage and refuses foreign scope',()=>{
 const f=fixture();f.journal.documents[0]={...f.document,version_id:'77777777-7777-4777-8777-777777777777'};f.input.currentDocuments=[f.journal.documents[0]];f.input.journalSha256=canonicalSha256(f.journal);
 const saved=savedLegacySourceIntake(f.input);expect(sourceIntakeReadingCoverage(saved,f.scope)).toMatchObject([{state:'reading_required',reading_sha256s:[]}]);
 expect(()=>sourceIntakeReadingCoverage(saved,{...f.scope,case_id:'88888888-8888-4888-8888-888888888888'})).toThrow('SOURCE_INTAKE_SCOPE');
});
it('retains conflicting observations instead of selecting a month',()=>{
 const f=fixture();f.journal.answers.push({...f.answerRow,id:'77777777-7777-4777-8777-777777777777',answer:JSON.stringify({...f.answer,value:{...f.answer.value,period:{from:'2026-07-01',to:'2026-07-31'}}})});f.input.journalSha256=canonicalSha256(f.journal);
 expect(sourceIntakeReadingCoverage(savedLegacySourceIntake(f.input),f.scope)[0]).toMatchObject({state:'conflict',period:null,months:[]});
});
