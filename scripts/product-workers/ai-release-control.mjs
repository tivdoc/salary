import "../production-refusal.mjs";
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,realpathSync,statSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileFunction} from 'node:vm';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const AI_CONTROL_TARGET=Object.freeze({host:'aws-0-eu-central-1.pooler.supabase.com',database:'tivdoc_release_replay_20260907',
 user:'tivdoc_dev_migrator.cpzrbidxftzqcfeqqusu',role:'tivdoc_dev_migrator'});
const sha=value=>createHash('sha256').update(value).digest('hex');
const hashPattern=/^[a-f0-9]{64}$/u;
const uuidPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const assert=(condition,code)=>{if(!condition)throw Error(code);};
const canonical=value=>{
 if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
 if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
 assert(value===null||['boolean','string','number'].includes(typeof value),'AI_CONTROL_JSON_VALUE');
 if(typeof value==='number')assert(Number.isFinite(value),'AI_CONTROL_JSON_VALUE');
 return JSON.stringify(value);
};
const same=(a,b)=>canonical(a)===canonical(b);
const inside=(root,file)=>{const rel=path.relative(root,file);return !rel||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));};

export function assertLocalAiControl(env=process.env){
 const lower=value=>String(value??'').trim().toLowerCase();
 assert(!['production'].includes(lower(env.NODE_ENV))&&!['production','preview'].includes(lower(env.VERCEL_ENV))
  &&!env.VERCEL&&!env.VERCEL_ENV,'AI_CONTROL_LOCAL_DEV_ONLY');
}

/** Home may itself be a Git repository: every ancestor must ignore this
 * untracked path. The application checkout is always forbidden, even ignored. */
export function aiControlPrivatePath(value,repo=ROOT){
 assert(typeof value==='string'&&value.length>0,'AI_CONTROL_PRIVATE_PATH');
 const absolute=path.resolve(value);let ancestor=absolute;
 while(!existsSync(ancestor)){const parent=path.dirname(ancestor);assert(parent!==ancestor,'AI_CONTROL_PRIVATE_PATH');ancestor=parent;}
 const resolved=path.join(realpathSync(ancestor),path.relative(ancestor,absolute));
 assert(!inside(path.resolve(repo),absolute)&&!inside(realpathSync(repo),resolved),'AI_CONTROL_PRIVATE_PATH_IN_CHECKOUT');
 let current=existsSync(resolved)&&statSync(resolved).isDirectory()?resolved:path.dirname(resolved);
 for(;;){
  if(existsSync(path.join(current,'.git'))){
   const relative=path.relative(current,resolved).replaceAll('\\','/');
   try{
    assert(relative&&execFileSync('git',['--literal-pathspecs','-C',current,'ls-files','-z','--',relative],{stdio:['ignore','pipe','pipe'],windowsHide:true}).length===0,'AI_CONTROL_PRIVATE_PATH_TRACKED');
    execFileSync('git',['-C',current,'check-ignore','--quiet','--no-index','--',relative],{stdio:'ignore',windowsHide:true});
   }catch{throw Error('AI_CONTROL_PRIVATE_PATH_NOT_IGNORED');}
  }
  const parent=path.dirname(current);if(parent===current)break;current=parent;
 }
 return resolved;
}

export function parseAiControlArgs(args){
 const [command,...rest]=args;
 const allowed={inspect:[], 'config-validate':['configuration'], 'config-store':['configuration','credentials','apply'],
  enroll:['request','credentials','apply'],revoke:['request','credentials','apply'],status:['case','credentials']};
 assert(Object.hasOwn(allowed,command),'AI_CONTROL_USAGE');const options={command,apply:false};const seen=new Set();
 for(let i=0;i<rest.length;i++){
  const key=rest[i].startsWith('--')?rest[i].slice(2):'';
  assert(allowed[command].includes(key)&&!seen.has(key),'AI_CONTROL_USAGE');seen.add(key);
  if(key==='apply')options.apply=true;
  else{const value=rest[++i];assert(value&&!value.startsWith('--'),'AI_CONTROL_USAGE');options[key]=value;}
 }
 for(const key of allowed[command].filter(k=>k!=='apply'))assert(typeof options[key]==='string','AI_CONTROL_USAGE');
 if(command==='status')assert(uuidPattern.test(options.case),'AI_CONTROL_CASE_ID');
 return options;
}

export function parseAiControlRequest(value){
 const keys=['schema_version','case_id','configuration_sha256','request_key','issued_at','expires_at','reason'];
 assert(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k)),'AI_CONTROL_REQUEST_SHAPE');
 assert(value.schema_version==='ai-release-control-request-v1'&&uuidPattern.test(value.case_id)&&hashPattern.test(value.configuration_sha256),'AI_CONTROL_REQUEST_SCOPE');
 assert(typeof value.request_key==='string'&&/^[A-Za-z0-9._:-]{8,200}$/u.test(value.request_key),'AI_CONTROL_REQUEST_KEY');
 assert(typeof value.reason==='string'&&value.reason.trim()===value.reason&&[...value.reason].length>=10&&[...value.reason].length<=1000,'AI_CONTROL_REQUEST_REASON');
 for(const key of ['issued_at','expires_at'])assert(typeof value[key]==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value[key])
  &&Number.isFinite(Date.parse(value[key]))&&new Date(value[key]).toISOString().replace('.000Z','Z')===value[key].replace('.000Z','Z'),'AI_CONTROL_REQUEST_TIME');
 const duration=Date.parse(value.expires_at)-Date.parse(value.issued_at);
 assert(duration>0&&duration<=86400000,'AI_CONTROL_REQUEST_WINDOW');
 return Object.freeze({...value});
}

export function aiControlDatabaseOptions(connectionString,ca){
 let url;try{url=new URL(connectionString);}catch{throw Error('AI_CONTROL_DATABASE_TARGET');}
 assert(['postgres:','postgresql:'].includes(url.protocol)&&url.hostname===AI_CONTROL_TARGET.host
  &&decodeURIComponent(url.username)===AI_CONTROL_TARGET.user&&url.pathname===`/${AI_CONTROL_TARGET.database}`
  &&['','5432','6543'].includes(url.port)&&url.password&&!url.hash,'AI_CONTROL_DATABASE_TARGET');
 // URL sslmode must not override this explicit certificate verification.
 url.search='';
 return {connectionString:url.toString(),ssl:{rejectUnauthorized:true,ca},connectionTimeoutMillis:15000,statement_timeout:20000};
}

/** Same KEY=value format as dev-credential.mts, with no credential-issuing
 * module import or fallback search. Duplicate target values are ambiguous. */
export function aiControlCredentialUrl(body){
 const values=body.split(/\r?\n/u).filter(line=>line.startsWith('TIVDOC_DEV_DATABASE_URL=')).map(line=>line.slice('TIVDOC_DEV_DATABASE_URL='.length));
 assert(values.length===1&&values[0],'AI_CONTROL_CREDENTIAL_FILE');return values[0];
}

function storedConfiguration(row){
 assert(row&&row.payload&&row.payload_sha256===row.payload.sha256&&row.configuration_id===row.payload.configuration_id
  &&row.revision===row.payload.revision,'AI_CONTROL_STORED_CONFIGURATION_BINDING');
 const {sha256,...body}=row.payload;
 assert(hashPattern.test(sha256)&&sha(canonical(body))===sha256,'AI_CONTROL_STORED_CONFIGURATION_HASH');
 return row.payload;
}
function configurationSummary(config){
 const counts=values=>values.reduce((all,v)=>({...all,[v.status]:(all[v.status]??0)+1}),{});
 return {configuration_id:config.configuration_id,revision:config.revision,configuration_sha256:config.sha256,
  build_manifest_sha256:config.build_manifest_sha256,purpose:config.policy.purpose??'qualified_ai_report',namespace:config.policy.namespace,branches:config.policy.branches.length,
  source_review_states:counts(config.source_receipts),interpretation_states:counts(config.interpretation_receipts),
  human_law_states:config.interpretation_receipts.reduce((all,v)=>({...all,[v.human_by_law.state]:(all[v.human_by_law.state]??0)+1}),{}),
  runtime_admission_evaluated:false};
}
function receiptSummary(receipt,dbTime){
 const current=receipt.current===true,at=Date.parse(dbTime);
 return {schema_version:receipt.schema_version,event_id:receipt.event_id,case_id:receipt.case_id,sequence:receipt.sequence,
  predecessor_id:receipt.predecessor_id,configuration_sha256:receipt.configuration_sha256,kind:receipt.kind,
  request_key_sha256:sha(receipt.request_key),reason_sha256:sha(receipt.reason),issued_at:receipt.issued_at,expires_at:receipt.expires_at,
  replayed:receipt.replayed,current,authority_dependency_sha256:receipt.authority_dependency_sha256,db_time:dbTime,
  enrollment_state:!current?'superseded':receipt.kind==='revoked'?'revoked':at>=Date.parse(receipt.expires_at)?'expired'
   :at<Date.parse(receipt.issued_at)?'not_yet_active':'within_window',runtime_admission_evaluated:false};
}
function matchesRequest(event,request,kind){
 return event.configuration_sha256===request.configuration_sha256&&event.kind===kind&&event.idempotency_key===request.request_key
  &&Date.parse(event.issued_at)===Date.parse(request.issued_at)&&Date.parse(event.expires_at)===Date.parse(request.expires_at)&&event.reason===request.reason;
}

export const AI_CONTROL_SQL=Object.freeze({
 identity:'select session_user as session_user,current_user as current_user,current_database() as database,clock_timestamp()::text as db_time',
 qa:'select id,is_qa from public.cases where id=$1::uuid',
 configs:'select configuration_id,revision,payload_sha256,payload from private.ai_release_configurations where payload_sha256=$1 or (configuration_id=$2::uuid and revision=$3)',
 configByHash:'select configuration_id,revision,payload_sha256,payload from private.ai_release_configurations where payload_sha256=$1',
 configInsert:'insert into private.ai_release_configurations(configuration_id,revision,payload_sha256,payload) values($1::uuid,$2,$3,$4::jsonb) on conflict do nothing',
 prior:'select * from private.ai_release_enrollment_events where case_id=$1::uuid and idempotency_key=$2',
 latest:'select e.*,private.ai_release_dependency(e.case_id) as authority_dependency_sha256 from private.ai_release_enrollment_events e where e.case_id=$1::uuid order by sequence desc limit 1',
 record:'select private.ai_release_enrollment_record($1::uuid,$2::text,$3::text,$4::text,$5::timestamptz,$6::timestamptz,$7::text) as receipt',
});

/** All I/O is injected for offline tests. Production main supplies only fixed,
 * parameterized SQL and the repository's compiled verifier. */
export async function runAiReleaseControl(args,ports){
 assertLocalAiControl(ports.env??process.env);const options=parseAiControlArgs(args);
 const base={schema_version:'ai-release-control-result-v1',command:options.command,applied:false};
 if(options.command==='inspect')return {...base,...await ports.inspect(),runtime_admission_evaluated:false};
 let config=null,request=null;
 if(options.configuration)config=await ports.verifyConfiguration(await ports.readJson(options.configuration));
 if(options.request)request=parseAiControlRequest(await ports.readJson(options.request));
 if(options.command==='config-validate')return {...base,integrity_valid:true,...configurationSummary(config)};
 return ports.database(options.credentials,options.apply,async db=>{
  const identity=(await db.query(AI_CONTROL_SQL.identity)).rows[0];
  assert(identity?.session_user===AI_CONTROL_TARGET.role&&identity.current_user===AI_CONTROL_TARGET.role&&identity.database===AI_CONTROL_TARGET.database,'AI_CONTROL_DATABASE_IDENTITY');
  const dbTime=identity.db_time;assert(Number.isFinite(Date.parse(dbTime)),'AI_CONTROL_DATABASE_TIME');
  if(options.command==='config-store'){
   if(options.apply)await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`ai-config:${config.configuration_id}:${config.revision}`]);
   const params=[config.sha256,config.configuration_id,config.revision];
   let rows=(await db.query(AI_CONTROL_SQL.configs,params)).rows;
   for(const row of rows)assert(same(storedConfiguration(row),config),'AI_CONTROL_CONFIGURATION_RETRY_MISMATCH');
   const existed=rows.length>0;
   if(options.apply&&!existed){
    await db.query(AI_CONTROL_SQL.configInsert,[config.configuration_id,config.revision,config.sha256,JSON.stringify(config)]);
    rows=(await db.query(AI_CONTROL_SQL.configs,params)).rows;
    assert(rows.length===1&&same(storedConfiguration(rows[0]),config),'AI_CONTROL_CONFIGURATION_RETRY_MISMATCH');
   }
   return {...base,applied:options.apply,replayed:existed,operation:existed?'already_stored':'store_configuration',...configurationSummary(config)};
  }
  const caseId=request?.case_id??options.case;
  const caseRow=(await db.query(AI_CONTROL_SQL.qa,[caseId])).rows[0];
  assert(caseRow?.id===caseId&&caseRow.is_qa===true,'AI_CONTROL_QA_CASE_REQUIRED');
  const latest=(await db.query(AI_CONTROL_SQL.latest,[caseId])).rows[0];
  if(options.command==='status')return latest?{...base,enrollment:receiptSummary({...latest,request_key:latest.idempotency_key,
   schema_version:'ai-release-enrollment-receipt-v1',replayed:false,current:true},dbTime)}:{...base,case_id:caseId,enrollment:null,db_time:dbTime,runtime_admission_evaluated:false};
  const kind=options.command==='enroll'?'granted':'revoked';
  const existing=(await db.query(AI_CONTROL_SQL.prior,[caseId,request.request_key])).rows[0];
  if(existing)assert(matchesRequest(existing,request,kind),'AI_RELEASE_ENROLLMENT_RETRY_MISMATCH');
  else{
   const row=(await db.query(AI_CONTROL_SQL.configByHash,[request.configuration_sha256])).rows[0];
   assert(row,'AI_CONTROL_CONFIGURATION_NOT_STORED');const stored=storedConfiguration(row);
   if(kind==='granted'){
    await ports.verifyConfiguration(stored);
    const from=Date.parse(request.issued_at),to=Date.parse(request.expires_at),now=Date.parse(dbTime);
    assert(from<=now+60000&&to>now&&[stored.policy,stored.registry].every(window=>from>=Date.parse(window.issued_at)&&to<=Date.parse(window.expires_at)),'AI_RELEASE_ENROLLMENT_VALIDITY');
   }else assert(latest?.kind==='granted'&&latest.configuration_sha256===request.configuration_sha256,'AI_RELEASE_REVOKE_SCOPE');
  }
  if(!options.apply){
   const historical=existing?receiptSummary({...existing,request_key:existing.idempotency_key,schema_version:'ai-release-enrollment-receipt-v1',
    replayed:true,current:latest?.event_id===existing.event_id,authority_dependency_sha256:latest?.authority_dependency_sha256??null},dbTime):null;
   return {...base,operation:existing?'replay_existing_event':kind,case_id:caseId,configuration_sha256:request.configuration_sha256,
    request_key_sha256:sha(request.request_key),issued_at:request.issued_at,expires_at:request.expires_at,existing_receipt:historical,runtime_admission_evaluated:false};
  }
  const receipt=(await db.query(AI_CONTROL_SQL.record,[caseId,request.configuration_sha256,request.request_key,kind,request.issued_at,request.expires_at,request.reason])).rows[0]?.receipt;
  assert(receipt?.schema_version==='ai-release-enrollment-receipt-v1'&&receipt.case_id===caseId
   &&uuidPattern.test(receipt.event_id)&&Number.isSafeInteger(receipt.sequence)&&receipt.sequence>0
   &&(receipt.predecessor_id===null||uuidPattern.test(receipt.predecessor_id))&&hashPattern.test(receipt.authority_dependency_sha256)
   &&typeof receipt.current==='boolean'&&typeof receipt.replayed==='boolean'
   &&matchesRequest({...receipt,idempotency_key:receipt.request_key},request,kind),'AI_CONTROL_RECEIPT_BINDING');
  return {...base,applied:true,enrollment:receiptSummary(receipt,dbTime)};
 });
}

/** Bundle fixed repository code in memory; configuration is parsed data and
 * never interpolated into executable source. No reapproval or manifest write. */
export async function loadAiControlHelpers(){
 const {build}=await import('esbuild');
 const compiled=await build({stdin:{contents:`export {verifyAiReleaseConfiguration,verifyOwnerEngineeringConfiguration} from './src/server/product/processing/ai-release-configuration';
 export {getCompiledAiReleaseBuild} from './src/server/product/processing/ai-release-build';
 export {SUPABASE_ROOT_2021_CA} from './src/server/product/case-access/supabase-ca';`,resolveDir:ROOT,loader:'ts'},
  absWorkingDir:ROOT,bundle:true,platform:'node',format:'cjs',target:'node22',packages:'external',write:false,logLevel:'silent',
  plugins:[{name:'server-only-local',setup(b){b.onResolve({filter:/^server-only$/},()=>({path:'server-only',namespace:'empty'}));b.onLoad({filter:/.*/,namespace:'empty'},()=>({contents:''}));}}]});
 const bundledModule={exports:{}};compileFunction(compiled.outputFiles[0].text,['require','module','exports'])(createRequire(path.join(ROOT,'package.json')),bundledModule,bundledModule.exports);
 return bundledModule.exports;
}

export function safeAiControlError(error){
 const message=error instanceof Error?error.message:'';
 return /^(?:AI_CONTROL_|AI_CONFIGURATION_|AI_BUILD_|AI_RELEASE_)[A-Z0-9_]+$/u.test(message)?message:'AI_CONTROL_FAILED';
}
async function main(){
 assertLocalAiControl();const args=process.argv.slice(2);parseAiControlArgs(args);
 let helpers,build;const getHelpers=async()=>helpers??=await loadAiControlHelpers();
 const getBuild=async()=>{
  if(!build){const {checkAiReleaseBuildManifest}=await import('../ai-release-build-manifest.mjs');await checkAiReleaseBuildManifest(ROOT);build=(await getHelpers()).getCompiledAiReleaseBuild();}
  return build;
 };
 const result=await runAiReleaseControl(args,{env:process.env,
  readJson:async value=>{const file=aiControlPrivatePath(value);assert(statSync(file).isFile()&&statSync(file).size<=10*1024*1024,'AI_CONTROL_FILE_SIZE');return JSON.parse(readFileSync(file,'utf8'));},
  inspect:async()=>{const current=await getBuild();return {build_manifest_sha256:current.manifest.sha256,source_graph_sha256:current.manifest.source_graph_sha256,
   source_files:current.manifest.files.length,trusted_families:current.trusted_generator_pins.map(p=>p.family_id)};},
  verifyConfiguration:async candidate=>{const h=await getHelpers();return (candidate?.schema_version==='tivdoc-owner-engineering-configuration-v1'?h.verifyOwnerEngineeringConfiguration:h.verifyAiReleaseConfiguration)(candidate,await getBuild()).configuration;},
  database:async(credentials,apply,operation)=>{
   const file=aiControlPrivatePath(credentials);assert(statSync(file).isFile()&&statSync(file).size<=1024*1024,'AI_CONTROL_FILE_SIZE');
   const helper=await getHelpers(),url=aiControlCredentialUrl(readFileSync(file,'utf8')),{default:pg}=await import('pg');
   const client=new pg.Client(aiControlDatabaseOptions(url,helper.SUPABASE_ROOT_2021_CA));
   try{
    await client.connect();await client.query(apply?'begin':'begin read only');
    const receipt=await operation(client);await client.query('commit');return receipt;
   }catch(error){try{await client.query('rollback');}catch{/* An uncertain commit is reconciled by the same immutable request. */}throw error;}
   finally{await client.end();}
  },
 });
 process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
main().catch(error=>{process.stderr.write(safeAiControlError(error)+'\n');process.exitCode=1;});
}
