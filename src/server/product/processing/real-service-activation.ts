import 'server-only';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {getCompiledAiReleaseBuild} from './ai-release-build';
import {assertRealServiceActivationContext,realServiceActivationSelectorSchema,realServiceActivationReceiptSchema,type RealServiceActivationSelector} from './real-service-activation-contract';

/** Controller capability is deployment configuration, never request JSON.
 * The SQL controller validates its own role/plan/scope before reading any case.
 * Both RPCs share the provided pinned transaction and current case lock.
 * This adapter never provisions an identity, spends money or grants consent. */
export async function prepareRealServiceActivationEnrollment(context:PostgresTransactionContext,candidate:RealServiceActivationSelector){
 if(process.env.TIVDOC_REAL_AI_SERVICE_ENABLED!=='1'||process.env.TIVDOC_REAL_AI_ENROLLMENT_ENABLED!=='1')throw Error('REAL_ACTIVATION_DISABLED');
 const selector=realServiceActivationSelectorSchema.parse(candidate),build=getCompiledAiReleaseBuild().manifest.sha256;
 const capability=process.env.TIVDOC_REAL_AI_ENROLLMENT_CAPABILITY;
 if(!capability||!/^[A-Za-z0-9._-]{32,256}$/u.test(capability))throw Error('REAL_ACTIVATION_CONTROLLER_UNCONFIGURED');
 const values=[capability,selector.case_id,selector.identity_id,selector.source_revision,selector.source_sha256,selector.plan_sha256,build];
 const loaded=await context.client.query(statement('real_service_activation_context',
  'select private.real_service_activation_context($1,$2::uuid,$3::uuid,$4::integer,$5,$6,$7) value',values));
 if(loaded.row_count!==1)throw Error('REAL_ACTIVATION_CONTEXT_ACK');
 const row=assertRealServiceActivationContext(loaded.rows[0]?.value,selector,build);
 if(row.state==='unavailable')return row;
 const result=await context.client.query(statement('real_service_activation_enroll',
  'select private.real_service_activation_enroll($1,$2::uuid,$3::uuid,$4::integer,$5,$6,$7,$8) value',[...values,row.context_sha256]));
 if(result.row_count!==1)throw Error('REAL_ACTIVATION_ENROLL_ACK');
 const receipt=realServiceActivationReceiptSchema.parse(result.rows[0]?.value);
 if(receipt.state==='unavailable')return receipt;
 if(canonicalSha256(receipt.selector)!==canonicalSha256(selector)||receipt.context_sha256!==row.context_sha256
  ||receipt.purchased_scope_sha256!==row.purchased_scope_sha256||receipt.expires_at!==row.expires_at
  ||row.transition==='replay'&&(receipt.event_id!==row.prior_enrollment?.event_id||!receipt.replayed)
  ||row.transition==='paid_scope_extension'&&(receipt.event_id===row.prior_enrollment?.event_id||receipt.predecessor_event_id!==row.prior_enrollment?.event_id)
  ||row.transition==='initial_enrollment'&&receipt.predecessor_event_id!==null)throw Error('REAL_ACTIVATION_ENROLLMENT_CHANGED');
 return receipt;
}
