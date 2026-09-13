import 'server-only';
import {z} from 'zod';
import manifest from './ai-release-build-manifest.json';
import {canonicalSha256,deepFreeze} from '../../../engine/rule-runtime/canonical';
import {AI_RELEASE_RUNTIME_FAMILIES} from '../../../engine/ai-release-runtime/contracts';

const hash=z.string().regex(/^[a-f0-9]{64}$/u);
const relative=z.string().regex(/^[A-Za-z0-9_./-]+$/u).refine(p=>!p.startsWith('/')&&!p.split('/').some(s=>s===''||s==='.'||s==='..'));
const excluded=(p:string)=>p==='src/server/product/processing/ai-release-build-manifest.json'||/(?:^|\/)(?:__tests__|fixtures?|benchmarks?)(?:\/|$)|(?:\.|-)(?:test|spec|fixture)s?\.[^.]+$/u.test(p);
export const aiReleaseBuildManifestSchema=z.object({schema_version:z.literal('tivdoc-ai-release-build-manifest-v1'),
 normalization:z.literal('utf8-lf-v1'),entrypoints:z.array(relative).min(1).max(256),
 files:z.array(z.object({path:relative,sha256:hash}).strict()).min(1).max(5000),source_graph_sha256:hash,sha256:hash,
}).strict().superRefine((v,ctx)=>{
 const fail=(message:string)=>ctx.addIssue({code:'custom',message});
 const paths=v.files.map(f=>f.path);
 for(const list of [paths,v.entrypoints])if(list.some((p,i)=>i>0&&p<=list[i-1]))fail('AI_BUILD_SOURCE_ORDER');
 if(paths.some(excluded)||v.entrypoints.some(p=>!paths.includes(p)))fail('AI_BUILD_SOURCE_INVENTORY');
 const {sha256,source_graph_sha256,...body}=v;
 if(canonicalSha256(body)!==source_graph_sha256||canonicalSha256({...body,source_graph_sha256})!==sha256)fail('AI_BUILD_CONTENT_HASH');
});

const compiledManifest=aiReleaseBuildManifestSchema.parse(manifest);
const compiled=deepFreeze({manifest:compiledManifest,trusted_generator_pins:AI_RELEASE_RUNTIME_FAMILIES.map(f=>({
 family_id:f.family_id,generator:{id:f.generator_id,version:f.generator_version,code_sha256:compiledManifest.source_graph_sha256},
}))});
export type AiReleaseCompiledBuild=typeof compiled;

/** No file-system/env/config expectation at runtime: these bytes were imported
 * into this application. The build pipeline must run the manifest --check. */
export function getCompiledAiReleaseBuild():AiReleaseCompiledBuild{return compiled;}
export function assertCompiledAiReleaseBuild(candidate:AiReleaseCompiledBuild):void{
 if(candidate!==compiled)throw Error('AI_RELEASE_UNTRUSTED_BUILD_EXPECTATION');
}
