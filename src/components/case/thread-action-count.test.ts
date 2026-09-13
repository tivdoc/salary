import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
import {ThreadView} from './thread-view';
import type {StoredRequest} from '@/server/product/reports/case-requests';
import type {SourceStructureContext} from '@/lib/source-structure-display';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
const renderedAt=Date.parse('2026-09-12T00:00:00Z');
function row(index:number,context:SourceStructureContext):StoredRequest{
 return {id:`11111111-1111-4111-8111-${String(index).padStart(12,'0')}`,case_id:'22222222-2222-4222-8222-222222222222',code:'document_field:'+index.toString(16).repeat(64),
  question:'Synthetic source decision',answer_kind:'text',blocking:false,field_crop:null,opened_at:'2026-09-11T00:00:00Z',expires_at:'2026-10-01T00:00:00Z',answered_at:null,answer_text:null,source_current:true,
  reading_display:{question:'Synthetic source decision',field:'source_structure.'+context.kind,raw_value:null,page:1,text_fragment:null,bounding_box:null,structure_context:context}};
}
function eightDecisions(){
 const relation=(component_kind:'pension_employee'|'pension_employer'):SourceStructureContext=>({kind:'source_relationship',component_kind,allows_explicit_confirmation:true,
  contribution:{label:'Synthetic contribution',raw_value:'60.00'},base:{label:'Synthetic base',raw_value:'1000.00'},proposed_value:null});
 return [row(1,relation('pension_employee')),row(2,relation('pension_employer')),
  row(3,{kind:'deduction_group',rows:[{component_id:'33333333-3333-4333-8333-333333333333',label:'Synthetic deduction',raw_value:'20.00'}],allows_voluntary:false,proposed_value:null}),
  ...(['opening','accrued','used','adjustments','closing']as const).map((cell,i)=>row(i+4,{kind:'balance_movement',group_id:'a'.repeat(64),label:'Synthetic balance',cell,proposed_value:null}))];
}
const render=(requests:readonly StoredRequest[])=>renderToStaticMarkup(createElement(ThreadView,{publicId:'TV-SYNTH001',requests,renderedAt}));
it('always counts all eight independent source decisions, including five cells in one visual group',()=>{
 const html=render(eightDecisions());expect(html).toContain('8 פעולות נדרשות כעת');expect(html).not.toContain('שאלות נשמרו ואינן נדרשות');
 expect(html.match(/aria-label="תוצאת בדיקת המקור"/g)).toHaveLength(8);
});
it('keeps the count visible after answers when the current projection no longer defers old questions',()=>{
 const rows=eightDecisions(),answered=rows.slice(0,3).map(r=>({...r,answered_at:'2026-09-11T23:00:00Z',answer_text:JSON.stringify({schema_version:'document-field-answer-v3',action:'unknown'})}));
 const old={...rows[0],id:'44444444-4444-4444-8444-444444444444',code:'synthetic.old.question',reading_display:undefined};
 const html=render([...answered,...rows.slice(3),old]);expect(html).toContain('6 פעולות נדרשות כעת');expect(html).toContain('הרשימה עשויה להתעדכן');
 expect(html).toContain('שמירת תשובה אינה קובעת שהבדיקה הושלמה');expect(html).not.toContain('שאלות נשמרו ואינן נדרשות');
 expect(html).toContain('מה כבר עניתם');expect(html).toContain('שליחת תשובה');
});
it('excludes answered, deferred, covered, stale and expired requests without hiding the zero count',()=>{
 const rows=eightDecisions(),requests:StoredRequest[]=[{...rows[0],answered_at:'2026-09-11T23:00:00Z',answer_text:JSON.stringify({schema_version:'document-field-answer-v3',action:'unknown'})},
  {...rows[1],not_required_for_current_review:true},{...rows[2],covered_by_field_request_id:rows[0].id},
  {...rows[3],source_current:false},{...rows[4],expires_at:'2026-09-11T00:00:00Z'}];
 const html=render(requests);expect(html).toContain('0 פעולות נדרשות כעת');expect(html).toContain('1 שאלות נשמרו ואינן נדרשות');
 expect(html).toContain('אין כרגע שאלות פתוחות');expect(html).not.toContain('הרשימה עשויה להתעדכן');
 expect(render([])).toContain('0 פעולות נדרשות כעת');
});

it('counts each source decision while excluding only the fully covered generic question',()=>{
 const fields=eightDecisions().slice(0,2),question={...fields[0],id:'55555555-5555-4555-8555-555555555555',
  code:'document_review:'+'e'.repeat(64),reading_display:undefined,covered_by_field_request_ids:fields.map(r=>r.id)};
 const html=render([...fields,question]);expect(html).toContain('2 פעולות נדרשות כעת');
 expect(html.match(/aria-label="תוצאת בדיקת המקור"/g)).toHaveLength(2);
 for(const field of fields)expect(html).toContain(`href="#request-${field.id}"`);
 expect(render([...fields,{...question,covered_by_field_request_ids:[]}])).toContain('3 פעולות נדרשות כעת');
});
