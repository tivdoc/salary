import {nineTopicRuntimeSource} from '../ai-release-runtime/runtime.fixture.ts';
import {enableTypedEntitlementPersonalFacts} from './typed-product-facts.ts';
import {enableSharedPersonalFacts,SHARED_PERSONAL_FACTS_EXPANDED_POLICY} from './shared-product-facts.ts';
import {minimumWageEntitlementInputSchema} from './minimum-wage/contracts.ts';
import {pensionEntitlementInputSchema} from './pension/contracts.ts';
import {travelEntitlementInputSchema} from './travel/contracts.ts';
import {convalescenceEntitlementInputSchema} from './convalescence/contracts.ts';

/** Synthetic normal source only; contains no customer or provider data. */
export function sharedPersonalV3Fixture(){const input=nineTopicRuntimeSource();input.entitlement_evidence=enableTypedEntitlementPersonalFacts(input.entitlement_evidence!,{travel:true,vacation:true,convalescence:true,working_time:true});
 const e=input.entitlement_evidence,m=minimumWageEntitlementInputSchema.parse(e.minimum_wage),p=pensionEntitlementInputSchema.parse(e.pension),t=travelEntitlementInputSchema.parse(e.travel),cv=convalescenceEntitlementInputSchema.parse(e.convalescence);
 m.population={state:'missing',value:null,source:null};p.applicability=p.applicability.filter(d=>d.decision_id!=='pension.general_coverage');t.applicability=t.applicability.filter(d=>d.decision_id!=='travel.general_coverage');cv.population={state:'missing',value:null,source:null};cv.applicability=cv.applicability.filter(d=>d.decision_id!=='cv.population');
 input.entitlement_evidence=enableSharedPersonalFacts({...e,minimum_wage:m,pension:p,travel:t,convalescence:cv},SHARED_PERSONAL_FACTS_EXPANDED_POLICY);return input;
}
