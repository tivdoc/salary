import {beforeEach,describe,it,expect,vi} from 'vitest';
const mock=vi.hoisted(()=>({cookie:vi.fn(),session:vi.fn(),cases:vi.fn(),create:vi.fn(),checkout:vi.fn(),rpc:vi.fn()}));
vi.mock('@/server/platform/capabilities/stable-http-entrypoint',()=>({guardStableHttpEntrypoint:vi.fn()}));
vi.mock('@/lib/case-cookie',()=>({readCaseIdFromCookie:mock.cookie}));
vi.mock('@/server/product/case-access/service',()=>({resolveIdentitySession:mock.session,listIdentityCases:mock.cases}));
vi.mock('@/server/product/case-access/session-cookie',()=>({readCaseSessionCookie:vi.fn()}));
vi.mock('@/server/product/orders/service',()=>({createOrder:mock.create,orderCheckout:mock.checkout}));
vi.mock('@/server/product/case-access/db',()=>({resolveCaseAccessDb:async()=>({rpc:mock.rpc})}));
import {POST} from './route';
const request=(body:unknown,origin='https://synthetic.invalid')=>new Request('https://synthetic.invalid/api/payments/start',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
beforeEach(()=>{vi.clearAllMocks();mock.cookie.mockResolvedValue(null);mock.session.mockResolvedValue({identity_id:'owner'});mock.cases.mockResolvedValue([{public_id:'TV-OWN00001',case_id:'owned'}]);});
describe('order HTTP scope',()=>{
 it('refuses cross-origin before reading a case',async()=>{expect((await POST(request({action:'quote'},'https://foreign.invalid'))).status).toBe(403);expect(mock.cookie).not.toHaveBeenCalled();});
 it('does not checkout an order through a foreign case',async()=>{expect((await POST(request({action:'checkout',publicId:'TV-OTHER001',orderId:'9c4c5752-d1c4-4e12-9e64-17b22b1c4330',termsAccepted:true}))).status).toBe(404);expect(mock.checkout).not.toHaveBeenCalled();});
 it('rejects client price injection',async()=>{expect((await POST(request({action:'quote',publicId:'TV-OWN00001',request:{kind:'full',from:'2026-01',to:'2026-02',amount:1}}))).status).toBe(400);expect(mock.create).not.toHaveBeenCalled();});
 it('derives the case and identity from the verified owner',async()=>{mock.create.mockResolvedValue({id:'saved'});expect((await POST(request({action:'quote',publicId:'TV-OWN00001',request:{kind:'full',from:'2026-01',to:'2026-02'}}))).status).toBe(200);expect(mock.create).toHaveBeenCalledWith({caseId:'owned',identityId:'owner',request:{kind:'full',from:'2026-01',to:'2026-02'}});});
});
