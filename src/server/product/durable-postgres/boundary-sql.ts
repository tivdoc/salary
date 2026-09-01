import { statement, type PostgresParameter, type PostgresStatement } from "../../platform/persistence/postgres/contracts.ts";

const SQL = Object.freeze({
  identityRead: "select * from private.product_identity_session_read($1)",
  identityRegister: "select * from private.product_identity_session_register($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz,$8,$9::timestamptz)",
  identityRotate: "select private.product_session_rotate($1,$2,$3,$4,$5::timestamptz) as accepted",
  identityRevoke: "select private.product_session_revoke($1,$2,$3::timestamptz) as accepted",
  ownerBind: "select * from private.product_case_owner_bind($1,$2,$3,$4,$5::timestamptz)",
  ownerLookup: "select * from private.product_owner_lookup($1,$2,$3)",
  ownerRevoke: "select private.product_owner_revoke($1,$2,$3,$4::timestamptz) as accepted",
  privacyAppend: "select * from private.product_privacy_append($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz)",
  reportBind: "select * from private.product_private_report_object_bind($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz)",
  reportApprove: "select private.product_report_object_approve($1,$2,$3,$4) as accepted",
  reportApprovedRead: "select * from private.product_report_object_approved_read($1,$2,$3,$4,$5,$6)",
  reportRevoke: "select private.product_report_object_revoke($1,$2,$3,$4,$5,$6::timestamptz) as accepted",
} as const);

export const DURABLE_BOUNDARY_SQL_TEXT = SQL;

function named(name: string, text: string, values: readonly PostgresParameter[]): PostgresStatement {
  return statement(name, text, values);
}

export const durableBoundaryStatements = Object.freeze({
  identityRead: (sid: string) => named("product_identity_read", SQL.identityRead, [sid]),
  identityRegister: (values: readonly PostgresParameter[]) => named("product_identity_register", SQL.identityRegister, values),
  identityRotate: (values: readonly PostgresParameter[]) => named("product_identity_rotate", SQL.identityRotate, values),
  identityRevoke: (values: readonly PostgresParameter[]) => named("product_identity_revoke", SQL.identityRevoke, values),
  ownerBind: (values: readonly PostgresParameter[]) => named("product_owner_bind", SQL.ownerBind, values),
  ownerLookup: (values: readonly PostgresParameter[]) => named("product_owner_lookup", SQL.ownerLookup, values),
  ownerRevoke: (values: readonly PostgresParameter[]) => named("product_owner_revoke", SQL.ownerRevoke, values),
  privacyAppend: (values: readonly PostgresParameter[]) => named("product_privacy_append", SQL.privacyAppend, values),
  reportBind: (values: readonly PostgresParameter[]) => named("product_report_bind", SQL.reportBind, values),
  reportApprove: (values: readonly PostgresParameter[]) => named("product_report_approve", SQL.reportApprove, values),
  reportApprovedRead: (values: readonly PostgresParameter[]) => named("product_report_read", SQL.reportApprovedRead, values),
  reportRevoke: (values: readonly PostgresParameter[]) => named("product_report_revoke", SQL.reportRevoke, values),
});
