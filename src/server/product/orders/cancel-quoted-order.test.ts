import {it,expect,vi} from 'vitest';
import {cancelUnstartedQuotedOrder} from './cancel-quoted-order';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
vi.mock('server-only',()=>({}));
const input={caseId:'11111111-1111-4111-8111-111111111111',identityId:'22222222-2222-4222-8222-222222222222',orderId:'33333333-3333-4333-8333-333333333333',reason:'source_changed' as const};
function store(value:unknown){const query=vi.fn<PostgresTransactionContext['client']['query']>(async()=>({rows:[{value}],row_count:1}));return {query,context:{transaction_id:'synthetic-only',client:{query}} as PostgresTransactionContext};}
it('submits scope and reason together to one atomic call',async()=>{
 const value={order_id:input.orderId,state:'cancelled',replayed:false},s=store(value);expect(await cancelUnstartedQuotedOrder(s.context,input)).toEqual(value);
 expect(s.query).toHaveBeenCalledOnce();expect(s.query.mock.calls[0][0].values).toEqual([input.caseId,input.identityId,input.orderId,input.reason]);
});
it('does not allow a caller to declare provider failure as a safe cancellation reason',async()=>{
 const s=store(null);await expect(cancelUnstartedQuotedOrder(s.context,{...input,reason:'provider_timeout'} as unknown as typeof input)).rejects.toThrow();expect(s.query).not.toHaveBeenCalled();
});
it('refuses an absent acknowledgement or a different order response',async()=>{
 for(const value of [null,{order_id:input.caseId,state:'cancelled',replayed:false}]){const s=store(value);await expect(cancelUnstartedQuotedOrder(s.context,input)).rejects.toThrow();}
});
