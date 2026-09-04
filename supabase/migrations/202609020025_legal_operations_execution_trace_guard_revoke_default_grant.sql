-- Fix-forward for 202609020023, and exactly the same mistake 202609020019
-- already fixed once: the trigger guard function
-- private.legal_operations_execution_trace_guard() was created without an
-- explicit revoke, so it kept Postgres's default EXECUTE grant to PUBLIC and
-- was reachable by anon, authenticated and service_role.
--
-- Caught by the SECURITY DEFINER surface matrix, which is what that matrix is
-- for: the function body only raises, so nothing could be achieved by calling
-- it, and no test of behaviour would ever have noticed. A trigger fires without
-- its caller needing EXECUTE, so this removes a grant nothing should have had
-- and changes nothing about the trigger's operation.
--
-- That this is the second occurrence is the more useful finding: writing a
-- trigger guard in this schema without the revoke is evidently easy to do, and
-- the census is the only thing standing between that and a shipped grant.
revoke all on function private.legal_operations_execution_trace_guard()
  from public, anon, authenticated, service_role;
