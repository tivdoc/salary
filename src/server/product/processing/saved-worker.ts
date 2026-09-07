import {createPostgresAnalysisRepositories} from '@/server/platform/persistence/postgres/analysis';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {admitSavedSource} from './saved-admission';
import {runSavedMonthAnalysis} from './saved-analysis';
import type {SourceJob} from './source-dispatch';

/** Worker-only transaction composition. The caller installs its provisioned
 * machine session in the transaction; this rechecks current paid input on retry.
 * Extraction checkpoints must already exist. No external call or job success
 * acknowledgement occurs here, because other purchased months may remain. */
export async function runSavedWorkerMonth(input:{context:PostgresTransactionContext;job:SourceJob;orderId:string;month:string}){
 const {tenantId}=await admitSavedSource(input.context,input.job);
 return runSavedMonthAnalysis({...input,tenantId,analysis:createPostgresAnalysisRepositories(input.context,tenantId)});
}
