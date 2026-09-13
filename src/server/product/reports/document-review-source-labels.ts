import type {ReviewDocument} from '@/engine/document-review/contracts';
import {isPinnedEntitlementLegalDocument} from '@/engine/entitlement-review/legal-documents';
import {MINIMUM_WAGE_SOURCE_REVIEW} from '@/engine/entitlement-review/minimum-wage/source-policy';

const MINIMUM_WAGE_TITLES = [
 'חוק שכר מינימום — נוסח באתר הביטוח הלאומי',
 'צו הרחבה לקיצור שבוע העבודה (2018) — ילקוט הפרסומים 7732',
 'הודעת שכר מינימום (2026) — ילקוט הפרסומים 14324, עותק באתר התאחדות התעשיינים',
 'טבלת שכר מינימום — הביטוח הלאומי',
] as const;

/** Presentation only. Exact compiled source identity distinguishes law from an
 * uploaded document; a similar label or a null document period proves nothing. */
export function documentReviewSourceLabel(document:ReviewDocument):{label:string;legal:boolean}{
 const legal=isPinnedEntitlementLegalDocument(document,document.case_id);
 if(!legal)return {label:document.label,legal:false};
 const index=MINIMUM_WAGE_SOURCE_REVIEW.sources.findIndex(source=>source.document_id===document.document_id
  &&source.version_id===document.version_id&&source.file_sha256===document.file_sha256);
 return {label:index<0?document.label:MINIMUM_WAGE_TITLES[index],legal:true};
}
