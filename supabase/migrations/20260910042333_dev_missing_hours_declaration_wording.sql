-- Hours absent from the document must be declared from independent records,
-- not falsely described as a successful document reading. Existing question
-- and answer histories stay unchanged; this affects newly opened requests.
do $migration$ declare definition text;needle text;begin
 definition:=pg_get_functiondef('private.dev_financial_request_open(uuid,uuid,integer,text)'::regprocedure);
 needle:='לניסוי ההנדסי של יוני 2026 חסר מספר השעות הרגילות במסמך הזה. מה מספר השעות הרגילות המופיע בו? אין לכלול שעות נוספות.';
 if position(needle in definition)=0 then raise exception 'DEV_HOURS_DECLARATION_WORDING_BASE';end if;
 execute replace(definition,needle,'לניסוי ההנדסי של יוני 2026 חסר מספר השעות הרגילות במסמך הזה. לפי רישומי העבודה או המידע שבידיך, כמה שעות רגילות עבדת בחודש? אין לכלול שעות נוספות. התשובה תישמר כהצהרה שלך, ולא כנתון שנקרא מהתלוש.');
end $migration$;
