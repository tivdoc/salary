import type {DocumentReviewInput} from '../document-review/contracts.ts';
import type {ReviewCompletionNeed} from '../document-review/completions.ts';
import type {EntitlementComposition} from './contracts.ts';
export type EntitlementAnswerTarget=Readonly<{fact_key:string;input_path:string;branch:'pension'|'working_time'|'travel'|'minimum_wage'|'vacation'|'convalescence'|'obligations';index:number|null;
 value_kind:'boolean'|'date'|'date_or_ongoing'|'text';}>;
export type EntitlementBranchReview={
 checks:DocumentReviewInput['checks'];gaps:DocumentReviewInput['coverage_gaps'];
 needs:ReviewCompletionNeed[];answer_targets:EntitlementAnswerTarget[];
 selections:EntitlementComposition['selections'];
 nonmonetary_outcomes?:EntitlementComposition['nonmonetary_outcomes'];
};
