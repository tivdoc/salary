import {z} from 'zod';
import {resolveReportOperationsDb,type CaseAccessDb} from '../case-access/db.ts';
import {buildFunnelBoard} from './funnel-dashboard.ts';
const count=z.number().int().nonnegative();
export const metricsSchema=z.object({schema_version:z.literal('tivdoc-metrics-v1'),window:z.object({since:z.string(),until:z.string(),cohort:z.literal('non_qa_cases_created_in_window'),anonymous_population:z.string()}),events:z.array(z.object({event_name:z.string(),cases:count})),counts:z.object({reports:count,automatic_reports:count,reviewed_reports:count,review_seconds_total:count,cases_reviewed:count,cases_with_finding:count,full_reports_purchased:count}),sample:z.object({cases:count,paid_cases:count,published_cases:count,opened_cases:count,qa_cases_excluded:count,review_duration_missing:count}),outcome_dictionary:z.literal('published-topic-semantics-v1'),outcomes:z.record(z.string(),count),processing_cost_minor:z.null(),storage_integrity:z.literal('not_measured')});
export async function liveMetrics(db?:CaseAccessDb,until=new Date()){
 const store=db??await resolveReportOperationsDb();if(!store)throw new Error('METRICS_STORE_UNAVAILABLE');
 const since=new Date(until.getTime()-30*86400000);
 const rows=await store.rpc<{value:unknown}>('case_funnel_metrics',{target_since:since.toISOString(),target_until:until.toISOString()});
 const metrics=metricsSchema.parse(rows[0]?.value);const board=buildFunnelBoard(metrics.events,metrics.counts,until);
 return {...board,review_minutes_per_case:metrics.sample.review_duration_missing?null:board.review_minutes_per_case,source:{...board.source,...metrics.window,sample:metrics.sample,outcome_dictionary:metrics.outcome_dictionary,outcomes:metrics.outcomes,processing_cost_minor:null,storage_integrity:metrics.storage_integrity}};
}
