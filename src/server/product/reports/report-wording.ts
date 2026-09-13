/** Customer prose is chosen from bounded, non-monetary statements. Older free
 * text remains in the audit record; it cannot smuggle amounts into rendering. */
export const CUSTOMER_WORDING=Object.freeze([
 'נדרש בירור של בסיס הנתונים ששימש לחישוב.',
 'יש לבדוק את הנתון מול המסמך המקורי.',
 'יש מידע חסר שעשוי להשפיע על התוצאה.',
 'הממצא מתייחס לתקופה ולנושאים המפורטים בדוח בלבד.',
 'נבקש לקבל פירוט ולבדוק אם נדרש תיקון.',
]);
export function customerWording(value:unknown):string|null{return typeof value==='string'&&CUSTOMER_WORDING.includes(value)?value:null;}
