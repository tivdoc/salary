import {it,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {orderPurchaseTopicLabels,SavedQuoteSummary,OrderPurchase} from './order-purchase';
const quote={id:'synthetic-quote',from:'2026-05',to:'2026-07',topics:['rest_day','bonuses','contract'],total_minor:9900,credit_minor:999,balance_minor:8901,currency:'ILS' as const,expires_at:'2026-09-15T00:00:00.000Z'};
it('labels all three new topics while preserving historical sick leave labels',()=>{
 expect(orderPurchaseTopicLabels(quote.topics)).toBe('יום מנוחה, בונוסים, חוזה');expect(orderPurchaseTopicLabels(['sick_leave'])).toBe('מחלה');
});
it('shows the actual quote and honest uncreated-order state without a payment action',()=>{
 const html=renderToStaticMarkup(createElement(SavedQuoteSummary,{quote,orderReady:false,publicId:'TV-SYNTH001'}));
 for(const text of ['2026-05','2026-07','99.00','9.99','89.01','חוזה','טרם נפתחה','/case/TV-SYNTH001/thread'])expect(html).toContain(text);
 expect(html).not.toContain('button');expect(html).not.toContain('מעבר לתשלום');
});
it('does not tell the customer a saved order is uncreated',()=>{
 expect(renderToStaticMarkup(createElement(SavedQuoteSummary,{quote,orderReady:true}))).not.toContain('טרם נפתחה');
});
it('keeps the initial one-month maximum-three disclosure and requires a quote before checkout',()=>{
 const html=renderToStaticMarkup(createElement(OrderPurchase,{initial:true}));expect(html).toContain('חודש תלוש אחד ועד שלושה');expect(html).toContain('הצגת מחיר וכיסוי');expect(html).not.toContain('מעבר לתשלום מאובטח');
});
