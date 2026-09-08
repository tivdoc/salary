import {beforeEach,describe,it,expect,vi} from 'vitest';
const mock=vi.hoisted(()=>({cookie:vi.fn(),session:vi.fn(),cases:vi.fn(),create:vi.fn(),checkout:vi.fn(),rpc:vi.fn(),cancel:vi.fn()}));
vi.mock('@/server/platform/capabilities/stable-http-entrypoint',()=>({guardStableHttpEntrypoint:vi.fn()}));
vi.mock('@/lib/case-cookie',()=>({readCaseIdFromCookie:mock.cookie}));
vi.mock('@/server/product/case-access/service',()=>({resolveIdentitySession:mock.session,listIdentityCases:mock.cases}));
vi.mock('@/server/product/case-access/session-cookie',()=>({readCaseSessionCookie:vi.fn()}));
vi.mock('@/server/product/orders/service',()=>({createOrder:mock.create,orderCheckout:mock.checkout}));
vi.mock('@/server/product/orders/customer-cancellation',()=>({cancelCustomerUnstartedOrder:mock.cancel}));
vi.mock('@/server/product/case-access/db',()=>({resolveCaseAccessDb:async()=>({rpc:mock.rpc})}));
import {POST} from './route';
const request=(body:unknown,origin='https://synthetic.invalid')=>new Request('https://synthetic.invalid/api/payments/start',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
beforeEach(()=>{vi.clearAllMocks();mock.cookie.mockResolvedValue(null);mock.session.mockResolvedValue({identity_id:'owner'});mock.cases.mockResolvedValue([{public_id:'TV-OWN00001',case_id:'owned'}]);});
describe('order HTTP scope',()=>{
 it('binds customer cancellation to the authenticated case and stable order and returns only a confirmed receipt',async()=>{
  const orderId='9c4c5752-d1c4-4e12-9e64-17b22b1c4330';
  mock.cancel.mockResolvedValue({order_id:orderId,state:'cancelled',replayed:true});
  const response=await POST(request({action:'cancel_unstarted',publicId:'TV-OWN00001',orderId}));
  expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toContain('no-store');
  expect(mock.cancel).toHaveBeenCalledWith({caseId:'owned',identityId:'owner',orderId});
  expect(await response.json()).toEqual({cancellation:{order_id:orderId,state:'cancelled',replayed:true}});
  expect(mock.checkout).not.toHaveBeenCalled();expect(mock.create).not.toHaveBeenCalled();
 });
 it.each(['foreign_case','no_session','origin','identity_injection','missing_public_id'] as const)('refuses cancellation with %s before its mutation',async defect=>{
  const body:Record<string,unknown>={action:'cancel_unstarted',publicId:defect==='foreign_case'?'TV-OTHER001':'TV-OWN00001',orderId:'9c4c5752-d1c4-4e12-9e64-17b22b1c4330'};
  if(defect==='no_session')mock.session.mockResolvedValue(null);
  if(defect==='identity_injection')body.identityId='attacker';
  if(defect==='missing_public_id')delete body.publicId;
  const response=await POST(request(body,defect==='origin'?'https://foreign.invalid':'https://synthetic.invalid'));
  expect(response.status).toBe(defect==='origin'?403:defect==='identity_injection'||defect==='missing_public_id'?400:404);
  expect(mock.cancel).not.toHaveBeenCalled();
 });
 it.each([['ORDER_FORBIDDEN',404,null],['ORDER_CANCEL_REQUIRES_RECONCILIATION',409,'cancellation_requires_reconciliation'],['connection_lost',503,'cancellation_unconfirmed']] as const)('handles cancellation refusal %s without claiming completion',async(message,status,code)=>{
  mock.cancel.mockRejectedValue(Error(message));
  const response=await POST(request({action:'cancel_unstarted',publicId:'TV-OWN00001',orderId:'9c4c5752-d1c4-4e12-9e64-17b22b1c4330'}));
  expect(response.status).toBe(status);if(code)expect(await response.json()).toMatchObject({code});
  expect(mock.checkout).not.toHaveBeenCalled();
 });
 it('refuses cross-origin before reading a case',async()=>{expect((await POST(request({action:'quote'},'https://foreign.invalid'))).status).toBe(403);expect(mock.cookie).not.toHaveBeenCalled();});
 it('does not checkout an order through a foreign case',async()=>{expect((await POST(request({action:'checkout',publicId:'TV-OTHER001',orderId:'9c4c5752-d1c4-4e12-9e64-17b22b1c4330',termsAccepted:true}))).status).toBe(404);expect(mock.checkout).not.toHaveBeenCalled();});
 it('rejects client price injection',async()=>{expect((await POST(request({action:'quote',publicId:'TV-OWN00001',request:{kind:'full',from:'2026-01',to:'2026-02',amount:1}}))).status).toBe(400);expect(mock.create).not.toHaveBeenCalled();});
 it('derives the case and identity from the verified owner',async()=>{mock.create.mockResolvedValue({id:'saved'});expect((await POST(request({action:'quote',publicId:'TV-OWN00001',request:{kind:'full',from:'2026-01',to:'2026-02'}}))).status).toBe(200);expect(mock.create).toHaveBeenCalledWith({caseId:'owned',identityId:'owner',request:{kind:'full',from:'2026-01',to:'2026-02'}});});
});
