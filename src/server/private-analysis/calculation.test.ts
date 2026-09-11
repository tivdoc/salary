import {describe,it,expect} from 'vitest';
import {calculatePrivateDocumentArithmetic,replayPrivateDocumentArithmetic} from './calculation.ts';
import type {PrivateCalculationInput,PrivateCalculationOperand} from './calculation-contracts.ts';
// Invented arithmetic fixtures. No customer source values or identities.
const sha='a'.repeat(64);
function operand(id:string,printed_value:string,representation:PrivateCalculationOperand['representation']='money_ils',quantity_unit:PrivateCalculationOperand['quantity_unit']=null):PrivateCalculationOperand{
 return {id,printed_value,representation,quantity_unit,state:'observed',precision:'printed_precision',source:{document_id:'synthetic-payroll',version_id:'fixture-1',file_sha256:sha,page:1,
  locator:`row ${id}`,label:id,reading:'ai_document_review',reading_receipt_sha256:'b'.repeat(64),human_verified:false}};
}
function product():PrivateCalculationInput{return {schema_version:'private-document-arithmetic-input-v1',work_id:'test.case',check_id:'test.product',period:{from:'2025-02-01',to:'2025-02-28'},
 source_manifest:[{document_id:'synthetic-payroll',version_id:'fixture-1',file_sha256:sha,page_count:1}],
 operands:[operand('unit.rate','12.00'),operand('quantity','1.33','decimal_quantity','hours'),operand('recorded','16.00')],
 operation:{kind:'product',money_ref:'unit.rate',factor_refs:['quantity'],recorded_ref:'recorded',rounding:'half_up',rounding_basis:'Explicit arithmetic candidate; payroll rounding unverified'}};}
function reconciliation():PrivateCalculationInput{return {...product(),check_id:'test.net',operands:[operand('gross','120.00'),operand('tax','20.00'),operand('fund','5.00'),operand('recorded','95.00')],
 operation:{kind:'reconciliation',add_refs:['gross'],subtract_refs:['tax','fund'],recorded_ref:'recorded',inventory_complete:true,inventory_basis:'Complete invented deduction list'}};}
describe('private source-bound document arithmetic using the existing RuleSpec interpreter',()=>{
 it('keeps printed decimals and exact minute readings separate without selecting a successful method',()=>{
  const printed=calculatePrivateDocumentArithmetic(product());
  expect(printed.state).toBe('calculated');if(printed.state!=='calculated')return;
  expect(printed.expected).toEqual({kind:'money',currency:'ILS',minor_units:1596});
  expect(printed.difference).toEqual({kind:'money',currency:'ILS',minor_units:-4});
  const exact=product();exact.operands[1]=operand('quantity','1:20','hours_minutes','hours');exact.operands[1].precision='source_exact';
  const minutes=calculatePrivateDocumentArithmetic(exact);expect(minutes.state).toBe('calculated');if(minutes.state!=='calculated')return;
  expect(minutes.difference).toEqual({kind:'money',currency:'ILS',minor_units:0});
  expect(minutes.input.operands[1].printed_value).toBe('1:20');expect(printed.input.operands[1].printed_value).toBe('1.33');
  expect(minutes.result_sha256).not.toBe(printed.result_sha256);
 });
 it('multiplies a source percentage once with an explicit rounding method',()=>{
  const input=product();input.operands=[operand('unit.rate','10.01'),operand('quantity','2','decimal_quantity','hours'),operand('percentage','125','percent','ratio'),operand('recorded','25.03')];
  input.operation={kind:'product',money_ref:'unit.rate',factor_refs:['quantity','percentage'],recorded_ref:'recorded',rounding:'half_up',rounding_basis:'Synthetic independent half-agora example'};
  const result=calculatePrivateDocumentArithmetic(input);expect(result.state).toBe('calculated');if(result.state!=='calculated')return;
  expect(result.expected).toEqual({kind:'money',currency:'ILS',minor_units:2503});expect(result.execution.trace.filter(s=>s.operation==='money.scale')).toHaveLength(1);
  input.operation.rounding='half_even';expect(calculatePrivateDocumentArithmetic(input)).toMatchObject({difference:{minor_units:-1}});
  input.operation.rounding='exact';expect(()=>calculatePrivateDocumentArithmetic(input)).toThrow();
 });
 it('reconciles net without claiming legal entitlement, settlement or topic coverage',()=>{
  const result=calculatePrivateDocumentArithmetic(reconciliation());expect(result).toMatchObject({state:'calculated',difference:{minor_units:0},publication_allowed:false,pricing_allowed:false,topic_coverage_claim:false,legal_entitlement_assessed:false,human_attestation:null});
  expect(replayPrivateDocumentArithmetic(result)).toEqual(result);
 });
 it('preserves negative source rows in a complete gross sum',()=>{
  const input=reconciliation();input.operands=[operand('salary','100.00'),operand('correction','-3.50'),operand('recorded','96.50')];
  input.operation={kind:'reconciliation',add_refs:['salary','correction'],subtract_refs:[],recorded_ref:'recorded',inventory_complete:true,inventory_basis:'All synthetic cash rows'};
  expect(calculatePrivateDocumentArithmetic(input)).toMatchObject({expected:{minor_units:9650},difference:{minor_units:0}});
 });
 it('reconciles a balance in its original unit and rejects calendar/workday mixing',()=>{
  const input=reconciliation();input.operands=[operand('opening','8.5','decimal_quantity','days'),operand('accrued','1.5','decimal_quantity','days'),operand('used','2','decimal_quantity','days'),operand('recorded','8','decimal_quantity','days')];
  input.operation={kind:'reconciliation',add_refs:['opening','accrued'],subtract_refs:['used'],recorded_ref:'recorded',inventory_complete:true,inventory_basis:'One complete invented monthly ledger'};
  expect(calculatePrivateDocumentArithmetic(input)).toMatchObject({difference:{kind:'rational',numerator:'0',denominator:'1',unit:'days'}});
  input.operands[1].quantity_unit='calendar_days';expect(()=>calculatePrivateDocumentArithmetic(input)).toThrow();
 });
 it.each(['missing','conflicted','unreadable'] as const)('preserves %s rather than returning a numeric zero',state=>{
  const input=product();input.operands[1].state=state;input.operands[1].printed_value=null;
  expect(calculatePrivateDocumentArithmetic(input)).toMatchObject({state:'blocked',execution:null,blockers:[{operand_id:'quantity',state}]});
 });
 it('blocks incomplete row inventory',()=>{const input=reconciliation();if(input.operation.kind==='reconciliation')input.operation.inventory_complete=false;expect(calculatePrivateDocumentArithmetic(input)).toMatchObject({state:'blocked',execution:null});});
 it.each(['version','hash','page','duplicate','unreferenced','human'] as const)('rejects invalid source/input binding: %s',mutation=>{
  const input=product();
  if(mutation==='version')input.operands[0].source.version_id='other';
  if(mutation==='hash')input.operands[0].source.file_sha256='c'.repeat(64);
  if(mutation==='page')input.operands[0].source.page=2;
  if(mutation==='duplicate')input.operands[1].id=input.operands[0].id;
  if(mutation==='unreferenced')input.operands.push(operand('other','1.00'));
  if(mutation==='human')Object.assign(input.operands[0].source,{human_verified:true});
  expect(()=>calculatePrivateDocumentArithmetic(input)).toThrow();
 });
 it.each(['printed','trace','label','result'] as const)('rejects saved receipt tampering: %s',mutation=>{
  const result=JSON.parse(JSON.stringify(calculatePrivateDocumentArithmetic(product())));
  if(mutation==='printed')result.input.operands[1].printed_value='2';
  if(mutation==='trace')result.execution.trace[0].result.numerator='9';
  if(mutation==='label')result.input.operands[0].source.label='changed source label';
  if(mutation==='result')result.difference.minor_units=0;
  expect(()=>replayPrivateDocumentArithmetic(result)).toThrow('PRIVATE_ARITHMETIC_REPLAY_MISMATCH');
 });
 it('retains valid printed thousands separators and rejects ambiguous grouping or minute notation',()=>{
  const input=product();input.operands[1]=operand('quantity','1:75','hours_minutes','hours');expect(()=>calculatePrivateDocumentArithmetic(input)).toThrow('PRIVATE_ARITHMETIC_HOURS_MINUTES');
  input.operands[1]=operand('quantity','2','decimal_quantity','hours');input.operands[0].printed_value='1,000.00';
  expect(calculatePrivateDocumentArithmetic(input)).toMatchObject({input:{operands:[{printed_value:'1,000.00'},{printed_value:'2'},{printed_value:'16.00'}]},expected:{minor_units:200000}});
  input.operands[0].printed_value='10,00.00';expect(()=>calculatePrivateDocumentArithmetic(input)).toThrow('PRIVATE_ARITHMETIC_PRINTED_VALUE');
 });
});
