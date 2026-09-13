import {expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {openSavedDocumentFieldRequests} from '../processing/saved-field-requests';
import type {SourceJob} from '../processing/source-dispatch';
import {legacyFullOfferFixture} from '../orders/fixtures/legacy-offer';
import type {DocumentFieldTarget} from './document-field-confirmation';

type Head={revision:number;input_sha256:string};
type Transaction=<T>(db:pg.Client,run:(context:PostgresTransactionContext)=>Promise<T>)=>Promise<T>;

/** Only called inside the existing guarded synthetic DEV fixture. Orders are
 * synthetic paid inputs, never checkout evidence. Question writes are rolled
 * back; the caller later proves real concurrent commits and answer history. */
export async function proveDocumentFieldTopicScope(input:{owner:pg.Client;worker:pg.Client;web:pg.Client;
 caseId:string;orderId:string;checkpoint:unknown;salaryTarget:DocumentFieldTarget;pensionTarget:DocumentFieldTarget;
 head:()=>Promise<Head>;saved:()=>Promise<unknown>;transact:Transaction;
 open:(db:pg.Client,payload?:DocumentFieldTarget,scopeCase?:string)=>Promise<string>;checks:string[]}){
 const {owner,worker,web,caseId,orderId,checkpoint,salaryTarget,pensionTarget,head,saved,transact,open,checks}=input;
 const currentJob=async():Promise<SourceJob>=>{
  const selected=await head();
  return {schema_version:'saved-case-work-v1',case_id:caseId,revision:selected.revision,input_sha256:selected.input_sha256,mode:'draft'};
 };
 const generate=async(job?:SourceJob)=>{
  const selected=job??await currentJob();
  return transact(worker,context=>openSavedDocumentFieldRequests(context,selected,checkpoint));
 };
 const proveGeneration=async(fields:string[])=>{
  const job=await currentJob();
  await transact(worker,async context=>{
   await worker.query('savepoint topic_generated_questions');
   try{
    const first=await openSavedDocumentFieldRequests(context,job,checkpoint);
    const second=await openSavedDocumentFieldRequests(context,job,checkpoint);
    expect(second).toEqual(first);expect(new Set(first).size).toBe(first.length);
    const rows=(await worker.query('select field_crop from public.case_requests where id=any($1::uuid[]) order by field_crop',[first])).rows;
    expect(rows.map(row=>row.field_crop)).toEqual([...fields].sort());
   }finally{await worker.query('rollback to savepoint topic_generated_questions');}
  });
  expect((await owner.query('select count(*)::int n from private.document_field_targets where case_id=$1',[caseId])).rows[0].n).toBe(0);
 };
 const insertPensionOrder=async(month:string)=>{
  const id=randomUUID(),offer=legacyFullOfferFixture();
  await owner.query('begin');try{
   await owner.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version,state,verified_at) values($1,$2,'full',$3,$3,14900,'ILS',$4,$5,array['pension'],$6,'paid',now())",[id,caseId,month,offer,offer.sha256,offer.terms_version]);
   await owner.query("insert into private.order_entitlements(order_id,state) values($1,'active')",[id]);
   await owner.query('commit');
  }catch(error){await owner.query('rollback');throw error;}
  return id;
 };
 const capture=async()=>{await owner.query("select private.capture_case_input($1,'synthetic_purchased_topic_scope')",[caseId]);await saved();};

 await expect(web.query("select private.document_field_question_fields_v1(array['minimum_wage'])")).rejects.toMatchObject({code:'42501'});
 expect((await worker.query("select private.document_field_question_fields_v1(array['unknown']) invalid,private.document_field_question_fields_v1(array[]::text[]) empty,private.document_field_question_fields_v1(array['minimum_wage',null]) nullable")).rows[0]).toEqual({invalid:[],empty:[],nullable:[]});
 checks.push('actual web role cannot call worker policy; invalid, empty and null-containing topic lists authorize no fields');

 await expect(open(worker,pensionTarget)).rejects.toThrow('REQUEST_FIELD_UNPURCHASED_TOPIC');
 await proveGeneration(['base_monthly_salary']);
 checks.push('actual generator opens the necessary uncertain salary question and replay returns the same request; unpurchased pension is refused at the write boundary');

 await insertPensionOrder('2025-01-01');await capture();
 await expect(open(worker,pensionTarget)).rejects.toThrow('REQUEST_FIELD_UNPURCHASED_TOPIC');
 await proveGeneration(['base_monthly_salary']);
 checks.push('a pinned active January pension purchase cannot authorize a February pension question or suppress the purchased salary question');

 await owner.query("update private.order_entitlements set state='revoked' where order_id=$1",[orderId]);
 try{
  await expect(open(worker,salaryTarget)).rejects.toThrow('REQUEST_FIELD_UNPURCHASED_MONTH');
  await expect(generate()).rejects.toThrow('SAVED_ORDER_ENTITLEMENT_REQUIRED');
 }finally{await owner.query("update private.order_entitlements set state='active' where order_id=$1",[orderId]);}
 checks.push('revoking the only February entitlement blocks both direct opening and actual generation despite an active purchase in January');

 const priorJob=await currentJob(),pensionOrder=await insertPensionOrder('2025-02-01');
 await expect(open(worker,pensionTarget)).rejects.toThrow('REQUEST_FIELD_UNPURCHASED_TOPIC');
 await proveGeneration(['base_monthly_salary']);
 checks.push('a newly active February pension order absent from the exact saved revision cannot authorize a question');

 await capture();
 await expect(generate(priorJob)).rejects.toThrow('ANALYSIS_INPUT_SUPERSEDED');
 await proveGeneration(['base_monthly_salary','pension_base']);
 checks.push('after purchase capture and checkpoint binding the new revision generates salary and pension questions; the previous job revision is refused');

 await owner.query("update private.order_entitlements set state='suspended' where order_id=$1",[pensionOrder]);
 try{
  await expect(open(worker,pensionTarget)).rejects.toThrow('REQUEST_FIELD_UNPURCHASED_TOPIC');
  await expect(generate()).rejects.toThrow('SAVED_ORDER_ENTITLEMENT_REQUIRED');
 }finally{await owner.query("update private.order_entitlements set state='active' where order_id=$1",[pensionOrder]);}
 checks.push('suspending the exact pension entitlement cannot be substituted by the still-active salary purchase');

 await proveGeneration(['base_monthly_salary','pension_base']);
 checks.push('restoring the scoped entitlement again permits the necessary fields; rollback leaves no fixture questions before the separate concurrency and history proof');
}
