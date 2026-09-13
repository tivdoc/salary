import {productOffer,formatPrice} from '@/lib/product-offer';
export function PriceTiers(){
 const offer=productOffer(),tiers=offer.full_report.pricing.tiers;
 const money=(minor:number)=>formatPrice({amount:(minor/100).toFixed(2),currency:'ILS'});
 const credit=Number(offer.initial_check.price.amount.replace('.',''));
 return <div className="price-tiers" id="price-tiers"><table><caption>מדרגות ההשקה לפי הפער המבוסס בחודשים שנבדקו</caption><thead><tr><th scope="col">פער מבוסס</th><th scope="col">מחיר כולל</th><th scope="col">יתרה לאחר ראשוני</th></tr></thead><tbody>
 <tr><th scope="row">פחות מ־<bdi>{money(tiers[0].minimum_basis_minor)}</bdi></th><td colSpan={2}>אין שדרוג אוטומטי</td></tr>
 {tiers.map((tier,i)=><tr key={tier.minimum_basis_minor}><th scope="row"><bdi>{money(tier.minimum_basis_minor)}</bdi>{tiers[i+1]?<> עד פחות מ־<bdi>{money(tiers[i+1].minimum_basis_minor)}</bdi></>:' ומעלה'}</th><td><bdi>{money(tier.total_minor)}</bdi></td><td><bdi>{money(tier.total_minor-credit)}</bdi></td></tr>)}
 </tbody></table><p>היתרה מניחה תשלום ראשוני מלא ומאומת שטרם קוזז. כשאין סכום שניתן לבסס אין הצעת שדרוג. כל מדרגה כוללת אותו סוג תוצר; התקופה והכיסוי מוצגים בהצעה.</p></div>;
}
