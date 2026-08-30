import { evaluateLegalReadiness, type LegalReadinessCandidate, type LegalReadinessCase } from "./evaluate-legal-readiness.ts";

export type LegalReadinessDelegate = "diagnostic_cli" | "strict_cli" | "corpus_topic_gate" | "server_resolver_admission" | "future_activation_adapter" | "future_shadow_admission_adapter";
const delegate = (name: LegalReadinessDelegate, readinessCase: LegalReadinessCase, candidates: readonly LegalReadinessCandidate[]) => Object.freeze({ delegate: name, decision: evaluateLegalReadiness({ readinessCase, candidates }) });
export const legalReadinessDiagnostic = (readinessCase: LegalReadinessCase, candidates: readonly LegalReadinessCandidate[]) => ({ ...delegate("diagnostic_cli", readinessCase, candidates), exit_code: 0 as const });
export const legalReadinessStrict = (readinessCase: LegalReadinessCase, candidates: readonly LegalReadinessCandidate[]) => { const result = delegate("strict_cli", readinessCase, candidates); return { ...result, exit_code: result.decision.status === "READY" ? 0 as const : 2 as const }; };
export const legalCorpusTopicGate = (readinessCase: LegalReadinessCase, candidates: readonly LegalReadinessCandidate[]) => delegate("corpus_topic_gate", readinessCase, candidates);
export const legalServerResolverAdmission = (readinessCase: LegalReadinessCase, candidates: readonly LegalReadinessCandidate[]) => delegate("server_resolver_admission", readinessCase, candidates);
export const futureLegalActivationAdmission = (readinessCase: LegalReadinessCase, candidates: readonly LegalReadinessCandidate[]) => delegate("future_activation_adapter", readinessCase, candidates);
export const futureLegalShadowAdmission = (readinessCase: LegalReadinessCase, candidates: readonly LegalReadinessCandidate[]) => delegate("future_shadow_admission_adapter", readinessCase, candidates);
