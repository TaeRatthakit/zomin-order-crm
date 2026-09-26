-- Fix false rejections for valid legacy/imported order deletes.
-- The explicit delete intent, tenant check, audit, and trigger remain unchanged.
-- Customer aggregate values are derived from authoritative tenant rows inside
-- the same transaction instead of trusting a browser/server projection.

create or replace function public.delete_order_with_confirmed_intent(
  p_order_id text,
  p_tenant_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_session_fingerprint text,
  p_intent_id uuid,
  p_intent_hash text,
  p_customer_after jsonb,
  p_products_after jsonb,
  p_inventory_effect jsonb,
  p_request_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent public.order_delete_intents%rowtype;
  v_order public.orders%rowtype;
  v_customer public.customers%rowtype;
  v_products_setting public.settings%rowtype;
  v_product_before jsonb;
  v_product_after jsonb;
  v_product_id text;
  v_product_name text;
  v_inventory_applied boolean;
  v_quantity numeric;
  v_stock_before numeric;
  v_stock_after numeric;
  v_remaining_count integer;
  v_remaining_quantity integer;
  v_remaining_amount numeric;
  v_first_purchase date;
  v_last_purchase date;
  v_audit_id uuid;
  v_deleted_count integer;
  v_updated_count integer;
  v_metadata jsonb;
begin
  if nullif(pg_catalog.btrim(p_order_id), '') is null
     or p_tenant_id is null
     or nullif(pg_catalog.btrim(p_actor_user_id), '') is null
     or p_actor_role not in ('Owner', 'Admin', 'Staff')
     or p_session_fingerprint !~ '^[0-9a-f]{64}$'
     or p_intent_id is null
     or p_intent_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'ORDER_DELETE_INTENT_INVALID_CONTEXT';
  end if;

  if not exists (
    select 1
    from public.tenant_memberships membership
    where membership.tenant_id = p_tenant_id
      and membership.user_id = p_actor_user_id
      and membership.role = p_actor_role
      and membership.is_active = true
  ) then
    raise exception 'ORDER_DELETE_INTENT_ACTOR_NOT_IN_TENANT';
  end if;

  select intent_row.* into v_intent
  from public.order_delete_intents intent_row
  where intent_row.id = p_intent_id
    and intent_row.tenant_id = p_tenant_id
    and intent_row.order_id = p_order_id
    and intent_row.actor_user_id = p_actor_user_id
    and intent_row.actor_role = p_actor_role
    and intent_row.session_fingerprint = p_session_fingerprint
    and intent_row.intent_hash = p_intent_hash
    and intent_row.proof = 'EXPLICIT_USER_CONFIRMED_DELETE'
    and intent_row.consumed_at is null
    and intent_row.expires_at > clock_timestamp()
  for update;
  if not found then
    raise exception 'ORDER_DELETE_INTENT_INVALID_OR_EXPIRED';
  end if;

  select order_row.* into v_order
  from public.orders order_row
  where order_row.id = p_order_id
    and order_row.tenant_id = p_tenant_id
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- p_customer_after is retained for API compatibility and UI mutation data,
  -- but it is not an authority for deletion. Legacy/imported orders can have
  -- stale customer linkage or normalization in that projection. Lock the
  -- tenant-owned customer and derive all aggregate fields from SQL rows.
  select customer_row.* into v_customer
  from public.customers customer_row
  where customer_row.tenant_id = p_tenant_id
    and customer_row.id = v_order.customer_id
  for update;
  if not found then
    raise exception 'ORDER_DELETE_CUSTOMER_UPDATE_FAILED';
  end if;

  select
    pg_catalog.count(*)::integer,
    coalesce(pg_catalog.sum(order_row.quantity), 0)::integer,
    coalesce(pg_catalog.sum(order_row.amount), 0),
    pg_catalog.min(order_row.order_date),
    pg_catalog.max(order_row.order_date)
  into v_remaining_count, v_remaining_quantity, v_remaining_amount, v_first_purchase, v_last_purchase
  from public.orders order_row
  where order_row.tenant_id = p_tenant_id
    and order_row.customer_id = v_order.customer_id
    and order_row.id <> v_order.id;

  v_inventory_applied := coalesce((p_inventory_effect->>'applied')::boolean, false);
  if v_inventory_applied then
    if pg_catalog.jsonb_typeof(p_products_after) <> 'array' then
      raise exception 'ORDER_DELETE_PRODUCTS_AFTER_REQUIRED';
    end if;
    v_product_id := coalesce(p_inventory_effect->>'product_id', '');
    v_product_name := coalesce(p_inventory_effect->>'product_name', '');
    v_quantity := coalesce((p_inventory_effect->>'quantity')::numeric, 0);
    v_stock_before := (p_inventory_effect->>'stock_before')::numeric;
    v_stock_after := (p_inventory_effect->>'stock_after')::numeric;
    if v_quantity <= 0 or v_stock_after is distinct from (v_stock_before + v_quantity) then
      raise exception 'ORDER_DELETE_INVENTORY_EFFECT_INVALID';
    end if;

    select setting_row.* into v_products_setting
    from public.settings setting_row
    where setting_row.tenant_id = p_tenant_id and setting_row.key = 'products'
    for update;
    if not found or pg_catalog.jsonb_typeof(v_products_setting.value) <> 'array' then
      raise exception 'ORDER_DELETE_PRODUCTS_SETTING_NOT_FOUND';
    end if;
    select product into v_product_before
    from pg_catalog.jsonb_array_elements(v_products_setting.value) product
    where (v_product_id <> '' and product->>'id' = v_product_id)
       or (v_product_id = '' and pg_catalog.lower(pg_catalog.btrim(product->>'name')) = pg_catalog.lower(pg_catalog.btrim(v_product_name)))
    limit 1;
    select product into v_product_after
    from pg_catalog.jsonb_array_elements(p_products_after) product
    where (v_product_id <> '' and product->>'id' = v_product_id)
       or (v_product_id = '' and pg_catalog.lower(pg_catalog.btrim(product->>'name')) = pg_catalog.lower(pg_catalog.btrim(v_product_name)))
    limit 1;
    if v_product_before is null or v_product_after is null
       or coalesce((v_product_before->>'stockQuantity')::numeric, 0) is distinct from v_stock_before
       or coalesce((v_product_after->>'stockQuantity')::numeric, 0) is distinct from v_stock_after then
      raise exception 'ORDER_DELETE_INVENTORY_EFFECT_MISMATCH';
    end if;

    update public.settings
    set value = p_products_after, updated_at = clock_timestamp()
    where tenant_id = p_tenant_id and key = 'products';
    get diagnostics v_updated_count = row_count;
    if v_updated_count <> 1 then raise exception 'ORDER_DELETE_PRODUCTS_UPDATE_FAILED'; end if;
  elsif p_products_after is not null then
    raise exception 'ORDER_DELETE_UNEXPECTED_PRODUCTS_AFTER';
  end if;

  update public.customers
  set first_purchase_date = v_first_purchase,
      last_purchase_date = v_last_purchase,
      purchase_count = v_remaining_count,
      total_quantity = v_remaining_quantity,
      total_amount = v_remaining_amount,
      updated_at = clock_timestamp()
  where tenant_id = p_tenant_id and id = v_customer.id;
  get diagnostics v_updated_count = row_count;
  if v_updated_count <> 1 then raise exception 'ORDER_DELETE_CUSTOMER_UPDATE_FAILED'; end if;

  update public.order_delete_intents
  set consumed_at = clock_timestamp(), consumed_transaction_id = pg_catalog.txid_current()
  where id = v_intent.id and consumed_at is null and expires_at > clock_timestamp();
  get diagnostics v_updated_count = row_count;
  if v_updated_count <> 1 then raise exception 'ORDER_DELETE_INTENT_CONSUME_FAILED'; end if;

  v_metadata := pg_catalog.jsonb_build_object(
    'route', case when pg_catalog.jsonb_typeof(coalesce(p_request_metadata, '{}'::jsonb)) = 'object'
      then nullif(pg_catalog.left(coalesce(p_request_metadata->>'route', ''), 200), '') else null end,
    'method', 'DELETE',
    'source', 'explicit_user_confirmed_delete',
    'deletion_proof', 'EXPLICIT_USER_CONFIRMED_DELETE',
    'request_id', case when pg_catalog.jsonb_typeof(coalesce(p_request_metadata, '{}'::jsonb)) = 'object'
      then nullif(pg_catalog.left(coalesce(p_request_metadata->>'request_id', ''), 160), '') else null end,
    'user_agent', case when pg_catalog.jsonb_typeof(coalesce(p_request_metadata, '{}'::jsonb)) = 'object'
      then nullif(pg_catalog.left(coalesce(p_request_metadata->>'user_agent', ''), 240), '') else null end,
    'intent_created_at', v_intent.created_at,
    'intent_consumed_at', clock_timestamp()
  );

  insert into public.order_deletion_audit (
    order_id, tenant_id, actor_user_id, actor_role, action,
    deleted_at, order_snapshot, request_metadata,
    delete_intent_id, deletion_proof, inventory_effect
  ) values (
    v_order.id, v_order.tenant_id, p_actor_user_id, p_actor_role,
    'order_delete', clock_timestamp(), to_jsonb(v_order), pg_catalog.jsonb_strip_nulls(v_metadata),
    v_intent.id, 'EXPLICIT_USER_CONFIRMED_DELETE', coalesce(p_inventory_effect, '{}'::jsonb)
  ) returning id into v_audit_id;

  delete from public.orders where id = v_order.id and tenant_id = p_tenant_id;
  get diagnostics v_deleted_count = row_count;
  if v_deleted_count <> 1 then raise exception 'ORDER_DELETE_COMMIT_FAILED'; end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'audit_id', v_audit_id,
    'intent_id', v_intent.id,
    'order_id', v_order.id,
    'tenant_id', v_order.tenant_id,
    'deletion_proof', 'EXPLICIT_USER_CONFIRMED_DELETE'
  );
end;
$$;

revoke all on function public.delete_order_with_confirmed_intent(text, uuid, text, text, text, uuid, text, jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.delete_order_with_confirmed_intent(text, uuid, text, text, text, uuid, text, jsonb, jsonb, jsonb, jsonb)
  to service_role;
