/** Client-safe presentation contract. Targets, hashes and verification remain server-side. */
export type DocumentReadingDisplay=Readonly<{
 question:string;field:string;raw_value:string|null;page:number;text_fragment:string|null;
 bounding_box:{x:number;y:number;width:number;height:number;coordinate_space:'normalized'|'pixels'}|null;
}>;
export function displayDocumentReadingAnswer(value:string|null):string|null{
 if(!value)return value;
 try{
  const answer=JSON.parse(value) as {schema_version?:unknown;action?:unknown;corrected_raw_value?:unknown};
  if(answer.schema_version!=='document-field-answer-v2')return value;
  if(answer.action==='confirm')return 'הערך שמופיע בשאלה אושר כקריאה של התא במסמך.';
  if(answer.action==='correct'&&typeof answer.corrected_raw_value==='string')return `הקריאה תוקנה לערך: ${answer.corrected_raw_value}`;
  if(answer.action==='unknown')return 'לא יודע — הקריאה נשארה לא מאומתת.';
  if(answer.action==='unreadable')return 'התא אינו קריא — נדרש מקור ברור יותר.';
 }catch{/* Historical plain answers remain plain. */}
 return value;
}
