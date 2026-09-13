import {it,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {orderPurchaseTopicLabels,SavedQuoteSummary,SavedOfferAvailability,OrderPurchase} from './order-purchase';
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

it('offers only the saved period instead of advertising arbitrary month purchases',()=>{
 const html=renderToStaticMarkup(createElement(OrderPurchase,{publicId:'TV-SYNTH001'}));
 expect(html).toContain('הצגת ההצעה השמורה');expect(html).toContain('רכישה לתקופה אחרת עדיין אינה זמינה');
 expect(html).not.toContain('type="month"');expect(html).not.toContain('בחרו תקופה');expect(html).not.toContain('מעבר לתשלום מאובטח');
});
it.each(['needs_information','conditional_result','comparison_needs_review','coverage_unavailable','order_needs_review','quote_expired','below_upgrade_threshold','not_prepared'] as const)('explains %s availability without offering checkout or inventing a price',state=>{
 const html=renderToStaticMarkup(createElement(SavedOfferAvailability,{availability:{state,period:{from:'2026-05',to:'2026-07'}}}));
 expect(html).toContain('role="status"');expect(html).toContain('2026-05');expect(html).toContain('2026-07');
 expect(html).not.toContain('button');expect(html).not.toContain('₪');expect(html).not.toContain('מעבר לתשלום');expect(html).not.toContain(state);
});
it('does not invent an available period when no saved offer exists',()=>{
 const html=renderToStaticMarkup(createElement(SavedOfferAvailability,{availability:{state:'not_prepared',period:null}}));
 expect(html).toContain('עדיין לא נשמרה');expect(html).not.toContain('התקופה שנבדקה');
});
it('retains the nine release topics and historical sick-leave disclosure',()=>{
 const labels=orderPurchaseTopicLabels(['minimum_wage','working_time','pension','travel','convalescence','vacation','rest_day','bonuses','contract','sick_leave']);
 for(const text of ['שכר מינימום','שעות עבודה','פנסיה','נסיעות','הבראה','חופשה','יום מנוחה','בונוסים','חוזה','מחלה'])expect(labels).toContain(text);
});
