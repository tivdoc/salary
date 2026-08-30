import { frozen, legalOperationsSha256 } from "../../../engine/legal-operations/canonical.ts";
import {
  signedLifecycleActionSchema,
  sourceReviewAttestationSchema,
  parameterAttestationSchema,
  semanticApprovalSchema,
  type LifecycleCommand,
  type SignedLifecycleAction,
} from "../../../engine/legal-operations/contracts.ts";
import { ruleSpecPackageSchema, validateGoldenCaseSet, type GoldenCaseSet } from "../../../engine/legal-operations/rulespec.ts";
import { AppendOnlyLegalOperationsStore, type ImportArtifactCommand } from "../../../engine/legal-operations/state-machine.ts";
import { realCatalogStatusMatrix } from "../../../engine/legal-operations/catalog.ts";

type ImmutableGoldenImport = Readonly<{
  golden_case_set_id: string;
  content_sha256: string;
  revision: number;
  receipt_sha256: string;
}>;

export class LegalOperationsApplicationService {
  readonly #store = new AppendOnlyLegalOperationsStore();
  readonly #goldenCases = new Map<string, GoldenCaseSet>();
  readonly #goldenIdempotency = new Map<string, Readonly<{ command_sha256: string; result: ImmutableGoldenImport }>>();
  readonly #ruleGoldenHashes = new Map<string, string>();
  readonly #importedGoldenHashes = new Set<string>();

  importArtifact(command: ImportArtifactCommand) {
    const result = this.#store.importArtifact(command);
    if (command.artifact_kind === "rule_package") {
      const rule = ruleSpecPackageSchema.parse(command.content);
      this.#ruleGoldenHashes.set(`${command.artifact_id}@${command.artifact_version}`, rule.golden_case_set_sha256);
    }
    return result;
  }
  importSignedSourceDecision(artifactId: string, artifactVersion: string, candidate: unknown) { return this.#store.importSourceAttestation(artifactId, artifactVersion, sourceReviewAttestationSchema.parse(candidate)); }
  importParameterAttestation(artifactId: string, artifactVersion: string, candidate: unknown) { return this.#store.importParameterAttestation(artifactId, artifactVersion, parameterAttestationSchema.parse(candidate)); }
  importRuleOrGoldenApproval(artifactId: string, artifactVersion: string, candidate: unknown) {
    const approval = semanticApprovalSchema.parse(candidate);
    if (approval.approval_kind === "golden_case_outputs" && !this.#importedGoldenHashes.has(approval.artifact_sha256)) throw new Error("GOLDEN_CASE_SET_IMPORT_REQUIRED");
    return this.#store.importSemanticApproval(artifactId, artifactVersion, approval);
  }
  transition(candidate: LifecycleCommand) {
    if (candidate.artifact_kind === "rule_package" && candidate.target_state === "approved") {
      const goldenSha256 = this.#ruleGoldenHashes.get(`${candidate.artifact_id}@${candidate.artifact_version}`);
      if (!goldenSha256 || !this.#importedGoldenHashes.has(goldenSha256)) throw new Error("GOLDEN_CASE_SET_IMPORT_REQUIRED");
    }
    return this.#store.transition(candidate);
  }
  status(artifactId: string, artifactVersion: string) { return this.#store.status(artifactId, artifactVersion); }
  history(artifactId: string, artifactVersion: string) { return this.#store.history(artifactId, artifactVersion); }

  importGoldenCaseSet(candidate: unknown, idempotencyKey: string): Readonly<{ result: ImmutableGoldenImport; idempotent_replay: boolean }> {
    const golden = validateGoldenCaseSet(candidate);
    const commandSha256 = legalOperationsSha256({ idempotency_key: idempotencyKey, golden_case_set: golden });
    const prior = this.#goldenIdempotency.get(idempotencyKey);
    if (prior) {
      if (prior.command_sha256 !== commandSha256) throw new Error("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_GOLDEN_CASE_SET");
      return frozen({ result: prior.result, idempotent_replay: true });
    }
    const existing = this.#goldenCases.get(golden.golden_case_set_id);
    if (existing && existing.content_sha256 !== golden.content_sha256) throw new Error("APPEND_ONLY_GOLDEN_CASE_SET_MUTATION_REJECTED");
    this.#store.importGoldenCaseSet(golden);
    const result = frozen({ golden_case_set_id: golden.golden_case_set_id, content_sha256: golden.content_sha256, revision: 1, receipt_sha256: legalOperationsSha256({ action: "import_golden_case_set", golden_case_set_id: golden.golden_case_set_id, content_sha256: golden.content_sha256 }) });
    this.#goldenCases.set(golden.golden_case_set_id, golden);
    this.#importedGoldenHashes.add(golden.content_sha256);
    this.#goldenIdempotency.set(idempotencyKey, { command_sha256: commandSha256, result });
    return frozen({ result, idempotent_replay: existing !== undefined });
  }

  applySignedLifecycleAction(candidate: unknown) {
    const action = signedLifecycleActionSchema.parse(candidate);
    return this.#store.transition(this.#toCommand(action));
  }

  proposeActivation(candidate: Extract<SignedLifecycleAction, { action: "propose_activation" }>) { return this.applySignedLifecycleAction(candidate); }
  activate(candidate: Extract<SignedLifecycleAction, { action: "activate" }>) { return this.applySignedLifecycleAction(candidate); }
  revoke(candidate: Extract<SignedLifecycleAction, { action: "revoke" }>) { return this.applySignedLifecycleAction(candidate); }
  supersede(candidate: Extract<SignedLifecycleAction, { action: "supersede" }>) { return this.applySignedLifecycleAction(candidate); }

  async strictReadiness() {
    const matrix = await realCatalogStatusMatrix();
    return frozen({ ...matrix, strict_exit_code: matrix.passed && matrix.ready_count === 0 ? 2 : 1 });
  }

  #toCommand(action: SignedLifecycleAction): LifecycleCommand {
    return {
      schema_version: "tivdoc-legal-lifecycle-command-v0.6.0",
      command_id: action.action_id,
      idempotency_key: action.idempotency_key,
      artifact_id: action.artifact_id,
      artifact_version: action.artifact_version,
      artifact_kind: action.artifact_kind,
      expected_state: action.expected_state,
      target_state: action.target_state,
      actor_id: action.actor_id,
      actor_role: action.actor_role,
      occurred_at: action.occurred_at,
      reason: action.reason,
      bound_content_sha256: action.bound_content_sha256,
      bindings: action.bindings,
      action_signature_sha256: action.signature_sha256,
    };
  }
}
