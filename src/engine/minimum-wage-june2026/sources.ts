import { frozen, legalOperationsSha256 } from '../legal-operations/canonical.ts';

/** Reacquired bytes, not reviewer attestations. The notice is a reproduction of
 * the primary Gazette document on an employers association's site; that
 * provenance is deliberately distinct from an official-origin download. */
export const JUNE2026_MINIMUM_WAGE_SOURCES = frozen([
  {
    source_id: 'IL_MIN_WAGE_LAW',
    source_version_id: 'IL_MIN_WAGE_LAW@20260909.4674f07928a2',
    role: 'primary_binding' as const,
    file: 'minimum-wage-law-nii.pdf',
    url: 'https://www.btl.gov.il/Laws1/00_0021_000000.pdf',
    artifact_sha256: '4674f07928a2397b626db362c6c9b98b7c4e77e693e397463fdabd83c7f4f161',
    parsed_sha256: '78c56ddc92a3c91725376e27bd06cb769bf9660899c82f7dc26873adb89401d8',
    origin: 'official_consolidated_copy',
    locators: ['PDF p1: sections 1, 2(a)-(c), 3(a)-(b),(d)', 'PDF p2: section 6(1), footnote 4; YP14324 p4496'],
    interval: {from: '2026-06-01', to: '2026-06-30'},
  },
  {
    source_id: 'IL_WORKWEEK_ORDER_2018',
    source_version_id: 'IL_WORKWEEK_ORDER_2018@20260909.d99d1f420b84',
    role: 'primary_binding' as const,
    file: 'workweek-order-yalkut-7732-osh.pdf',
    url: 'https://www.osh.org.il/UploadedImages/03_2018/yp_7732.pdf',
    artifact_sha256: 'd99d1f420b8427f9734da2252791b0937478810a56ffd09939b39908cdd23787',
    parsed_sha256: 'f795acf90318c6f33d12099741295b14a4667cd29285b356621d112ab6263aed',
    origin: 'primary_gazette_copy_statutory_osh_institution',
    locators: ['PDF p2 / printed6284: title, all-employees extension, commencement, sunset, 2.1', 'PDF p3 / printed6285: 2.8, 2.9, 2.10, 2.12'],
    interval: {from: '2018-04-01', to: null},
  },
  {
    source_id: 'IL_MIN_WAGE_NOTICE_2026',
    source_version_id: 'IL_MIN_WAGE_NOTICE_2026@20260909.65af7940d69a',
    role: 'primary_binding' as const,
    file: 'minimum-wage-notice-yalkut-14324-industry.pdf',
    url: 'https://industry.org.il/files/work/jpg/%D7%99%D7%9C%D7%A7%D7%95%D7%985_3.pdf',
    artifact_sha256: '65af7940d69a7c1ea96ae9008d44132a140866010f281ac49fc5779f61bdb679',
    parsed_sha256: '80907fa359f8668d4d3d95ab8e0d8253102d77f502cec90d0c7849637fedbf63',
    origin: 'primary_document_republished_nonofficial_host_authenticity_unattested',
    locators: ['PDF p2 / printed4496, right-column bottom continuing left-column top: notice under Minimum Wage Law 6(1), signed3March2026'],
    interval: {from: '2026-04-01', to: null},
  },
  {
    source_id: 'IL_MIN_WAGE_OFFICIAL_RATES',
    source_version_id: 'IL_MIN_WAGE_OFFICIAL_RATES@20260909.63bb67d11d02',
    role: 'official_implementation' as const,
    file: 'minimum-wage-rates-nii.html',
    url: 'https://www.btl.gov.il/Mediniyut/GeneralData/Pages/%D7%A9%D7%9B%D7%A8%20%D7%9E%D7%99%D7%A0%D7%99%D7%9E%D7%95%D7%9D.aspx',
    artifact_sha256: '63bb67d11d02ae1377d3979a5028303c9905900c998106263570046cecc5edb2',
    parsed_sha256: null,
    origin: 'official_rate_table_corroboration_only',
    locators: ['HTML main-content adult rates, effective1April2026: monthly6443.85; hourly182=35.4; hourly186=34.64'],
    interval: {from: '2026-04-01', to: null},
  },
].map(source => ({...source, byte_acquisition_verified: true, human_reviewed: false, activation_state: 'inactive' as const})));

export const JUNE2026_SOURCE_SET_SHA256 = legalOperationsSha256(JUNE2026_MINIMUM_WAGE_SOURCES);
export const JUNE2026_MINIMUM_WAGE_POLICY = frozen({
  schema_version: 'tivdoc-june2026-minimum-wage-candidate-policy-v1',
  period: {start_date: '2026-06-01', end_date: '2026-06-30'},
  sector: 'general_private', population: 'adult_general',
  monthly_minimum_minor: 644385, divisor: 182,
  calculation: 'monthly_minimum_times_regular_hours_divided_by_182',
  rounding: 'half_up_at_final_agora_only',
  published_hourly_corroboration_minor: 3540,
  published_hourly_is_not_intermediate_operand: true,
  source_set_sha256: JUNE2026_SOURCE_SET_SHA256,
  included_components: ['base_salary', 'cost_of_living', 'fixed_work_supplement'],
  excluded_components: ['seniority', 'family', 'shift_premium', 'productivity_premium', 'thirteenth_salary', 'annual_bonus', 'expense_reimbursement', 'overtime', 'weekly_rest', 'paid_absence'],
  maximum_components: 32, maximum_regular_hours: 182,
  scope_semantics: 'ordinary_hours_and_documented_eligible_pay_only_not_total_employer_debt',
  missing_operative_rounding_instruction: true,
  notice_original_origin_authenticity_attested: false,
  ai_interpretation: true, human_attestations: [],
  activationAllowed: false, pricingAllowed: false,
});
export const JUNE2026_MINIMUM_WAGE_POLICY_SHA256 = legalOperationsSha256(JUNE2026_MINIMUM_WAGE_POLICY);
