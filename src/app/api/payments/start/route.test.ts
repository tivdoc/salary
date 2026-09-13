import {beforeEach,describe,it,expect,vi} from 'vitest';
const mock=vi.hoisted(()=>({cookie:vi.fn(),sessionCookie:vi.fn(),session:vi.fn(),cases:vi.fn(),create:vi.fn(),quote:vi.fn(),savedQuote:vi.fn(),checkout:vi.fn(),rpc:vi.fn(),cancel:vi.fn()}));
vi.mock('@/server/platform/capabilities/stable-http-entrypoint',()=>({guardStableHttpEntrypoint:vi.fn()}));
vi.mock('@/lib/case-cookie',()=>({readCaseIdFromCookie:mock.cookie}));
vi.mock('@/server/product/case-access/service',()=>({resolveIdentitySession:mock.session,listIdentityCases:mock.cases}));
vi.mock('@/server/product/case-access/session-cookie',()=>({readCaseSessionCookie:mock.sessionCookie}));
vi.mock('@/server/product/orders/service',()=>({createReleaseInitialOrder:mock.create,customerReleaseQuote:mock.quote,customerSavedReleaseQuote:mock.savedQuote,orderCheckout:mock.checkout}));
vi.mock('@/server/product/orders/customer-cancellation',()=>({cancelCustomerUnstartedOrder:mock.cancel}));
vi.mock('@/server/product/case-access/db',()=>({resolveCaseAccessDb:async()=>({rpc:mock.rpc})}));
import {POST} from './route';
const request=(body:unknown,origin='https://synthetic.invalid')=>new Request('https://synthetic.invalid/api/payments/start',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
beforeEach(()=>{vi.clearAllMocks();mock.sessionCookie.mockResolvedValue("A".repeat(22));mock.cookie.mockResolvedValue(null);mock.session.mockResolvedValue({identity_id:'owner'});mock.cases.mockResolvedValue([{public_id:'TV-OWN00001',case_id:'owned'}]);});
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
 it('reads an actual saved full quote using only the verified owner scope',async()=>{
  mock.quote.mockResolvedValue({quote:{id:'saved'},order:null});
  const response=await POST(request({action:'quote',publicId:'TV-OWN00001',request:{kind:'full',from:'2026-05',to:'2026-07'}}));
  expect(response.status).toBe(200);expect(await response.json()).toEqual({quote:{id:'saved'},order:null});
  expect(mock.quote).toHaveBeenCalledWith({caseId:'owned',identityId:'owner',request:{kind:'full',from:'2026-05',to:'2026-07'},sessionToken:'A'.repeat(22)});expect(mock.create).not.toHaveBeenCalled();expect(mock.checkout).not.toHaveBeenCalled();
 });
 it('derives a new initial offer period from the funnel while preserving historical paid redirects',async()=>{
  mock.cookie.mockResolvedValue('owned');mock.rpc.mockResolvedValue([{value:{check_period_month:'2026-06-01',payment_status:'unpaid',legacy_payment:false}}]);mock.create.mockResolvedValue({id:'new-initial'});
  expect((await POST(request({action:'quote'}))).status).toBe(200);
  expect(mock.create).toHaveBeenCalledExactlyOnceWith({caseId:'owned',identityId:null,request:{kind:'initial',from:'2026-06',to:'2026-06'}});expect(mock.checkout).not.toHaveBeenCalled();
  mock.create.mockClear();mock.rpc.mockResolvedValue([{value:{check_period_month:'2026-06-01',payment_status:'verified',legacy_payment:true}}]);
  expect(await (await POST(request({action:'quote'}))).json()).toEqual({url:'/check/received'});expect(mock.create).not.toHaveBeenCalled();
 });
 it('returns the precise missing saved-pricing-basis refusal without opening an order or checkout',async()=>{
  mock.quote.mockRejectedValueOnce(Error('ORDER_PRICING_BASIS_UNAVAILABLE'));
  const response=await POST(request({action:'quote',publicId:'TV-OWN00001',request:{kind:'full',from:'2026-06',to:'2026-06'}}));
  expect(response.status).toBe(409);expect(await response.json()).toMatchObject({code:'pricing_basis_unavailable'});expect(mock.create).not.toHaveBeenCalled();expect(mock.checkout).not.toHaveBeenCalled();
 });
 it.each(['foreign','anonymous','injected_topics','injected_basis'])('rejects %s full-quote requests before its reader',async defect=>{
  const body:Record<string,unknown>={action:'quote',publicId:defect==='foreign'?'TV-OTHER001':'TV-OWN00001',request:{kind:'full',from:'2026-06',to:'2026-06'}};
  if(defect==='anonymous'){delete body.publicId;mock.cookie.mockResolvedValue('owned');}
  if(defect==='injected_topics')body.topics=['contract'];if(defect==='injected_basis')body.basis_minor=50000;
  const response=await POST(request(body));expect(response.status).toBe(defect.startsWith('injected')?400:404);expect(mock.quote).not.toHaveBeenCalled();
 });
});

describe('saved-offer discovery',()=>{
 it('reads the saved period from the verified case without accepting caller months or creating payment',async()=>{
  const saved={quote:{id:'saved',from:'2026-05',to:'2026-07'},order:null,availability:{state:'ready',period:{from:'2026-05',to:'2026-07'}}};
  mock.savedQuote.mockResolvedValue(saved);
  const response=await POST(request({action:'saved_quote',publicId:'TV-OWN00001'}));
  expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toContain('no-store');expect(await response.json()).toEqual(saved);
  expect(mock.savedQuote).toHaveBeenCalledExactlyOnceWith({caseId:'owned',identityId:'owner',sessionToken:'A'.repeat(22)});expect(mock.session).toHaveBeenCalledWith('A'.repeat(22));expect(mock.sessionCookie).toHaveBeenCalledOnce();expect(mock.quote).not.toHaveBeenCalled();expect(mock.create).not.toHaveBeenCalled();expect(mock.checkout).not.toHaveBeenCalled();
 });
 it('returns explicit unavailable status while keeping the saved result unchanged',async()=>{
  const status={quote:null,order:null,availability:{state:'needs_information',period:{from:'2026-05',to:'2026-07'}}};mock.savedQuote.mockResolvedValue(status);
  const response=await POST(request({action:'saved_quote',publicId:'TV-OWN00001'}));
  expect(response.status).toBe(200);expect(await response.json()).toEqual(status);expect(mock.create).not.toHaveBeenCalled();expect(mock.checkout).not.toHaveBeenCalled();
 });
 it.each(['foreign','anonymous','months','price','origin'] as const)('rejects %s saved-offer discovery before the authenticated reader',async defect=>{
  const body:Record<string,unknown>={action:'saved_quote',publicId:defect==='foreign'?'TV-OTHER001':'TV-OWN00001'};
  if(defect==='anonymous')delete body.publicId;if(defect==='months')body.request={kind:'full',from:'2026-01',to:'2026-02'};if(defect==='price')body.amount_minor=1;
  const response=await POST(request(body,defect==='origin'?'https://foreign.invalid':'https://synthetic.invalid'));
  expect(response.status).toBe(defect==='foreign'?404:defect==='origin'?403:400);expect(mock.savedQuote).not.toHaveBeenCalled();expect(mock.create).not.toHaveBeenCalled();expect(mock.checkout).not.toHaveBeenCalled();
 });
 it('explains a mismatched exact period without silently substituting a different quote',async()=>{
  mock.quote.mockRejectedValue(Error('ORDER_QUOTE_PERIOD_UNAVAILABLE'));
  const response=await POST(request({action:'quote',publicId:'TV-OWN00001',request:{kind:'full',from:'2026-01',to:'2026-02'}}));
  expect(response.status).toBe(409);expect(await response.json()).toMatchObject({code:'period_unavailable',error:expect.stringContaining('אין הצעה שמורה לתקופה שביקשתם')});
  expect(mock.savedQuote).not.toHaveBeenCalled();expect(mock.create).not.toHaveBeenCalled();expect(mock.checkout).not.toHaveBeenCalled();
 });
});

it('refuses saved-offer lookup when the actual session cookie is absent',async()=>{
 mock.sessionCookie.mockResolvedValue(null);mock.session.mockResolvedValue(null);
 const response=await POST(request({action:'saved_quote',publicId:'TV-OWN00001'}));
 expect(response.status).toBe(404);expect(mock.savedQuote).not.toHaveBeenCalled();
});
it('rejects caller-provided saved-offer session tokens before reading identity',async()=>{
 const response=await POST(request({action:'saved_quote',publicId:'TV-OWN00001',sessionToken:'attacker'}));
 expect(response.status).toBe(400);expect(mock.sessionCookie).not.toHaveBeenCalled();expect(mock.savedQuote).not.toHaveBeenCalled();
});
