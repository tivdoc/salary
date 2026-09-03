-- Fix-forward for 202609020018: the trigger guard function
-- private.governance_legal_open_decision_guard() was created without an
-- explicit revoke, so it kept Postgres's default EXECUTE grant to PUBLIC —
-- reachable by anon, authenticated and service_role, unlike every other
-- trigger function in this schema (governance_forbid_mutation is revoked
-- explicitly in 202609010004). A trigger fires without needing EXECUTE on
-- its function directly, so revoking here changes nothing about the
-- trigger's own operation; it only removes a grant nothing should have had.
revoke all on function private.governance_legal_open_decision_guard()
  from public, anon, authenticated, service_role;
