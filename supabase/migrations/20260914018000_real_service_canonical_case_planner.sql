-- Additive migration: correct canonical case selectors without changing authority.
-- Derived from exact installed definitions after 210/211, not rewritten 207/208 files.
-- Fix only text canonical-case selectors by casting the UUID operand to text.
-- CREATE OR REPLACE preserves current signatures, owners, ACLs, and all admission guards.
DO $patch$
DECLARE item record; original_definition text; next_definition text;
BEGIN
 IF (SELECT format_type(a.atttypid,a.atttypmod) FROM pg_attribute a
     WHERE a.attrelid='public.engine_durable_jobs'::regclass AND a.attname='canonical_case_id' AND NOT a.attisdropped) IS DISTINCT FROM 'text'
 THEN RAISE EXCEPTION 'REAL_SERVICE_CANONICAL_CASE_SCHEMA_CHANGED'; END IF;
 FOR item IN SELECT * FROM (VALUES
 ('private.real_service_candidates(text,text,text,jsonb,integer)', 'f58a1a81c0325583fc97ee097d4017bae6ab9e2e2a1b10ab8a392036b7190730', $needle$j.canonical_case_id=c.id and$needle$, $replacement$j.canonical_case_id=c.id::text and$replacement$),
 ('private.real_service_claim_admit(jsonb,text,bigint,text,text,text,text)', '614f5b09dce90ded68b687782acae35de32d79dfeb732662b30b1b77845ea77d', $needle$canonical_case_id=c for update$needle$, $replacement$canonical_case_id=c::text for update$replacement$),
 ('private.real_service_provider_material(uuid,text)', 'a105fd21337010d8c38bca597e359a4575d022764189c13321ffcd9f62f18134', $needle$canonical_case_id=r.case_id for update$needle$, $replacement$canonical_case_id=r.case_id::text for update$replacement$)
 ) AS patches(signature, expected_sha256, old_text, new_text) LOOP
   original_definition := pg_get_functiondef(item.signature::regprocedure);
   IF encode(sha256(convert_to(original_definition,'UTF8')),'hex') IS DISTINCT FROM item.expected_sha256
      OR (length(original_definition)-length(replace(original_definition,item.old_text,'')))/length(item.old_text) <> 1
   THEN RAISE EXCEPTION 'REAL_SERVICE_PLANNER_PATCH_PREIMAGE_CHANGED: %',item.signature; END IF;
   next_definition := replace(original_definition,item.old_text,item.new_text);
   EXECUTE next_definition;
 END LOOP;
END;
$patch$;
