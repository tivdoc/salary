import 'server-only';
import {z} from 'zod';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {realServiceNotificationPolicySchema} from './real-service-notification-policy';

/** Explicit operator registration only; never imported by a customer worker.
 * The supplied transaction must come from the existing guarded admin connector.
 * SQL authenticates evidence, target, plan/decision and immutable successor CAS.
 * Retry uses the exact reviewed JSON; this function never seals or renews it. */
export async function registerRealServiceNotificationPolicy(context:PostgresTransactionContext,candidate:unknown,predecessor:unknown){
 const policy=realServiceNotificationPolicySchema.parse(candidate),prior=z.string().regex(/^[a-f0-9]{64}$/u).nullable().parse(predecessor);
 if(policy.predecessor_policy_sha256!==prior)throw Error('REAL_NOTIFICATION_POLICY_PREDECESSOR');
 const identity=await context.client.query(statement('real_notification_policy_operator',
  'select session_user as session_user,current_user as current_user',[]));
 if(identity.row_count!==1||identity.rows[0]?.session_user!=='tivdoc_dev_migrator'||identity.rows[0]?.current_user!=='tivdoc_dev_migrator')
  throw Error('REAL_NOTIFICATION_POLICY_OPERATOR_REQUIRED');
 const registered=await context.client.query(statement('real_notification_policy_register',
  'select private.real_ai_service_notification_policy_register($1::jsonb,$2::text) value',[JSON.stringify(policy),prior]));
 if(registered.row_count!==1||registered.rows[0]?.value!==policy.sha256)throw Error('REAL_NOTIFICATION_POLICY_REGISTER_ACK');
 return {policy_sha256:policy.sha256,predecessor_policy_sha256:prior};
}
