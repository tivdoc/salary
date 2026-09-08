"use client";
import {useEffect,useState} from 'react';
import {clearSupportDrafts} from './support-recovery';
export function SessionControls(){
 const [active,setActive]=useState(false);const [error,setError]=useState('');
 useEffect(()=>{
  const controller=new AbortController();
  const refresh=()=>{if(document.visibilityState!=='visible')return;void fetch('/api/cases/access/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'refresh_session'}),signal:controller.signal}).then(r=>{if(!controller.signal.aborted&&(r.ok||r.status===401))setActive(r.ok);}).catch(()=>{});};
  refresh();const timer=setInterval(refresh,3600000);window.addEventListener('focus',refresh);
  return ()=>{controller.abort();clearInterval(timer);window.removeEventListener('focus',refresh);};
 },[]);
 async function logout(){
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full document navigation discards prefetched authenticated route data after logout.
  setError('');try{const r=await fetch('/api/cases/access/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'logout'})});if(!r.ok)throw new Error();try{clearSupportDrafts(sessionStorage);}catch{/* browser storage disabled */}window.location.assign('/login');}catch{setError('היציאה לא הושלמה. אפשר לנסות שוב.');}
 }
 return active?<><button type="button" className="button button--secondary" onClick={()=>void logout()}>יציאה</button>{error?<span role="alert">{error}</span>:null}</>:null;
}
