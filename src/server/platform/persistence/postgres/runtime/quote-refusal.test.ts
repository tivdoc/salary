import {expect,it} from 'vitest';
import {mapPostgresFailure} from './errors';
it.each(['PRICE_QUOTE_EXPIRED','PRICE_QUOTE_CREDIT_UNAVAILABLE','PRICE_QUOTE_EXISTING_ORDER_REQUIRES_RECONCILIATION','ORDER_COVERAGE_UNAVAILABLE'])(
 'preserves only the exact expected P0001 quote refusal %s as a typed code',message=>{
  const error=mapPostgresFailure(Object.assign(Error(message),{code:'P0001'}),'POSTGRES_STATEMENT_FAILED');
  expect(error.message).toBe('POSTGRES_STATEMENT_FAILED');expect(error.domain_code).toBe(message);expect(error.sqlstate).toBe('P0001');
 });
it.each([
 ['P0001','PRICE_QUOTE_EXPIRED private details'],['P0001','REAL_SERVICE_FORBIDDEN'],['23505','PRICE_QUOTE_EXPIRED'],['XX000','ORDER_COVERAGE_UNAVAILABLE'],
])('does not preserve database message for %s / %s',(code,message)=>{
 const error=mapPostgresFailure(Object.assign(Error(message),{code}),'POSTGRES_STATEMENT_FAILED');expect(error.domain_code).toBeNull();expect(error.message).toBe('POSTGRES_STATEMENT_FAILED');
});
