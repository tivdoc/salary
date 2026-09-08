import {expect,it,vi} from 'vitest';
import type {CaseAccessDb} from '../case-access/db';
vi.mock('server-only',()=>({}));
import {cancelCustomerUnstartedOrder} from './customer-cancellation';
const input={caseId:'11111111-1111-4111-8111-111111111111',identityId:'22222222-2222-4222-8222-222222222222',orderId:'33333333-3333-4333-8333-333333333333'};
function fake(rows:readonly unknown[]){const rpc=vi.fn().mockResolvedValue(rows);return {rpc,db:{provider:'fake',rpc} as CaseAccessDb};}
it('uses only the scoped RPC and accepts its exact replay receipt',async()=>{
 const receipt={order_id:input.orderId,state:'cancelled',replayed:true},f=fake([{value:receipt}]);
 expect(await cancelCustomerUnstartedOrder(input,f.db)).toEqual(receipt);
 expect(f.rpc).toHaveBeenCalledWith('case_order_cancel_unstarted',{target_case:input.caseId,target_identity:input.identityId,target_order:input.orderId});
});
it.each([{rows:[]},{rows:[{value:{order_id:input.caseId,state:'cancelled',replayed:false}}]},{rows:[{value:{order_id:input.orderId,state:'paid',replayed:false}}]},{rows:[{value:{order_id:input.orderId,state:'cancelled'}}]}])('does not claim cancellation from an absent or mismatched acknowledgement',async({rows})=>{
 await expect(cancelCustomerUnstartedOrder(input,fake(rows).db)).rejects.toThrow();
});
it('preserves the server reconciliation refusal instead of converting it into success',async()=>{
 const f=fake([]);f.rpc.mockRejectedValue(Error('ORDER_CANCEL_REQUIRES_RECONCILIATION'));
 await expect(cancelCustomerUnstartedOrder(input,f.db)).rejects.toThrow('ORDER_CANCEL_REQUIRES_RECONCILIATION');
});
