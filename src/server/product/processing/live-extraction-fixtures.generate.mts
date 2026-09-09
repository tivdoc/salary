import {mkdirSync,writeFileSync} from 'node:fs';
import {LIVE_EXTRACTION_ORACLES,createLiveExtractionFixture} from './live-extraction-fixtures.ts';
const directory='docs/release-evidence/automatic-dev-live-extraction';
mkdirSync(directory,{recursive:true});
const files=[];
for(const oracle of LIVE_EXTRACTION_ORACLES){
 const fixture=await createLiveExtractionFixture(oracle);
 writeFileSync(`${directory}/${fixture.name}`,fixture.bytes);
 files.push({id:fixture.id,path:`${directory}/${fixture.name}`,sha256:fixture.sha256,sizeBytes:fixture.bytes.length,mimeType:fixture.mimeType,oracle});
}
writeFileSync(`${directory}/independent-input-oracles.json`,JSON.stringify({schemaVersion:'tivdoc-live-extraction-corpus-v1',
 synthetic:true,humanReview:false,legalGoldenApproval:false,providerCalled:false,files},null,2)+'\n');
console.log(JSON.stringify({state:'fixtures_generated',count:files.length,providerCalled:false,directory}));
