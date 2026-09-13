import {describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {inspectExtractionBytes} from '@/server/engine/extraction/verified-upload-source';
vi.mock('server-only',()=>({}));

const corpus=z.object({synthetic:z.literal(true),providerCalled:z.literal(false),files:z.array(z.object({
 id:z.string(),path:z.string(),sha256:z.string(),sizeBytes:z.number().int(),
 mimeType:z.enum(['application/pdf','image/png','image/jpeg']),
 oracle:z.object({hours:z.array(z.string()),baseMinor:z.number().int(),expectedMinor:z.number().int().nullable(),gapMinor:z.number().int().nullable()}),
})).length(7)}).parse(JSON.parse(readFileSync('docs/release-evidence/automatic-dev-live-extraction/independent-input-oracles.json','utf8')));

describe('independent synthetic live-extraction input corpus',()=>{
 it.each(corpus.files)('accepts the actual bytes and page count of $id without calling a provider',async entry=>{
  const bytes=readFileSync(entry.path);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
  expect(bytes.byteLength).toBe(entry.sizeBytes);
  expect(await inspectExtractionBytes(bytes,entry.mimeType)).toMatchObject({pages:1});
 });
 it('records independently specified arithmetic and unresolved-input cases',()=>{
  const clear=corpus.files.find(entry=>entry.id==='clear')!.oracle;
  const zero=corpus.files.find(entry=>entry.id==='zero-gap')!.oracle;
  const replacement=corpus.files.find(entry=>entry.id==='replacement')!.oracle;
  expect(clear.expectedMinor).toBe(100*3540);expect(clear.gapMinor).toBe(100*3540-330000);
  expect(zero.expectedMinor).toBe(100*3540);expect(zero.gapMinor).toBe(100*3540-354000);
  expect(replacement.expectedMinor).toBe(120*3540);expect(replacement.gapMinor).toBe(120*3540-396000);
  for(const id of ['missing-hours','ambiguous-hours'])expect(corpus.files.find(entry=>entry.id===id)!.oracle).toMatchObject({expectedMinor:null,gapMinor:null});
 });
});
