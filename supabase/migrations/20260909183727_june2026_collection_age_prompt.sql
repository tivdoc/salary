-- Include a person whose eighteenth birthday is on June1. The question must
-- exactly match the TypeScript declaration contract. Never rewrite an answer.
do $migration$ declare definition text;needle text;begin
 definition:=pg_get_functiondef('private.june2026_collection_question(jsonb)'::regprocedure);
 needle:='האם מלאו לך 18 לפני 1 ביוני 2026?';
 if position(needle in definition)=0 then raise exception 'JUNE_COLLECTION_AGE_PROMPT_BASE';end if;
 execute replace(definition,needle,'האם ביום 1 ביוני 2026 כבר מלאו לך 18?');
end $migration$;
