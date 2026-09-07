import {it,expect} from 'vitest';
import {sameOriginSessionRequest,refreshSession,revokeSession} from './session-actions';
import type {CaseAccessDb} from './db';
it('P07 cookie lifetime matches stored expiry, and revoke hashes the opaque session',async()=>{
 const calls:{fn:string;args:unknown}[]=[];const db:CaseAccessDb={provider:'fake',async rpc<T>(fn:string,args:Readonly<Record<string,unknown>>){calls.push({fn,args});return (fn==='case_access_session_resolve'?[{expires_at:'2026-09-08T00:00:00Z'}]:[]) as T[];}};
 expect(await refreshSession('test_session_opaque',db,Date.parse('2026-09-07T00:00Z'))).toEqual({ttl:86400});
 await revokeSession('test_session_opaque',db);expect(JSON.stringify(calls)).not.toContain('test_session_opaque');expect(calls.at(-1)?.fn).toBe('case_access_session_revoke');
});
it('P07 rejects cross-origin and missing-Origin session mutations',()=>{
 expect(sameOriginSessionRequest(new Request('https://app.example/access',{headers:{origin:'https://app.example'}}))).toBe(true);
 expect(sameOriginSessionRequest(new Request('https://app.example/access',{headers:{origin:'https://evil.example'}}))).toBe(false);
 expect(sameOriginSessionRequest(new Request('https://app.example/access'))).toBe(false);
});
