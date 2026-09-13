-- Answer-only revisions must not hide the next cell/source until a worker tick.
-- The current journal still pins document, version and SHA; the target must
-- match the newest receipt for that exact source/policy, never an older result.
do $$ declare d text;needle text;begin
 d:=pg_get_functiondef('private.document_field_current(uuid,jsonb)'::regprocedure);
 needle:='c.revision=h.revision';
 if position(needle in d)=0 then raise exception 'NONPAY_CURRENTNESS_BASE_MISMATCH';end if;
 execute replace(d,needle,'c.revision=(select max(latest.revision) from private.case_extraction_checkpoints latest where latest.case_id=d.case_id and latest.version_id=d.version_id and latest.input_sha256=d.content_sha256 and latest.policy_version=''saved-document-evidence-v1'' and latest.revision<=h.revision)');
end;$$;

create function private.document_evidence_money_minor_v2(raw text,normalization_policy text)
returns numeric language plpgsql immutable security invoker set search_path='' as $money$
declare v text;s text;negative boolean:=false;strict_grouping boolean;
 dotpos integer;commapos integer;decimalpos integer:=0;n integer;parts text[];sep text;whole text;fraction text;minor numeric;
begin
 if raw is null or char_length(raw)>6000 or normalization_policy not in ('document-evidence-normalization-v1','document-evidence-normalization-v2') or normalization_policy is null then return null;end if;
 strict_grouping:=normalization_policy='document-evidence-normalization-v2';
 if strict_grouping then v:=normalize(raw,NFKC);else v:=raw;end if;
 v:=regexp_replace(v,$currency$₪|nis|ils|ש["״']?ח$currency$,'','gi');
 v:=normalize(v,NFKC);
 if strict_grouping then
  v:=regexp_replace(v,U&'[\0009-\000d\0020\00a0\1680\2000-\200f\2028-\202e\202f\205f\3000\feff]','','g');
 else
  v:=regexp_replace(v,U&'[\0009-\000d\0020\00a0\1680\2000-\200a\200e\200f\2028-\202e\202f\205f\3000\feff]','','g');
 end if;
 if left(v,1)='(' and right(v,1)=')' then negative:=true;v:=substring(v from 2 for char_length(v)-2);end if;
 if left(v,1)='-' then negative:=true;end if;
 if left(v,1) in ('-','+') then v:=substring(v from 2);end if;
 if not coalesce(v~'^[0-9][0-9.,]*$',false) then return null;end if;
 if strict_grouping and not(v~'^[0-9]+([.,][0-9]+)?$' or v~'^[0-9]{1,3}(,[0-9]{3})+(\.[0-9]+)?$' or v~'^[0-9]{1,3}(\.[0-9]{3})+(,[0-9]+)?$') then return null;end if;
 dotpos:=case when strpos(v,'.')>0 then char_length(v)-strpos(reverse(v),'.')+1 else 0 end;
 commapos:=case when strpos(v,',')>0 then char_length(v)-strpos(reverse(v),',')+1 else 0 end;
 if dotpos>0 and commapos>0 then decimalpos:=greatest(dotpos,commapos);
 elsif dotpos>0 or commapos>0 then
  sep:=case when dotpos>0 then '.' else ',' end;
  parts:=string_to_array(v,sep);n:=cardinality(parts)-1;
  if n=1 then
   if not(char_length(parts[2])=3 and char_length(parts[1]) between 1 and 3) then decimalpos:=greatest(dotpos,commapos);end if;
  elsif exists(select 1 from unnest(parts[2:cardinality(parts)]) p where char_length(p)<>3) then decimalpos:=greatest(dotpos,commapos);
  end if;
 end if;
 s:=case when decimalpos=0 then v else left(v,decimalpos-1) end;
 whole:=replace(replace(s,'.',''),',','');fraction:=case when decimalpos=0 then '' else substring(v from decimalpos+1) end;
 if whole!~'^[0-9]+$' or fraction!~'^[0-9]*$' or char_length(rtrim(fraction,'0'))>2 then return null;end if;
 minor:=whole::numeric*100+left(fraction||'00',2)::numeric;
 if minor>9007199254740991 then return null;end if;
 return case when negative then -minor else minor end;
exception when invalid_text_representation or numeric_value_out_of_range then return null;
end;$money$;
revoke all on function private.document_evidence_money_minor_v2(text,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;


-- Match the parser of the immutable target. Old targets without the new field
-- retain v1 semantics; new v2 targets cannot borrow a v1 checkpoint or vice versa.
do $$ declare d text;needle text;begin
 d:=pg_get_functiondef('private.document_field_current(uuid,jsonb)'::regprocedure);
 needle:='and c.result#>>''{run,result,normalized,declared_document_type}''=d.document_type::text';
 if position(needle in d)=0 then raise exception 'NONPAY_NORMALIZER_CURRENT_BASE_MISMATCH';end if;
 execute replace(d,needle,needle||' and coalesce(target->>''normalization_policy'',''document-evidence-normalization-v1'')=c.result#>>''{run,result,normalized,normalization_policy}'' and coalesce(target->>''normalization_policy'',''document-evidence-normalization-v1'') in (''document-evidence-normalization-v1'',''document-evidence-normalization-v2'')');
 d:=pg_get_functiondef('private.document_evidence_answer_valid(jsonb,text)'::regprocedure);
 needle:='if k=''money'' then return u=''ILS'' and raw~''^[-+]?[0-9]+([.,][0-9]+)?$'';end if;';
 if position(needle in d)=0 then raise exception 'NONPAY_MONEY_BASE_MISMATCH';end if;
 execute replace(d,needle,'if k=''money'' then return u=''ILS'' and private.document_evidence_money_minor_v2(raw,coalesce(target->>''normalization_policy'',''document-evidence-normalization-v1'')) is not null;end if;');
end;$$;
