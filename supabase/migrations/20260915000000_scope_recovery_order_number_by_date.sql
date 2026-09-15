-- Scope the historical-recovery duplicate guard to the business date.
-- Daily order numbers are intentionally reused on other dates, so a tenant-wide
-- order-number match can incorrectly suppress a genuinely missing order.

do $migration$
declare
  v_body text;
  v_old text := 'and order_number = p_order->>''order_number''';
  v_new text := 'and order_number = p_order->>''order_number''' || E'\n     and order_date = (p_order->>''order_date'')::date';
  v_old_count integer;
begin
  select p.prosrc
    into v_body
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.oid = 'public.recover_historical_line_order(uuid,text,text,text,jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz,jsonb)'::regprocedure;

  if not found then
    raise exception 'RECOVERY_FUNCTION_NOT_FOUND';
  end if;

  if position(v_new in v_body) > 0 then
    null;
  else
    v_old_count := (length(v_body) - length(replace(v_body, v_old, ''))) / length(v_old);
    if v_old_count <> 1 then
      raise exception 'RECOVERY_ORDER_NUMBER_GUARD_UNEXPECTED';
    end if;

    v_body := replace(v_body, v_old, v_new);
    execute format($sql$
      create or replace function public.recover_historical_line_order(
        p_tenant_id uuid,
        p_line_event_id text,
        p_line_message_id text,
        p_original_order_id text,
        p_customer jsonb,
        p_order jsonb,
        p_products_before jsonb,
        p_products_after jsonb,
        p_products_updated_at timestamptz,
        p_customer_updated_at timestamptz,
        p_source_snapshot jsonb
      )
      returns jsonb
      language plpgsql
      security definer
      set search_path = public, pg_temp
      as %L
    $sql$, v_body);
  end if;

  select p.prosrc
    into v_body
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.oid = 'public.recover_historical_line_order(uuid,text,text,text,jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz,jsonb)'::regprocedure;

  if position(v_new in v_body) = 0 then
    raise exception 'RECOVERY_ORDER_NUMBER_DATE_GUARD_NOT_INSTALLED';
  end if;
end;
$migration$;

revoke all on function public.recover_historical_line_order(
  uuid, text, text, text, jsonb, jsonb, jsonb, jsonb,
  timestamptz, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.recover_historical_line_order(
  uuid, text, text, text, jsonb, jsonb, jsonb, jsonb,
  timestamptz, timestamptz, jsonb
) to service_role;
