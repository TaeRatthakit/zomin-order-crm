-- Allow an Owner to select any valid package. Entitlements still change only
-- through the existing verified-payment success RPC. Preserve the established
-- checkout function body and replace only its obsolete downgrade rejection.
begin;

do $$
declare
  v_signature regprocedure := 'public.growup_begin_subscription_checkout(uuid,text,text,text,text,text,text)'::regprocedure;
  v_definition text;
  v_guard text := 'if v_target_rank < v_current_rank then raise exception ''SUBSCRIPTION_DOWNGRADE_NOT_ALLOWED''; end if;';
  v_replacement text := '-- Owner-approved package switching permits lower and higher targets.';
begin
  v_definition := pg_get_functiondef(v_signature);
  if length(v_definition) - length(replace(v_definition, v_guard, '')) <> length(v_guard) then
    raise exception 'EXPECTED_SINGLE_SUBSCRIPTION_DOWNGRADE_GUARD_NOT_FOUND';
  end if;
  v_definition := replace(v_definition, v_guard, v_replacement);
  execute v_definition;
end;
$$;

commit;
