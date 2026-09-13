// Synthetic historical-order fixture. No production caller imports this module.
import {offerSnapshot} from '../contracts.ts';
import {canonicalSha256} from '../../../../engine/rule-runtime/canonical.ts';
import {SLA_BUDGET_MS} from '../../reports/business-clock.ts';
export function legacyFullOfferFixture(){
 const {sha256:discarded,...initial}=offerSnapshot('initial');void discarded;
 const offer={...initial,terms_version:'2026-08-22',kind:'full' as const,amount_minor:14900,maximum_checked_topics:7,human_review_required:true,sla:{...initial.sla,automatic_ms:null,human_ms:SLA_BUDGET_MS.full_human}};
 return {...offer,sha256:canonicalSha256(offer)};
}
