import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,expect,it,vi} from 'vitest';
const ports=vi.hoisted(()=>({requests:vi.fn(),support:vi.fn(),session:true,member:true}));
vi.mock('server-only',()=>({}));
vi.mock('next/navigation',()=>({notFound:()=>{throw Error('NOT_FOUND');},redirect:()=>{throw Error('REDIRECT');}}));
vi.mock('next/link',()=>({default:({children,href}:{children:ReactNode;href:string})=>createElement('a',{href},children)}));
vi.mock('@/server/platform/capabilities/stable-next-entrypoint',()=>({guardStableAppEntrypoint:async()=>{}}));
vi.mock('@/server/product/case-access/session-cookie',()=>({readCaseSessionCookie:async()=>'synthetic-private-cookie'}));
vi.mock('@/server/product/case-access/service',()=>({resolveIdentitySession:async()=>ports.session?{identity_id:'synthetic-identity'}:null,
 listIdentityCases:async()=>ports.member?[{case_id:'synthetic-case',public_id:'TV-SYNTH001'}]:[]}));
vi.mock('@/server/product/reports/case-requests',()=>({listCaseRequests:ports.requests}));
vi.mock('@/server/product/reports/support',()=>({customerSupport:ports.support}));
vi.mock('@/components/case/case-shell',()=>({CaseShell:({children}:{children:ReactNode})=>createElement('main',null,children)}));
vi.mock('@/components/case/thread-view',()=>({ThreadView:({requests}:{requests:unknown})=>createElement('div',null,JSON.stringify(requests))}));
vi.mock('@/components/case/support-thread',()=>({SupportThreadView:()=>null}));
import Page from './page';
beforeEach(()=>{vi.clearAllMocks();ports.session=true;ports.member=true;ports.requests.mockResolvedValue([]);ports.support.mockResolvedValue([]);});
const render=async()=>renderToStaticMarkup(await Page({params:Promise.resolve({token:'TV-SYNTH001'})}));
it('forwards the actual private cookie after authenticated membership without serializing it into the thread',async()=>{
 const html=await render();expect(ports.requests).toHaveBeenCalledExactlyOnceWith('synthetic-case',undefined,'synthetic-identity','synthetic-private-cookie');
 expect(html).not.toContain('synthetic-private-cookie');expect(html).not.toContain('synthetic-identity');
});
it.each(['session','member'] as const)('does not read request projections without %s',async key=>{
 ports[key]=false;await expect(render()).rejects.toThrow(key==='session'?'REDIRECT':'NOT_FOUND');expect(ports.requests).not.toHaveBeenCalled();
});
