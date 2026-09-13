import {CORPUS_LIFECYCLE} from '../wave23/corpus-trust/lifecycle.ts';
import {frozen,legalOperationsSha256} from './canonical.ts';

/** Immutable real-catalog identity, shared with historical mixed-mode catalogs.
 * Kept independent of synthetic fixtures so real source readers can pin exactly
 * the same historical payload without loading a synthetic implementation. */
export const REAL_CATALOG_BOUNDARY=frozen({
 catalog_id:'tivdoc.real.inactive.catalog',catalog_version:'1.0.0',compile_time_mode:'real' as const,
 active_sources:0 as const,active_parameters:0 as const,active_rules:0 as const,
});
export const REAL_CATALOG_SHA256=legalOperationsSha256({boundary:REAL_CATALOG_BOUNDARY,
 sources:CORPUS_LIFECYCLE.map(entry=>({source_version_id:entry.source_version_id,topic:entry.topic,
  technical_parse_status:entry.technical_parse_status,instrument_boundary_status:entry.instrument_boundary_status,activation_status:entry.activation_status})),
});
