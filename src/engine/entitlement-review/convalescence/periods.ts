export type ConvalescenceAccrualSlice=Readonly<{segment_id:string;from:string;to:string;employment_year:number;year_from:string;year_to:string;calendar_days:number;year_calendar_days:number;fte:string}>;
const DAY=86400000;
const date=(d:string)=>Date.parse(d+'T00:00:00Z');
const iso=(d:number)=>new Date(d).toISOString().slice(0,10);
export const nextConvalescenceDate=(d:string)=>iso(date(d)+DAY);
export function employmentAnniversary(start:string,years:number){
 if(start.slice(5)==='02-29')throw Error('CONVALESCENCE_LEAP_START_POLICY_REQUIRED');
 return String(Number(start.slice(0,4))+years).padStart(4,'0')+start.slice(4);
}
/** Date arithmetic only. Eligibility and the chosen fraction method remain separate decisions. */
export function splitConvalescenceAccrual(start:string,segments:readonly {id:string;from:string;to:string;fte:string}[]):ConvalescenceAccrualSlice[]{
 const slices:ConvalescenceAccrualSlice[]=[];
 for(const s of segments){
  if(s.from<start||s.to<s.from)throw Error('CONVALESCENCE_ACCRUAL_DATE_RANGE');
  let cursor=s.from;
  while(cursor<=s.to){
   let years=Number(cursor.slice(0,4))-Number(start.slice(0,4));
   if(cursor<employmentAnniversary(start,years))years--;
   const from=employmentAnniversary(start,years),next=employmentAnniversary(start,years+1),yearTo=iso(date(next)-DAY),to=s.to<yearTo?s.to:yearTo;
   slices.push({segment_id:s.id,from:cursor,to,employment_year:years+1,year_from:from,year_to:yearTo,
    calendar_days:(date(to)-date(cursor))/DAY+1,year_calendar_days:(date(next)-date(from))/DAY,fte:s.fte});
   if(slices.length>10)throw Error('CONVALESCENCE_ACCRUAL_RESOURCE_BOUND');
   cursor=nextConvalescenceDate(to);
  }
 }
 return slices;
}
