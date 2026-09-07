"use client";
import Link from 'next/link';
export default function CaseError({reset}:{reset:()=>void}){return <main id="main-content" className="check-main"><div className="check-shell received-card"><h1>לא הצלחנו לטעון את התיק</h1><p role="alert">הנתונים אינם זמינים כרגע. זו אינה רשימה ריקה או תוצאת בדיקה.</p><button className="button button--primary" onClick={reset}>ניסיון נוסף</button><p><Link href="/login">כניסה מחדש</Link> · <Link href="/cases">התיקים שלי</Link></p></div></main>;}
