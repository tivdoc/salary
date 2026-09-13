import {beforeEach,describe,expect,it,vi} from 'vitest';
import {runManagedDevIteration,readManagedDevOperations} from './managed-worker-iteration';
const ports=vi.hoisted(()=>({tick:vi.fn(),notifications:vi.fn(),health:vi.fn(),status:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('./managed-worker-host',()=>({runManagedDevTick:ports.tick,readManagedDevHealth:ports.health,readManagedDevStatus:ports.status}));
vi.mock('./automatic-dev-notifications',()=>({runManagedDevNotificationTick:ports.notifications}));
beforeEach(()=>{vi.resetAllMocks();ports.tick.mockResolvedValue({worker:'managed_dev',state:'finished',items:[]});ports.notifications.mockResolvedValue({state:'finished',attempts:[],deliveryConfirmed:false});ports.health.mockResolvedValue({checked_at:'2026-09-11T00:40:00Z'});ports.status.mockResolvedValue([]);});
const run=(signal=new AbortController().signal)=>runManagedDevIteration({},'a'.repeat(40),vi.fn(),signal);
describe('bounded managed iteration',()=>{
 it('keeps notifications and DB health observable while the OCR budget is blocked',async()=>{
  ports.tick.mockResolvedValue({state:'blocked',code:'provider_budget_locked',items:[]});
  expect(await run()).toMatchObject({state:'blocked',code:'provider_budget_locked',notifications:{state:'finished'},health:{state:'available'}});
  expect(ports.tick.mock.invocationCallOrder[0]).toBeLessThan(ports.notifications.mock.invocationCallOrder[0]);expect(ports.notifications.mock.invocationCallOrder[0]).toBeLessThan(ports.health.mock.invocationCallOrder[0]);
 });
 it('records safe independent phase failures without losing the completed worker receipt',async()=>{
  ports.tick.mockResolvedValue({state:'finished',items:[{caseId:'synthetic',state:'succeeded'}]});ports.notifications.mockRejectedValue(Error('private credentials'));ports.health.mockRejectedValue(Error('private SQL'));
  const result=await run();expect(result).toMatchObject({state:'finished',items:[{state:'succeeded'}],notifications:{state:'failed',code:'notification_processing_failed'},health:{state:'unavailable'}});expect(JSON.stringify(result)).not.toContain('private');
 });
 it('passes shutdown to both effectful phases and skips extra health I/O',async()=>{
  const controller=new AbortController();ports.tick.mockImplementation(async()=>{controller.abort();return {state:'interrupted',items:[]};});ports.notifications.mockResolvedValue({state:'interrupted'});
  expect(await run(controller.signal)).toMatchObject({state:'interrupted',notifications:{state:'interrupted'},health:{state:'interrupted'}});
  expect(ports.notifications).toHaveBeenCalledWith(expect.objectContaining({TIVDOC_MANAGED_DEV_BUILD_SHA:'a'.repeat(40)}),controller.signal);expect(ports.health).not.toHaveBeenCalled();
 });
 it('the authenticated status command never runs a worker or sends a message',async()=>{
  expect(await readManagedDevOperations({},'a'.repeat(40))).toMatchObject({state:'status',rows:[]});
  expect(ports.tick).not.toHaveBeenCalled();expect(ports.notifications).not.toHaveBeenCalled();expect(ports.status).toHaveBeenCalledOnce();expect(ports.health).toHaveBeenCalledOnce();
 });
});
