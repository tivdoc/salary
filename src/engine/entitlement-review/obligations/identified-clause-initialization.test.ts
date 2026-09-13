import {execFileSync} from 'node:child_process';
import {describe,expect,it} from 'vitest';

describe('identified clause native module initialization',()=>{
 it.each(['./payment-link.ts','../../document-review/contracts.ts'])(
  'initializes %s in a fresh native ESM process',entry=>{
   // Vitest transforms imports and can hide a schema's temporal dead zone.
   // Starting at payment-link reproduced the optimized Next build failure.
   const entryUrl=new URL(entry,import.meta.url).href;
   const reviewUrl=new URL('../../document-review/contracts.ts',import.meta.url).href;
   const script=`await import(${JSON.stringify(entryUrl)});
const review=await import(${JSON.stringify(reviewUrl)});
if(typeof review.documentReviewInputSchema.safeParse!=='function')throw Error('REVIEW_SCHEMA_MISSING');
process.stdout.write('initialized');`;
   expect(execFileSync(process.execPath,['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
    '--experimental-strip-types','--input-type=module','-e',script],
   {encoding:'utf8',windowsHide:true,timeout:10000})).toBe('initialized');
  });
});
