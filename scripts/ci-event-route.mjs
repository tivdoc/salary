import {readFileSync,appendFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

export async function routeCiEvent({eventName,event,repository,sha,ref,token},fetcher=fetch){
 const full=reason=>({run:true,reason});
 if(eventName!=='push')return full('merge_or_requested_verification');
 if(!ref?.startsWith('refs/heads/')||ref==='refs/heads/'+event.repository?.default_branch)return full('published_ref');
 if(!token||!/^[-\w.]+\/[-\w.]+$/u.test(repository??'')||!/^[a-f0-9]{40}$/u.test(sha??''))return full('routing_unavailable');
 const branch=ref.slice('refs/heads/'.length),owner=repository.split('/')[0];
 try{
  const url=new URL('https://api.github.com/repos/'+repository+'/pulls');url.searchParams.set('state','open');url.searchParams.set('head',owner+':'+branch);url.searchParams.set('per_page','100');
  const response=await fetcher(url,{headers:{authorization:'Bearer '+token,accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},signal:AbortSignal.timeout(10000)});
  if(!response.ok)return full('routing_unavailable');
  const prs=await response.json();if(!Array.isArray(prs))return full('routing_unavailable');
  const matching=prs.find(p=>p.state==='open'&&p.head?.sha===sha&&p.head?.ref===branch&&p.head?.repo?.full_name===repository&&p.base?.repo?.full_name===repository);
  return matching?{run:false,reason:'exact_open_pr_merge_event',pr:matching.number}:full('branch_without_matching_pr');
 }catch{return full('routing_unavailable');}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const result=await routeCiEvent({eventName:process.env.GITHUB_EVENT_NAME,event:JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8')),repository:process.env.GITHUB_REPOSITORY,sha:process.env.GITHUB_SHA,ref:process.env.GITHUB_REF,token:process.env.GITHUB_TOKEN});
 appendFileSync(process.env.GITHUB_OUTPUT,`run=${result.run}\n`);console.log(JSON.stringify(result));
}
