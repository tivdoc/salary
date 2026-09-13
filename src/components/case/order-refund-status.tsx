import type {ProductOrder} from '@/server/product/orders/contracts';

/** The server supplied a cumulative request, not a provider refund receipt. */
export function OrderRefundStatus({order}:{order:ProductOrder}){
 if(order.refund_state==='refunded')return <p>ההחזר אומת</p>;
 if(order.price_correction)return <div><p><strong>בקשת החזר בעקבות תיקון</strong></p><p>נפתחה בקשת החזר בסך <bdi>{(order.price_correction.cumulative_refund_minor/100).toFixed(2)} ₪</bdi>. הבקשה בטיפול; הכסף טרם הוחזר.</p></div>;
 return <p>{order.refund_state==='requested'?'בקשת ההחזר בבדיקה; הכסף טרם הוחזר':order.refund_state==='none'?'אין בקשת החזר':order.refund_state==='rejected'?'בקשת ההחזר נדחתה':'ההחזר בטיפול; טרם התקבל אישור לביצועו'}</p>;
}
