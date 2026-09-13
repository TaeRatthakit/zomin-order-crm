-- Atomic, idempotent historical LINE order recovery.
-- Service-role only. Existing rows are not rewritten by this migration.
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
as $$
declare
  v_event jsonb;
  v_debug jsonb;
  v_audit_status text;
  v_existing_order_tenant uuid;
  v_existing_order_id text;
  v_customer_tenant uuid;
  v_customer_updated_at timestamptz;
  v_customer_exists boolean := false;
  v_products jsonb;
  v_products_updated_at timestamptz;
  v_setting_id text;
  v_rows integer := 0;
begin
  if p_tenant_id is null
    or nullif(btrim(p_line_event_id), '') is null
    or nullif(btrim(p_line_message_id), '') is null
    or nullif(btrim(p_original_order_id), '') is null then
    raise exception 'RECOVERY_IDENTIFIERS_REQUIRED';
  end if;

  if nullif(btrim(p_customer->>'id'), '') is null
    or nullif(btrim(p_customer->>'name'), '') is null
    or nullif(btrim(p_customer->>'phone'), '') is null
    or nullif(btrim(p_order->>'id'), '') is null
    or nullif(btrim(p_order->>'customer_id'), '') is null
    or nullif(btrim(p_order->>'order_number'), '') is null
    or nullif(btrim(p_order->>'address'), '') is null
    or nullif(btrim(p_order->>'items'), '') is null
    or nullif(btrim(p_order->>'order_date'), '') is null
    or (p_order->>'quantity')::integer <= 0
    or (p_order->>'amount')::numeric < 0 then
    raise exception 'RECOVERY_PAYLOAD_INCOMPLETE';
  end if;

  if p_order->>'id' <> p_original_order_id
    or p_order->>'customer_id' <> p_customer->>'id' then
    raise exception 'RECOVERY_PAYLOAD_ID_MISMATCH';
  end if;

  if (p_customer ? 'tenant_id' and nullif(p_customer->>'tenant_id', '')::uuid is distinct from p_tenant_id)
    or (p_order ? 'tenant_id' and nullif(p_order->>'tenant_id', '')::uuid is distinct from p_tenant_id) then
    raise exception 'RECOVERY_PAYLOAD_TENANT_MISMATCH';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_line_event_id, 0));

  select raw_event
    into v_event
    from public.line_messages
   where tenant_id = p_tenant_id
     and id = p_line_event_id
   for update;
  if not found then
    raise exception 'RECOVERY_SOURCE_EVENT_NOT_FOUND';
  end if;

  v_debug := coalesce(v_event->'__debug', '{}'::jsonb);
  if lower(coalesce(v_debug->>'processing_status', '')) <> 'replied'
    or nullif(btrim(coalesce(v_debug->>'failure_category', '')), '') is not null
    or coalesce(v_debug->>'reply_text', '') not like '✅ นำเข้าออเดอร์เรียบร้อยแล้ว%'
    or coalesce(v_debug->>'internal_order_id', '') <> p_original_order_id
    or coalesce(v_event#>>'{message,id}', '') <> p_line_message_id then
    raise exception 'RECOVERY_SOURCE_ACK_NOT_AUTHORITATIVE';
  end if;

  select status
    into v_audit_status
    from public.line_order_recovery_audit
   where tenant_id = p_tenant_id
     and line_event_id = p_line_event_id
   for update;

  if v_audit_status = 'recovered' then
    if exists (
      select 1 from public.orders
       where id = p_original_order_id
         and tenant_id = p_tenant_id
    ) then
      return jsonb_build_object(
        'ok', true,
        'status', 'already_recovered',
        'order_id', p_original_order_id,
        'customer_id', p_customer->>'id'
      );
    end if;
    raise exception 'RECOVERY_AUDIT_ORDER_MISMATCH';
  end if;

  insert into public.line_order_recovery_audit (
    tenant_id, line_event_id, line_message_id, original_order_id,
    status, source_snapshot, result, claimed_at, completed_at, updated_at
  ) values (
    p_tenant_id, p_line_event_id, p_line_message_id, p_original_order_id,
    'claimed', p_source_snapshot, jsonb_build_object('source', 'historical_line_recovery'),
    now(), null, now()
  )
  on conflict (tenant_id, line_event_id) do update
    set line_message_id = excluded.line_message_id,
        original_order_id = excluded.original_order_id,
        status = 'claimed',
        source_snapshot = excluded.source_snapshot,
        result = excluded.result,
        claimed_at = now(),
        completed_at = null,
        updated_at = now();

  select tenant_id, id
    into v_existing_order_tenant, v_existing_order_id
    from public.orders
   where id = p_original_order_id
   for update;
  if found then
    if v_existing_order_tenant is distinct from p_tenant_id then
      raise exception 'RECOVERY_ORDER_ID_CROSS_TENANT_CONFLICT';
    end if;
    update public.line_order_recovery_audit
       set status = 'skipped',
           result = jsonb_build_object('reason', 'order_id_exists', 'order_id', v_existing_order_id),
           completed_at = now(),
           updated_at = now()
     where tenant_id = p_tenant_id and line_event_id = p_line_event_id;
    return jsonb_build_object('ok', true, 'status', 'already_exists', 'order_id', v_existing_order_id);
  end if;

  select id
    into v_existing_order_id
    from public.orders
   where tenant_id = p_tenant_id
     and order_number = p_order->>'order_number'
   limit 1
   for update;
  if found then
    update public.line_order_recovery_audit
       set status = 'skipped',
           result = jsonb_build_object('reason', 'order_number_exists', 'order_id', v_existing_order_id),
           completed_at = now(),
           updated_at = now()
     where tenant_id = p_tenant_id and line_event_id = p_line_event_id;
    return jsonb_build_object('ok', true, 'status', 'already_exists', 'order_id', v_existing_order_id);
  end if;

  select tenant_id, updated_at
    into v_customer_tenant, v_customer_updated_at
    from public.customers
   where id = p_customer->>'id'
   for update;
  v_customer_exists := found;
  if v_customer_exists then
    if v_customer_tenant is distinct from p_tenant_id then
      raise exception 'RECOVERY_CUSTOMER_CROSS_TENANT_CONFLICT';
    end if;
    if p_customer_updated_at is null or v_customer_updated_at is distinct from p_customer_updated_at then
      raise exception 'RECOVERY_CUSTOMER_STALE';
    end if;
  elsif p_customer_updated_at is not null then
    raise exception 'RECOVERY_CUSTOMER_STALE';
  end if;

  if p_products_before is not null or p_products_after is not null then
    if p_products_before is null or p_products_after is null or p_products_updated_at is null then
      raise exception 'RECOVERY_PRODUCTS_GUARD_REQUIRED';
    end if;
    select id, value, updated_at
      into v_setting_id, v_products, v_products_updated_at
      from public.settings
     where tenant_id = p_tenant_id
       and key = 'products'
     for update;
    if not found
      or v_products is distinct from p_products_before
      or v_products_updated_at is distinct from p_products_updated_at then
      raise exception 'RECOVERY_PRODUCTS_STALE';
    end if;
  end if;

  insert into public.customers (
    id, tenant_id, name, phone, latest_address, note, assigned_to,
    first_purchase_date, last_purchase_date, purchase_count, total_quantity,
    total_amount, status, vip_level, customer_score, follow_up_date,
    last_contact_date, last_contact_note, created_at, updated_at
  ) values (
    p_customer->>'id', p_tenant_id, p_customer->>'name', p_customer->>'phone',
    coalesce(p_customer->>'latest_address', ''), coalesce(p_customer->>'note', ''),
    nullif(p_customer->>'assigned_to', ''), nullif(p_customer->>'first_purchase_date', '')::date,
    nullif(p_customer->>'last_purchase_date', '')::date,
    coalesce((p_customer->>'purchase_count')::integer, 0),
    coalesce((p_customer->>'total_quantity')::integer, 0),
    coalesce((p_customer->>'total_amount')::numeric, 0),
    coalesce(nullif(p_customer->>'status', ''), 'NORMAL'),
    coalesce(nullif(p_customer->>'vip_level', ''), 'NORMAL'),
    coalesce((p_customer->>'customer_score')::numeric, 0),
    nullif(p_customer->>'follow_up_date', '')::date,
    nullif(p_customer->>'last_contact_date', '')::date,
    coalesce(p_customer->>'last_contact_note', ''), now(), now()
  )
  on conflict (id) do update set
    name = excluded.name,
    phone = excluded.phone,
    latest_address = excluded.latest_address,
    note = excluded.note,
    assigned_to = excluded.assigned_to,
    first_purchase_date = excluded.first_purchase_date,
    last_purchase_date = excluded.last_purchase_date,
    purchase_count = excluded.purchase_count,
    total_quantity = excluded.total_quantity,
    total_amount = excluded.total_amount,
    status = excluded.status,
    vip_level = excluded.vip_level,
    customer_score = excluded.customer_score,
    follow_up_date = excluded.follow_up_date,
    last_contact_date = excluded.last_contact_date,
    last_contact_note = excluded.last_contact_note,
    updated_at = now();

  insert into public.orders (
    id, tenant_id, customer_id, order_number, customer_name, phone, address,
    items, quantity, amount, order_date, order_time, source, source_channel,
    social_name, free_gift, vip_card_status, note, raw_text, created_by,
    created_at, updated_at
  ) values (
    p_order->>'id', p_tenant_id, p_order->>'customer_id', p_order->>'order_number',
    coalesce(p_order->>'customer_name', ''), coalesce(p_order->>'phone', ''),
    coalesce(p_order->>'address', ''), p_order->>'items', (p_order->>'quantity')::integer,
    (p_order->>'amount')::numeric, (p_order->>'order_date')::date,
    nullif(p_order->>'order_time', '')::time, coalesce(p_order->>'source', ''),
    coalesce(p_order->>'source_channel', ''), coalesce(p_order->>'social_name', ''),
    coalesce(p_order->>'free_gift', ''), coalesce(p_order->>'vip_card_status', ''),
    coalesce(p_order->>'note', ''), coalesce(p_order->>'raw_text', ''),
    nullif(p_order->>'created_by', ''), now(), now()
  );

  if p_products_before is not null then
    update public.settings
       set value = p_products_after,
           updated_at = now()
     where id = v_setting_id
       and tenant_id = p_tenant_id
       and key = 'products'
       and value = p_products_before
       and updated_at = p_products_updated_at;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception 'RECOVERY_PRODUCTS_STALE';
    end if;
  end if;

  update public.line_order_recovery_audit
     set status = 'recovered',
         result = jsonb_build_object(
           'source', 'historical_line_recovery',
           'order_id', p_original_order_id,
           'customer_id', p_customer->>'id'
         ),
         completed_at = now(),
         updated_at = now()
   where tenant_id = p_tenant_id
     and line_event_id = p_line_event_id;

  return jsonb_build_object(
    'ok', true,
    'status', 'recovered',
    'order_id', p_original_order_id,
    'customer_id', p_customer->>'id'
  );
end;
$$;

revoke all on function public.recover_historical_line_order(
  uuid, text, text, text, jsonb, jsonb, jsonb, jsonb,
  timestamptz, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.recover_historical_line_order(
  uuid, text, text, text, jsonb, jsonb, jsonb, jsonb,
  timestamptz, timestamptz, jsonb
) to service_role;
