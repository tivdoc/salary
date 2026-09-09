import {expect,it} from 'vitest';
import {validatePreviewTarget} from './preview-target.mts';
const sha='a'.repeat(40),target={sha,url:'salary-synthetic123-tivdoccom-5042s-projects.vercel.app',id:'dpl_synthetic123',target:'preview',readyState:'READY'};
it('binds all journeys to the same exact ready Preview',()=>{expect(validatePreviewTarget(target,sha)).toEqual({origin:'https://'+target.url,deployedSha:sha,deploymentId:target.id});});
it.each([{sha:'b'.repeat(40)},{target:'production'},{target:null},{readyState:'BUILDING'},{url:'tivdoc.com'},{url:'salary-foreign.vercel.app'},{url:'salary-synthetic123-tivdoccom-5042s-projects.vercel.app/path'},{id:'unverified'}])('refuses mismatched or unverified deployment metadata %j',change=>{expect(()=>validatePreviewTarget({...target,...change},sha)).toThrow();});
