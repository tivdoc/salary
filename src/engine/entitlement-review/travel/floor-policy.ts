import {canonicalSha256,deepFreeze} from '../../rule-runtime/canonical.ts';
import type {DocumentReviewSource} from '../../document-review/calculations.ts';
import {TRAVEL_CATALOG,TRAVEL_LEGAL_MANIFEST,TRAVEL_SOURCE_REVIEW,TRAVEL_SOURCE_REVIEW_SHA256,isPinnedTravelLegalSource} from './sources.ts';

export const TRAVEL_GENERAL_ORDER_FLOOR_POLICY='travel-general-order-floor-v2' as const;
export const TRAVEL_COLLECTIVE_LAW_SOURCE=deepFreeze({document_id:'il.collective_agreements.original.1957',version_id:'IL_COLLECTIVE_AGREEMENTS_ORIGINAL_1957@review-20260912',file_sha256:'011a91048027ef096a2923a66fcb1747b4a70122d1cda63b06af767e6f5f2a61',page_count:4,url:'https://fs.knesset.gov.il/3/law/3_lsr_208274.pdf'});
/** A source research record is not current-law admission. The original §30
 * and the retained order are exact bytes; the amendment chain still requires
 * an independently admitted, time-bounded interpretation receipt. */
export const TRAVEL_FLOOR_SOURCE_REVIEW=deepFreeze({schema_version:'travel-general-order-floor-source-review-v2',reviewed_at:'2026-09-12',reviewer_kind:'ai_source_research',human_attestation:null,real_activation_allowed:false,
 parent_source_review_sha256:TRAVEL_SOURCE_REVIEW_SHA256,source:TRAVEL_COLLECTIVE_LAW_SOURCE,supported_period:TRAVEL_SOURCE_REVIEW.supported_period,
 original_law_locator:{page:3,section:'30(a)-(b)'},amendment_currentness:'not_established_by_original_bytes',
 currentness_index:{url:'https://main.knesset.gov.il/apps/legislation/main/laws/2000459',observed_latest_amendment:12,published_on:'2026-03-24',complete_amendment_chain_verified:false},
 interpretation:'general_order_minimum_preserving_better_individual_or_collective_terms',requires_current_source_and_interpretation_admission:true,
 complete_arrangement_compliance_assessed:false,zero_difference_establishes_compliance:false,existing_route_fare_ticket_and_one_direction_conditions_preserved:true});
export const TRAVEL_FLOOR_SOURCE_REVIEW_SHA256=canonicalSha256(TRAVEL_FLOOR_SOURCE_REVIEW);
export const TRAVEL_FLOOR_LEGAL_MANIFEST=deepFreeze([...TRAVEL_LEGAL_MANIFEST,{document_id:TRAVEL_COLLECTIVE_LAW_SOURCE.document_id,version_id:TRAVEL_COLLECTIVE_LAW_SOURCE.version_id,file_sha256:TRAVEL_COLLECTIVE_LAW_SOURCE.file_sha256,page_count:TRAVEL_COLLECTIVE_LAW_SOURCE.page_count,kind:'legal_source' as const,case_id:null}]);
export const TRAVEL_FLOOR_CATALOG=deepFreeze({...TRAVEL_CATALOG,catalog_version:'2.0.0',rule_version:'2.0.0',source_review_sha256:TRAVEL_FLOOR_SOURCE_REVIEW_SHA256,calculation_policy:TRAVEL_GENERAL_ORDER_FLOOR_POLICY});
export function travelFloorLegalSource(locator:string):DocumentReviewSource{const s=TRAVEL_COLLECTIVE_LAW_SOURCE;return {document_id:s.document_id,version_id:s.version_id,file_sha256:s.file_sha256,page:3,locator,label:'חוק הסכמים קיבוציים — סעיף 30 בנוסח המקורי',reading:'source_research',reading_receipt_sha256:TRAVEL_FLOOR_SOURCE_REVIEW_SHA256};}
export function isPinnedTravelFloorLegalSource(s:DocumentReviewSource){return isPinnedTravelLegalSource(s)||s.document_id===TRAVEL_COLLECTIVE_LAW_SOURCE.document_id&&s.version_id===TRAVEL_COLLECTIVE_LAW_SOURCE.version_id&&s.file_sha256===TRAVEL_COLLECTIVE_LAW_SOURCE.file_sha256&&s.page===3&&s.reading==='source_research'&&s.reading_receipt_sha256===TRAVEL_FLOOR_SOURCE_REVIEW_SHA256;}
