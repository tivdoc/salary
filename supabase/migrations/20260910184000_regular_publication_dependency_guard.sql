-- The direct worker SQL boundary must enforce the same current dependency as
-- the application callback and artifact reader. Historical receipt reads do
-- not insert/update QA and remain unchanged.
do $migration$
declare original text;body text;
begin
 select pg_get_functiondef('private.case_report_current_input()'::regprocedure) into original;
 body:=replace(original,'actual:=p.input_revision;',
  'if p.report_document ? ''execution_authority'' and not private.june2026_regular_publication_current(p.id) then raise exception ''REGULAR_PUBLICATION_DEPENDENCY_SCOPE'';end if; actual:=p.input_revision;');
 if body=original then raise exception 'REGULAR_PUBLICATION_DEPENDENCY_ANCHOR';end if;execute body;
end $migration$;
