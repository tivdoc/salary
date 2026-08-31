import type { PinnedAnalysisDependencies } from "../../../../../engine/case-analysis/contracts";
import { canonicalSha256 } from "../../../../../engine/rule-runtime/canonical";
import type { LegalCatalogSelection } from "../../../../../engine/wave3/contracts";
import { statement, type PostgresTransactionContext } from "../contracts";
import { mapPostgresAnalysisError, PostgresAnalysisError } from "./errors";
import { assertSafeIdentifier, assertSha256, validateSelections } from "./validation";

export type LegalVersionPinKind = "catalog" | "source" | "parameter" | "rulespec" | "code" | "template";

export type LegalVersionPin = Readonly<{
  pin_kind: LegalVersionPinKind;
  version_id: string;
  version_sha256: string;
}>;

export function dependencyPins(
  dependencies: PinnedAnalysisDependencies,
  selections: readonly LegalCatalogSelection[],
): readonly LegalVersionPin[] {
  validateSelections(selections);
  const pins: LegalVersionPin[] = [];
  pins.push({ pin_kind: "catalog", version_id: selections[0]!.catalog_id, version_sha256: dependencies.catalog_sha256 });
  for (const versionId of dependencies.source_version_ids) pins.push(pin("source", versionId));
  for (const versionId of dependencies.parameter_version_ids) pins.push(pin("parameter", versionId));
  for (const versionId of dependencies.rule_spec_versions) pins.push(pin("rulespec", versionId));
  pins.push(pin("code", dependencies.code_version));
  pins.push(pin("template", dependencies.template_version));
  return Object.freeze(pins.sort((left, right) => `${left.pin_kind}:${left.version_id}`.localeCompare(`${right.pin_kind}:${right.version_id}`, "en")));
}

function pin(pinKind: LegalVersionPinKind, versionId: string): LegalVersionPin {
  assertSafeIdentifier(versionId);
  return Object.freeze({
    pin_kind: pinKind,
    version_id: versionId,
    version_sha256: canonicalSha256({ pin_kind: pinKind, version_id: versionId }),
  });
}

export class PostgresLegalPinsRepository {
  constructor(
    private readonly context: PostgresTransactionContext,
    private readonly tenantId: string,
  ) {
    assertSafeIdentifier(tenantId);
  }

  async persist(input: Readonly<{
    case_id: string;
    analysis_run_id: string;
    dependencies: PinnedAnalysisDependencies;
    selections: readonly LegalCatalogSelection[];
  }>): Promise<void> {
    const pins = dependencyPins(input.dependencies, input.selections);
    try {
      for (const entry of pins) {
        const result = await this.context.client.query(statement(
          "analysis_pin_insert",
          `insert into public.engine_legal_version_pins
             (analysis_run_id, tenant_id, case_id, pin_kind, version_id, version_sha256, created_at)
           select ar.id, $1, ecs.case_id, $4, $5, $6, transaction_timestamp()
             from public.analysis_runs ar
             join public.engine_case_state ecs on ecs.case_id = ar.case_id
            where ar.canonical_analysis_run_id = $2
              and ar.canonical_case_id = $3
              and ar.tenant_id = $1
              and ecs.tenant_id = $1
           on conflict (analysis_run_id, pin_kind, version_id) do nothing
           returning version_sha256`,
          [this.tenantId, input.analysis_run_id, input.case_id, entry.pin_kind, entry.version_id, entry.version_sha256],
        ));
        if (result.row_count === 0) {
          const existing = await this.context.client.query(statement(
            "analysis_pin_existing",
            `select p.version_sha256
               from public.engine_legal_version_pins p
               join public.analysis_runs ar on ar.id = p.analysis_run_id
              where ar.canonical_analysis_run_id = $2
                and ar.canonical_case_id = $3
                and ar.tenant_id = $1
                and p.tenant_id = $1
                and p.pin_kind = $4
                and p.version_id = $5`,
            [this.tenantId, input.analysis_run_id, input.case_id, entry.pin_kind, entry.version_id],
          ));
          const actual = existing.rows[0]?.version_sha256;
          if (actual !== entry.version_sha256) throw new PostgresAnalysisError("PINNED_VERSION_UNAVAILABLE");
        }
      }
    } catch (error) {
      mapPostgresAnalysisError(error, "PINNED_VERSION_UNAVAILABLE");
    }
  }

  async assertAvailable(dependencies: PinnedAnalysisDependencies): Promise<void> {
    const expected = [
      { pin_kind: "catalog", version_id: null, version_sha256: dependencies.catalog_sha256 },
      ...dependencies.source_version_ids.map((versionId) => pin("source", versionId)),
      ...dependencies.parameter_version_ids.map((versionId) => pin("parameter", versionId)),
      ...dependencies.rule_spec_versions.map((versionId) => pin("rulespec", versionId)),
      pin("code", dependencies.code_version),
      pin("template", dependencies.template_version),
    ] as const;
    try {
      for (const entry of expected) {
        assertSha256(entry.version_sha256);
        const result = await this.context.client.query(statement(
          "analysis_pin_available",
          `select 1 as available
             from public.engine_legal_version_pins
            where tenant_id = $1
              and pin_kind = $2
              and ($3::text is null or version_id = $3)
              and version_sha256 = $4
            limit 1`,
          [this.tenantId, entry.pin_kind, entry.version_id, entry.version_sha256],
        ));
        if (result.row_count !== 1) throw new PostgresAnalysisError("PINNED_VERSION_UNAVAILABLE");
      }
    } catch (error) {
      mapPostgresAnalysisError(error, "PINNED_VERSION_UNAVAILABLE");
    }
  }
}
