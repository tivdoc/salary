import {z} from 'zod';
import {MAX_PAYSLIPS,MAX_UPLOAD_SIZE} from './validation';
export const documentCapacitySchema=z.object({
 maxPayslips:z.number().int().min(12).max(600),maxCaseBytes:z.number().int().min(MAX_UPLOAD_SIZE).max(602*10*1024*1024),
 paidMonths:z.array(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)),
 maxBatchFiles:z.literal(14),maxBatchBytes:z.literal(26214400),
}).strict();
export type DocumentCapacity=z.infer<typeof documentCapacitySchema>;
export function documentCapacity(value:unknown):DocumentCapacity{
 return documentCapacitySchema.parse(value??{maxPayslips:MAX_PAYSLIPS,maxCaseBytes:MAX_UPLOAD_SIZE,paidMonths:[],maxBatchFiles:14,maxBatchBytes:MAX_UPLOAD_SIZE});
}
export function uploadMonthOptions(capacity:DocumentCapacity,recent:readonly string[],saved:readonly (string|null)[]){
 return [...new Set([...capacity.paidMonths,...recent,...saved.filter((m):m is string=>m!==null)])].sort().reverse();
}
