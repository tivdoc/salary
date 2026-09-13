import {writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {canonicalSha256} from '../../src/engine/rule-runtime/canonical';
import {reportDocumentSchema} from '../../src/server/product/reports/report-document';
import {ALL_AWAITING_VERIFICATION,S05_LOW_CERTAINTY_DIRECTION,S06_REFUSED_FOR_APPLICABILITY} from '../../src/server/product/reports/case-report-projection.fixtures';
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const source='מסמך הדגמה סינתטי בלבד — אינו תלוש של לקוח\nתקופה: יוני 2026\nרכיב פנסיה: מופיע במסמך ההדגמה\nקרן פנסיה פעילה בתחילת ההעסקה: לא נמסר\nסידור עבודה רגיל: לא נמסר\n';
const hash=createHash('sha256').update(source).digest('hex');
const reports=['initial','full'].map((kind,i)=>{
 const p=structuredClone(ALL_AWAITING_VERIFICATION);p.report_kind=kind as 'initial'|'full';p.case_public_id='TV-DEMO0001';
 p.topics=p.topics.map(t=>t.topic==='pension'?{...structuredClone(S05_LOW_CERTAINTY_DIRECTION),missing_facts:['אישור על קרן פנסיה פעילה בתחילת ההעסקה'],branches_examined:['נתוני הדגמה סינתטיים בלבד'],parameter_grades:{'synthetic-pension-v1':'active'}}:t.topic==='working_time'?{...structuredClone(S06_REFUSED_FOR_APPLICABILITY),assumptions:[],branches_examined:[],parameter_grades:{'synthetic-schedule-v1':'active'}}:t);
 const doc=reportDocumentSchema.parse({schema_version:'tivdoc-report-document-v3',service_kind:'ai_assisted',publication_policy:'tivdoc-ai-publication-v1',order_offer_sha256:hash,id:id(10+i),case_id:id(1),order_id:id(2+i),revision:1,input_sha256:hash,projection_sha256:canonicalSha256(p),purchased_period:{from:'2026-06',to:'2026-06'},projection:p,evidence:[{id:id(20),document_id:id(21),version_id:id(22),sha256:hash,page:1,field:'רכיב פנסיה ומידע חסר בתחילת העסקה',fact_version:'synthetic-1'}],findings:[{id:id(30),topic:'pension',evidence_ids:[id(20)],rule_versions:['synthetic-pension-rule-v1'],parameter_versions:['synthetic-pension-v1']}],publication:{state:'draft',approved_input_sha256:null,approval_actor_kind:'automation',published_at:null},correction_policy:'append_new_revision_preserve_published'});
 return doc;
});
writeFileSync('src/content/report-samples.json',JSON.stringify({label:'נתוני הדגמה סינתטיים בלבד',source,sourceSha256:hash,reports},null,2)+'\n');
console.log('Validated two draft examples with the real v3 report contract; no publication or database write.');
