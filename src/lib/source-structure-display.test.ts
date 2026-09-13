import {expect,it} from 'vitest';
import {buildSourceStructureAnswer,initialSourceStructureDraft,displaySourceStructureAnswer,type SourceStructureContext} from './source-structure-display';
const basis={page:1,locator:'טבלה סינתטית',text:'כותרת וגבולות הקבוצה במקור'};
const relationship:SourceStructureContext={kind:'source_relationship',component_kind:'pension_employee',contribution:{label:'הפרשה',raw_value:'60.00'},base:{label:'בסיס',raw_value:'1000.00'},proposed_value:null};
const groups:SourceStructureContext={kind:'deduction_group',rows:[{component_id:'11111111-1111-4111-8111-111111111111',label:'ניכוי',raw_value:'20.00'},
 {component_id:'22222222-2222-4222-8222-222222222222',label:'ניכוי',raw_value:'20.00'}],proposed_value:null};
const balance:SourceStructureContext={kind:'balance_movement',group_id:'a'.repeat(64),label:'חופשה',cell:'opening',proposed_value:null};
const draftFor=(context:SourceStructureContext)=>({...initialSourceStructureDraft(context).draft,page:String(basis.page),locator:basis.locator,text:basis.text,
 fund_kind:'pension' as const,source_kind:'same_row' as const,fund_label:'קרן סינתטית'});
it.each([relationship,groups,balance])('never confirms a missing proposed source value: $kind',context=>{
 const initial=initialSourceStructureDraft(context);expect(initial.action).toBeNull();expect(buildSourceStructureAnswer(context,'confirm',initial.draft)).toBeNull();
 for(const action of ['unknown','unreadable']as const)expect(buildSourceStructureAnswer(context,action,initial.draft)).toEqual({schema_version:'document-field-answer-v3',action});
});
it('keeps contribution type fixed and records a relationship without retransmitting amounts',()=>{
 const answer=buildSourceStructureAnswer(relationship,'correct',{...draftFor(relationship),relationship:'different_base'});
 expect(answer).toEqual({schema_version:'document-field-answer-v3',action:'correct',structured_value:{kind:'source_relationship',component_kind:'pension_employee',relationship:'different_base',fund_kind:'pension',source_kind:'same_row',fund_label:'קרן סינתטית',basis}});
 expect(JSON.stringify(answer)).not.toContain('1000');expect(JSON.stringify(answer)).not.toContain('60.00');
 expect(buildSourceStructureAnswer(relationship,'correct',{...draftFor(relationship),relationship:'same_base',text:''})).toBeNull();
});
it('requires fund identity and source basis for explicit relationship confirmation even without a proposed value',()=>{
 const context={...relationship,allows_explicit_confirmation:true},initial=initialSourceStructureDraft(context);
 expect(buildSourceStructureAnswer(context,'confirm',initial.draft)).toBeNull();expect(initial.draft.fund_kind).toBe('');
 const draft=draftFor(context),answer=buildSourceStructureAnswer(context,'confirm',draft);
 expect(answer).toMatchObject({action:'confirm',structured_value:{relationship:'same_base',fund_kind:'pension',source_kind:'same_row',fund_label:'קרן סינתטית'}});
 for(const field of ['fund_label','source_kind','fund_kind','text']as const)expect(buildSourceStructureAnswer(context,'confirm',{...draft,[field]:''})).toBeNull();
 expect(initialSourceStructureDraft(context,JSON.stringify(answer))).toMatchObject({action:'confirm',draft:{fund_kind:'pension',source_kind:'same_row'}});
 expect(displaySourceStructureAnswer(JSON.stringify(answer),context)).toContain('נשמר אישור מפורש לקשר');
});
it('requires every distinct row and explicit inventory despite identical labels and amounts',()=>{
 const draft=draftFor(groups);expect(draft.members).toEqual(Object.fromEntries(groups.rows.map(r=>[r.component_id,''])));
 draft.members[groups.rows[0].component_id]='mandatory';draft.inventory='complete';expect(buildSourceStructureAnswer(groups,'correct',draft)).toBeNull();
 draft.members[groups.rows[1].component_id]='unknown';draft.inventory='partial';
 expect(buildSourceStructureAnswer(groups,'correct',draft)).toMatchObject({structured_value:{inventory:'partial',members:[{component_id:groups.rows[0].component_id,group:'mandatory'},{component_id:groups.rows[1].component_id,group:'unknown'}]}});
 draft.inventory='complete';expect(buildSourceStructureAnswer(groups,'correct',draft)).toBeNull();draft.inventory='partial';
 draft.members[groups.rows[1].component_id]='voluntary';expect(buildSourceStructureAnswer(groups,'correct',draft)).toBeNull();
 expect(buildSourceStructureAnswer({...groups,allows_voluntary:true},'correct',draft)).not.toBeNull();
 const duplicate={...groups,rows:[groups.rows[0],groups.rows[0]]};expect(buildSourceStructureAnswer(duplicate,'correct',draft)).toBeNull();
});
it('requires the balance amount, explicit unit and period; absence never becomes zero',()=>{
 const draft=draftFor(balance);expect(draft).toMatchObject({amount:'',unit:'',period:'',not_present:false});
 draft.amount='0';draft.period='2026-07';expect(buildSourceStructureAnswer(balance,'correct',draft)).toBeNull();
 draft.unit='source_native_unknown';const answer=buildSourceStructureAnswer(balance,'correct',draft);
 expect(answer).toMatchObject({structured_value:{state:'value',amount:'0',unit:'source_native_unknown',period:'2026-07'}});
 expect(displaySourceStructureAnswer(JSON.stringify(answer),balance)).toContain('ביחידה שאינה מודפסת במקור');
 draft.amount='';expect(buildSourceStructureAnswer(balance,'correct',draft)).toBeNull();
 draft.not_present=true;expect(buildSourceStructureAnswer(balance,'correct',draft)).toBeNull();
 expect(buildSourceStructureAnswer({...balance,cell:'adjustments'},'correct',draft)).toMatchObject({structured_value:{state:'not_present',period:'2026-07'}});
});
it('retains a valid proposed value and correction draft without converting a historic v2 answer',()=>{
 const context={...balance,proposed_value:{kind:'balance_movement' as const,state:'value' as const,amount:'3.5',unit:'hours' as const,period:'2026-07',basis}};
 expect(initialSourceStructureDraft(context).draft).toMatchObject({amount:'3.5',unit:'hours',period:'2026-07'});
 expect(buildSourceStructureAnswer(context,'confirm',initialSourceStructureDraft(context).draft)).toBeNull();
 const corrected=buildSourceStructureAnswer(context,'correct',{...draftFor(context),amount:'4',unit:'days',period:'2026-08'});
 expect(initialSourceStructureDraft(context,JSON.stringify(corrected))).toMatchObject({action:'correct',draft:{amount:'4',unit:'days',period:'2026-08'}});
 expect(initialSourceStructureDraft(balance,JSON.stringify({schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:'9'})).draft.amount).toBe('');
});
