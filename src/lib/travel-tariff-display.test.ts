import {describe,it,expect} from 'vitest';
import {initialTravelTariffDraft,buildTravelTariffAnswer,displayTravelTariffAnswer,type TravelTariffContext} from './travel-tariff-display';
import {validateTravelTariffAnswer,travelTariffTarget,type TravelTariffDocument} from '@/engine/entitlement-review/travel/tariff-contracts';
const context:TravelTariffContext={subject:'daily_fare',page:2,locator:'Synthetic tariff section'};
const document:TravelTariffDocument={case_id:'11111111-1111-4111-8111-111111111111',document_id:'22222222-2222-4222-8222-222222222222',version_id:'33333333-3333-4333-8333-333333333333',file_sha256:'a'.repeat(64),page_count:2,month:'2026-06',document_type:'other',evidence_purpose:'travel_tariff',purpose_sha256:'b'.repeat(64)};
function draft(c=context){return {...initialTravelTariffDraft(c).draft,text:'Synthetic printed source basis'};}

describe('client-safe tariff source form values',()=>{
 it('starts without a price, period, route, discount, ticket status or inferred proposal',()=>{
  const initial=initialTravelTariffDraft(context);expect(initial.action).toBeNull();
  expect(initial.draft).toMatchObject({amount:'',from:'',to:'',directions:'',discount_profile:'',ticket_inventory:'',monthly_pass_availability:'',text:''});
  expect(buildTravelTariffAnswer(context,'correct',initial.draft)).toBeNull();expect(buildTravelTariffAnswer(context,'correct',draft())).toBeNull();
 });
 it.each(['0','0.00','9.50','999999999.99'])('retains an explicit valid money string %s through the server parser',amount=>{
  const answer=buildTravelTariffAnswer(context,'correct',{...draft(),amount});expect(answer).not.toBeNull();
  expect(validateTravelTariffAnswer(travelTariffTarget(document,{page:2,locator:context.locator},context.subject),answer)).toEqual(answer);
  expect(answer).toMatchObject({structured_value:{value:amount,basis:{page:2}}});
 });
 it.each(['','-1','+1','1e2','NaN','1.234','1000000000','01.00','9 ימים'])('does not submit invalid money %s',amount=>{
  expect(buildTravelTariffAnswer(context,'correct',{...draft(),amount})).toBeNull();
 });
 it.each(['unknown','unreadable'] as const)('saves %s without a hidden value, authority or source receipt',action=>{
  const answer=buildTravelTariffAnswer(context,action,{...draft(),amount:'9.50'});
  expect(answer).toEqual({schema_version:'document-field-answer-v3',action});
  expect(displayTravelTariffAnswer(JSON.stringify(answer),context)).not.toContain('9.50');
 });
 it('keeps the context factual, with strict actual dates and no automatic month substitution',()=>{
  const c={...context,subject:'context' as const},d={...draft(c),route_reference:'Synthetic route A',discount_profile:'special_discount',directions:'return',from:'2026-05-01',to:'2026-07-31'};
  const answer=buildTravelTariffAnswer(c,'correct',d);expect(answer).not.toBeNull();
  expect(validateTravelTariffAnswer(travelTariffTarget(document,{page:2,locator:context.locator},c.subject),answer)).toEqual(answer);
  for(const patch of [{from:'2026-02-30'},{from:'2026-08-01'},{to:''},{discount_profile:''},{directions:''},{route_reference:''}])
   expect(buildTravelTariffAnswer(c,'correct',{...d,...patch})).toBeNull();
 });
 it('requires explicit ticket inventory and availability, retaining partial rather than inventing a missing price',()=>{
  const c={...context,subject:'ticket_inventory' as const},d=draft(c);
  expect(buildTravelTariffAnswer(c,'correct',d)).toBeNull();
  expect(buildTravelTariffAnswer(c,'correct',{...d,ticket_inventory:'partial'})).toBeNull();
  const answer=buildTravelTariffAnswer(c,'correct',{...d,ticket_inventory:'partial',monthly_pass_availability:'available'});
  expect(answer).toMatchObject({structured_value:{value:{ticket_inventory:'partial',monthly_pass_availability:'available'}}});
  expect(validateTravelTariffAnswer(travelTariffTarget(document,{page:2,locator:context.locator},c.subject),answer)).toEqual(answer);
 });
 it('restores only the exact subject and page, and keeps correction content separate from source metadata',()=>{
  const answer=buildTravelTariffAnswer(context,'correct',{...draft(),amount:'9.50'}),saved=JSON.stringify(answer);
  const restored=initialTravelTariffDraft(context,saved);expect(restored).toMatchObject({action:'correct',draft:{amount:'9.50'}});
  expect(buildTravelTariffAnswer(context,restored.action,restored.draft)).toEqual(answer);
  for(const c of [{...context,page:1},{...context,subject:'monthly_pass_cost' as const}])expect(initialTravelTariffDraft(c,saved).action).toBeNull();
  expect(initialTravelTariffDraft(context,JSON.stringify({schema_version:'document-field-answer-v3',action:'confirm',structured_value:{kind:'travel_tariff'}})).action).toBeNull();
 });
 it('provides readable history without serializing internal IDs or claiming legal approval',()=>{
  const answer=buildTravelTariffAnswer(context,'correct',{...draft(),amount:'9.50'}),shown=displayTravelTariffAnswer(JSON.stringify(answer),context);
  expect(shown).toContain('9.50 ₪');expect(shown).toContain('אין בכך אישור זכאות');expect(shown).not.toContain('structured_value');
 });
});
