import {canonicalSha256,deepFreeze} from '../../rule-runtime/canonical.ts';
export const OBLIGATIONS_POLICY=deepFreeze({schema_version:'explicit-obligations-policy-v1',supported_period:{from:'2026-05-01',to:'2026-07-31'},
 expression_kinds:['fixed','linear'],condition_mode:'all',rounding_candidate:'half_up_final_agora',
 agreement_binding_from_ocr:false,unfulfilled_condition_creates_zero_cash_claim:false,duplicate_clause_or_payment_counted_twice:false,
 source_basis:'case_specific_explicit_source_clause_not_statutory_rate',
 interpretation_research:{url:'https://fs.knesset.gov.il/25/law/25_lsr_10622519.pdf',publication:'ספר החוקים 3481, 7.1.2026',locators:['amendment 3 section 1: Contracts Law 25(a)(4), employment contracts and circumstances','section 2: contract made or renewed after commencement'],
  applied_to_all_2026_reports:false,legal_notice:'Report period is not the agreement formation or renewal date. Literal extraction is not a binding-agreement determination.'},
 human_attestation:null,real_activation_allowed:false});
export const OBLIGATIONS_POLICY_SHA256=canonicalSha256(OBLIGATIONS_POLICY);
export const OBLIGATIONS_CATALOG=deepFreeze({catalog_id:'il.review.explicit_obligations.2026',catalog_version:'1.0.0',topics:['contract','bonuses'] as const,rule_version:'1.0.0',rule_schema_version:'tivdoc-rulespec-v0.6.1',interpreter:'executeRuleSpec',source_review_sha256:OBLIGATIONS_POLICY_SHA256,supported_period:OBLIGATIONS_POLICY.supported_period,human_attestation:null,real_activation_allowed:false});
// No invented public legal-source document is substituted for a customer clause.
// Clause versions are ordinary case-document RuleSpec sources. Research above
// describes a dependency; it is not a statutory money parameter or approval.
export const OBLIGATIONS_LEGAL_MANIFEST=Object.freeze([]);
export const OBLIGATION_ASSESSMENTS=deepFreeze({
 'obligation.clause_interpretation':'נדרשת קריאה מזוהה של התחייבות כספית מפורשת, יחידותיה ומשמעותה בהקשר הסעיף. נוסחה שחולצה אינה אישור להסכמה מחייבת.',
 'obligation.agreement_binding':'יש לבחון שהמסמך וההתחייבות מחייבים בין הצדדים, לרבות גרסאות, תיקונים ונסיבות רלוונטיות; אין להסיק זאת מעצם OCR או חתימה שנראית בתמונה.',
 'obligation.payment_scope':'יש לקשור את ההתחייבות לתקופת התשלום הנבדקת ולמועד החיוב, בלי פרורציה או הישנות שהומצאו.',
 'obligation.complete_conditions':'יש לוודא שהרשימה כוללת את כל התנאים הרלוונטיים ושמשמעותם היא שכולם נדרשים. חלופות, שיקול דעת או תנאי נסתר אינם התחייבות אוטומטית.',
 'obligation.rounding':'החישוב המועמד משתמש בעיגול חצי כלפי מעלה באגורה הסופית. יש לזהות הוראת עיגול אחרת אם קיימת.',
});
