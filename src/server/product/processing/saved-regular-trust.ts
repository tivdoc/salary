import 'server-only';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {InMemoryReviewerTrustStore,keyPossessionChallengeSchema} from '@/server/platform/trust/reviewer-trust-store';

const at=z.iso.datetime({offset:true});
const actor=z.string().min(3);
const event=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('organization'),at,candidate:z.unknown(),actor}),
 z.object({kind:z.literal('policy'),at,candidate:z.unknown(),actor}),
 z.object({kind:z.literal('reviewer'),at,candidate:z.unknown(),actor}),
 z.object({kind:z.literal('challenge'),at,challenge:keyPossessionChallengeSchema,actor}),
 z.object({kind:z.literal('key'),at,challenge:keyPossessionChallengeSchema,proof_signature_base64:z.string(),rotation_authorization_signature_base64:z.string().optional()}),
 z.object({kind:z.literal('revoke'),at,key_id:z.string(),effective_at:at,reason_code:z.string(),actor}),
]);
export const savedRegularTrustJournalSchema=z.object({schema_version:z.literal('june2026-trust-registry-journal-v1'),
 root_admin_ids:z.array(actor).min(1).max(32),events:z.array(event).min(1).max(10000)}).strict();
export type SavedRegularTrustJournal=z.infer<typeof savedRegularTrustJournalSchema>;

/** Rehydrate the existing verifier from the complete server-owned registry.
 * Historical challenge nonces are public, not signing secrets. Replaying a
 * challenge proves its exact bytes before proof-of-possession verification.
 * Current revocations and latest policies remain effective at admission time. */
export function replaySavedRegularTrust(candidate:unknown,evaluatedAt:string){
 const journal=savedRegularTrustJournalSchema.parse(candidate);at.parse(evaluatedAt);
 let clock=journal.events[0].at,nonce:Uint8Array|null=null;
 const trust=new InMemoryReviewerTrustStore({root_admin_ids:journal.root_admin_ids,clock:()=>clock,
  random_bytes:length=>{if(!nonce||nonce.length!==length)throw Error('REGULAR_TRUST_CHALLENGE_NONCE');return nonce;}});
 for(const item of journal.events){
  if(Date.parse(item.at)<Date.parse(clock)||Date.parse(item.at)>Date.parse(evaluatedAt))throw Error('REGULAR_TRUST_EVENT_TIME');
  clock=item.at;
  switch(item.kind){
   case 'organization':trust.registerOrganization(item.candidate,item.actor);break;
   case 'policy':trust.publishPolicy(item.candidate,item.actor);break;
   case 'reviewer':trust.registerReviewer(item.candidate,item.actor);break;
   case 'challenge':{
    const c=item.challenge;nonce=Buffer.from(c.nonce,'base64url');
    const replayed=trust.issueKeyPossessionChallenge({challenge_id:c.challenge_id,reviewer_id:c.reviewer_id,
     reviewer_identity_version:c.reviewer_identity_version,key_id:c.key_id,public_key_spki_pem:c.public_key_spki_pem,
     valid_from:c.valid_from,expires_at:c.expires_at,replaces_key_id:c.replaces_key_id,actor_id:item.actor});
    nonce=null;if(canonicalSha256(replayed)!==canonicalSha256(c))throw Error('REGULAR_TRUST_CHALLENGE_REPLAY');break;
   }
   case 'key':trust.registerProvenKey(item);break;
   case 'revoke':trust.revokeKey({key_id:item.key_id,effective_at:item.effective_at,reason_code:item.reason_code,actor_id:item.actor});break;
  }
 }
 clock=evaluatedAt;
 if(!trust.verifyAuditChain().valid)throw Error('REGULAR_TRUST_AUDIT_CHAIN');
 return trust;
}
