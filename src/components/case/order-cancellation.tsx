'use client';
import {useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import type {ProductOrder} from '@/server/product/orders/contracts';

export function canShowUnstartedCancellation(order:ProductOrder){
 return order.can_cancel_unstarted===true&&order.kind==='full'&&order.state==='awaiting_payment'
  &&order.offer.version==='tivdoc-order-offer-v2'&&order.checkout_state==='none'
  &&order.payment_id===null&&order.verified_at===null&&order.refund_state==='none';
}

export function OrderCancellation({publicId,order}:{publicId:string;order:ProductOrder}){
 const router=useRouter(),inFlight=useRef(false);
 const [busy,setBusy]=useState(false),[cancelled,setCancelled]=useState(false),[message,setMessage]=useState('');
 async function cancel(){
  if(inFlight.current)return;inFlight.current=true;setBusy(true);setMessage('');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{
   const response=await fetch('/api/payments/start',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'cancel_unstarted',publicId,orderId:order.id})});
   const result=await response.json();
   if(!response.ok){setMessage(result.code==='cancellation_requires_reconciliation'?'מצב ההזמנה השתנה או שכבר התחיל ניסיון תשלום. נדרש בירור לפני ביטול.':'לא התקבל אישור ביטול. אפשר לבדוק את ההיסטוריה או לנסות שוב.');return;}
   if(result.cancellation?.order_id!==order.id||result.cancellation?.state!=='cancelled'||typeof result.cancellation?.replayed!=='boolean')throw Error('UNCONFIRMED');
   setCancelled(true);router.refresh();
  }catch{setMessage('לא התקבל אישור ביטול. אפשר לבדוק את ההיסטוריה או לנסות שוב.');}
  finally{clearTimeout(timer);inFlight.current=false;setBusy(false);}
 }
 if(cancelled)return <p role="status">ההזמנה בוטלה לפני תחילת התשלום.</p>;
 if(!canShowUnstartedCancellation(order))return null;
 return <div><button type="button" className="button button--secondary" disabled={busy} aria-busy={busy} onClick={cancel}>{busy?'שומרים את הביטול…':'ביטול ההזמנה שטרם שולמה'}</button>{message?<p role="alert">{message}</p>:null}</div>;
}
