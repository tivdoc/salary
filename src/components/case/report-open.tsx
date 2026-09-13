"use client";
import {useEffect,useRef} from 'react';
export function ReportOpen({publicId,reportId}:{publicId:string;reportId:string}){
 const marker=useRef<HTMLSpanElement>(null);
 useEffect(()=>{let sent=false;const send=()=>{if(sent||document.visibilityState!=='visible'||!marker.current)return;const box=marker.current.getBoundingClientRect();if(box.bottom<0||box.top>innerHeight)return;sent=true;void fetch(`/api/cases/${publicId}/reports`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'opened',reportId})}).catch(()=>{});};const observer=new IntersectionObserver(send);if(marker.current)observer.observe(marker.current);document.addEventListener('visibilitychange',send);send();return()=>{observer.disconnect();document.removeEventListener('visibilitychange',send);};},[publicId,reportId]);
 return <span ref={marker} aria-hidden="true" />;
}
