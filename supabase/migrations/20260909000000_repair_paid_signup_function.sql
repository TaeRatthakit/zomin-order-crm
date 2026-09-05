-- Preview-only forward repair for the already-applied paid-first signup RPC.
-- The original migration was applied with one missing NULL value in the
-- subscription INSERT. Repair only the function definition; no data changes.
begin;

do $$
declare
  v_definition text;
  v_count integer;
begin
  select count(*) into v_count
  from pg_proc p
  where p.proname = 'growup_signup_bootstrap' and p.pronargs = 10;
  if v_count <> 1 then
    raise exception 'PAID_SIGNUP_FUNCTION_NOT_FOUND';
  end if;
  select pg_get_functiondef(p.oid)
    into v_definition
  from pg_proc p
  where p.proname = 'growup_signup_bootstrap' and p.pronargs = 10
  limit 1;
  if v_definition is null then
    raise exception 'PAID_SIGNUP_FUNCTION_NOT_FOUND';
  end if;
  if position('null, null, null, v_payment_due_at' in v_definition) = 0 then
    raise exception 'PAID_SIGNUP_FUNCTION_SHAPE_UNEXPECTED';
  end if;
  execute replace(v_definition,
    'null, null, null, v_payment_due_at',
    'null, null, null, null, null, v_payment_due_at');
end;
$$;

commit;
