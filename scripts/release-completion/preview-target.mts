import '../production-refusal.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';

/** The operator obtains this metadata from Vercel after both exact CI runs.
 * Every journey must target the same committed source and isolated host; no
 * remembered URL or silent fallback to a previously passing Preview. */
export function validatePreviewTarget(raw:unknown,head:string){
 assert.ok(raw&&typeof raw==='object'&&!Array.isArray(raw));
 const d=raw as Record<string,unknown>;
 assert.match(head,/^[a-f0-9]{40}$/u);assert.equal(d.sha,head);
 assert.equal(d.readyState,'READY');assert.equal(d.target,'preview');
 assert.equal(typeof d.id,'string');assert.match(d.id as string,/^dpl_[A-Za-z0-9]+$/u);
 assert.equal(typeof d.url,'string');assert.match(d.url as string,/^salary-[a-z0-9]+-tivdoccom-5042s-projects\.vercel\.app$/u);
 return Object.freeze({origin:`https://${d.url}`,deployedSha:head,deploymentId:d.id as string});
}
export function currentPreviewTarget(){
 const file=process.env.TIVDOC_RELEASE_PREVIEW_DEPLOYMENT_FILE;
 if(!file)throw Error('EXACT_PREVIEW_METADATA_REQUIRED');
 return validatePreviewTarget(JSON.parse(readFileSync(file,'utf8')),execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim());
}
