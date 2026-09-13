import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import type {PersistedCaseAnalysisRun} from '@/engine/case-analysis/contracts';
import type {SourceJob} from './source-dispatch';

/** A transaction capability, independent of extraction/provider implementation. */
export type SavedWorkerTransactions=<T>(operation:(context:PostgresTransactionContext)=>Promise<T>)=>Promise<T>;
/** The ordinary completed-run shape, not a dependency on the worker executable. */
export type SavedMonthCompletion=(input:{context:PostgresTransactionContext;job:SourceJob;orderId:string;month:string;parent:PersistedCaseAnalysisRun})=>Promise<void>;
