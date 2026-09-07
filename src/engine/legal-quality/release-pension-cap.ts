/** AI research candidate, isolated from active legal catalog and publication.
 * See docs/legal/pension-cap-ai-decision-20260907.he.md for primary sources,
 * applicability and why the Chapter XV collection freeze is not this cap. */
export const PENSION_CAP_RESEARCH_VERSION='ai.pension.general.cap.2025-2026.v1';
export function researchedPensionCap(month:string){
 if(!/^\d{4}-(0[1-9]|1[0-2])$/u.test(month))return null;
 const year=month.slice(0,4),minor=year==='2025'?1331600:year==='2026'?1376900:null;
 if(minor===null)return null;
 return Object.freeze({parameter_id:'il.pension.mandatory_wage_cap',parameter_version:`${year}.9.7`,
  value:Object.freeze({kind:'money' as const,currency:'ILS',minor_units:minor}),
  valid_from:`${year}-01-01`,valid_to:`${year}-12-31`,decision_version:PENSION_CAP_RESEARCH_VERSION,
  author_kind:'ai' as const,activation_allowed:false as const,human_attestation:null});
}
