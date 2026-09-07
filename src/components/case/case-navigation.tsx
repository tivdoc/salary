"use client";
import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {useEffect,useState} from 'react';
export function CaseNavigation({publicId}:{publicId:string}){
 const pathname=usePathname();
 const links=[['','ראשי'],['/documents','מסמכים'],['/thread','הודעות'],['/reports','דוחות']];
 return <nav className="case-navigation" aria-label="ניווט בתיק">{links.map(([suffix,label])=>{const href=`/case/${publicId}${suffix}`;return <Link key={href} href={href} aria-current={pathname===href?'page':undefined}>{label}</Link>;})}</nav>;
}
export function ConnectionNotice(){
 const [offline,setOffline]=useState(false);
 useEffect(()=>{const update=()=>setOffline(!navigator.onLine);update();window.addEventListener('online',update);window.addEventListener('offline',update);return ()=>{window.removeEventListener('online',update);window.removeEventListener('offline',update);};},[]);
 return offline?<p className="connection-notice" role="status">אין חיבור לרשת. אפשר להמשיך לכתוב כאן; שמירה ושליחה דורשות חיבור. אל תסגרו את המסך לפני אישור השמירה.</p>:null;
}
