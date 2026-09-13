import {JUNE2026_MINIMUM_WAGE_POLICY_SHA256,JUNE2026_SOURCE_SET_SHA256} from '../minimum-wage-june2026/sources.ts';
import {REAL_CATALOG_SHA256} from './real-catalog-fingerprint.ts';
import {legalOperationsSha256} from './canonical.ts';

/** Exact historical June review identity. No catalog implementation or fixture
 * is imported merely to compute saved-month idempotency and source pins. */
export const JUNE2026_REVIEW_CATALOG_SHA256=legalOperationsSha256({
 catalog:'tivdoc.real.june2026.review-candidate',version:'1.0.0',
 inherited_catalog_sha256:REAL_CATALOG_SHA256,source_set_sha256:JUNE2026_SOURCE_SET_SHA256,
 policy_sha256:JUNE2026_MINIMUM_WAGE_POLICY_SHA256,
 review_diagnostic_version:'saved-june2026-review-v5-unadmitted-assessment-packet',
});
