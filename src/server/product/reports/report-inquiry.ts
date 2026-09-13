import {renderPermission,type TopicProjection} from './case-report-projection';
const labels:Record<string,string>={minimum_wage:'שכר מינימום',working_time:'שעות עבודה',pension:'פנסיה',travel:'נסיעות',convalescence:'דמי הבראה',vacation:'חופשה',sick_leave:'דמי מחלה'};
export function inquiryText(topic:TopicProjection,kind:'initial'|'full',month:string):string{
 const permission=renderPermission(topic,kind);
 if(topic.gate!=='checked'||topic.status!=='finding')return '';
 const amount=permission.showsNumber?(topic.amount?` (${(topic.amount.minor_units/100).toFixed(2)} ₪)`:topic.range?` (${(topic.range.low.minor_units/100).toFixed(2)}–${(topic.range.high.minor_units/100).toFixed(2)} ₪)`:''):'';
 return `שלום, אבקש לברר את אופן החישוב בנושא ${labels[topic.topic]} לחודש ${month}${amount}. ${permission.line} אשמח לקבל פירוט של הנתונים והחישוב ולבדוק אם נדרש תיקון. תודה.`;
}
