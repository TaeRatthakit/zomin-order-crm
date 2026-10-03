-- Order-create only. Completed operations and all business effects commit together.
-- Rollback plan: stop calling this RPC, revoke its execute grant, and retain the
-- additive table for audit. No existing schema/data must be removed to roll back.
create table public.order_create_operations (
  tenant_id uuid not null references public.tenants(id),
  idempotency_key text not null check (length(idempotency_key) between 1 and 160),
  request_fingerprint text not null check (request_fingerprint ~ '^[a-f0-9]{64}$'),
  actor_user_id text not null,
  order_id text not null,
  completed_at timestamptz not null default now(),
  primary key (tenant_id, idempotency_key)
);
alter table public.order_create_operations enable row level security;
revoke all on public.order_create_operations from public, anon, authenticated;
grant select, insert on public.order_create_operations to service_role;

create function public.growup_create_order_once(
  p_tenant_id uuid, p_actor_user_id text, p_token text, p_fingerprint text,
  p_order jsonb, p_customer jsonb, p_customer_before jsonb,
  p_orders_before jsonb, p_customer_tags_before jsonb,
  p_products_before jsonb, p_products_after jsonb, p_customer_tags jsonb
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_operation public.order_create_operations%rowtype;
  v_customer public.customers%rowtype;
  v_order public.orders%rowtype;
  v_existing jsonb;
  v_products jsonb;
  v_orders jsonb;
  v_tags jsonb;
  v_customer_id text := p_customer->>'id';
begin
  if p_token is null or length(p_token) not between 1 and 160
     or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'ORDER_CREATE_INVALID_TOKEN';
  end if;
  -- Transaction-scoped database lock, never a server/process mutex.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('order-create:' || p_tenant_id::text, 0));
  if not exists (select 1 from public.tenants where id = p_tenant_id and status = 'active')
     or not exists (select 1 from public.users where id = p_actor_user_id and is_active = true)
     or not exists (select 1 from public.tenant_memberships
                    where tenant_id = p_tenant_id and user_id = p_actor_user_id and is_active = true) then
    raise exception 'ORDER_CREATE_FORBIDDEN';
  end if;
  select * into v_operation from public.order_create_operations
    where tenant_id = p_tenant_id and idempotency_key = p_token;
  if found then
    if v_operation.request_fingerprint <> p_fingerprint then
      raise exception 'ORDER_CREATE_TOKEN_CONFLICT';
    end if;
    if not exists (select 1 from public.orders where tenant_id = p_tenant_id and id = v_operation.order_id) then
      raise exception 'ORDER_CREATE_RESULT_REMOVED';
    end if;
    return jsonb_build_object('order_id', v_operation.order_id, 'replayed', true);
  end if;
  if p_order->>'customer_id' is distinct from v_customer_id or v_customer_id is null then
    raise exception 'ORDER_CREATE_INVALID_CUSTOMER';
  end if;
  select to_jsonb(c) into v_existing from public.customers c
    where c.id = v_customer_id and c.tenant_id = p_tenant_id for update;
  if v_existing is distinct from p_customer_before then
    raise exception 'ORDER_CREATE_STALE_SNAPSHOT';
  end if;
  if p_customer_before is null and exists (
    select 1 from public.customers where tenant_id = p_tenant_id and phone = p_customer->>'phone'
  ) then
    raise exception 'ORDER_CREATE_STALE_SNAPSHOT';
  end if;
  if exists (select 1 from public.customers where id = v_customer_id and tenant_id is distinct from p_tenant_id) then
    raise exception 'ORDER_CREATE_FORBIDDEN';
  end if;
  select value into v_products from public.settings
    where tenant_id = p_tenant_id and key = 'products' for update;
  select coalesce(jsonb_object_agg(o.id, to_jsonb(o)), '{}'::jsonb) into v_orders
    from public.orders o where tenant_id = p_tenant_id and customer_id = v_customer_id;
  select coalesce(jsonb_object_agg(t.id, to_jsonb(t)), '{}'::jsonb) into v_tags
    from public.customer_tags t where tenant_id = p_tenant_id and customer_id = v_customer_id;
  if v_products is distinct from p_products_before
     or v_orders is distinct from p_orders_before
     or v_tags is distinct from p_customer_tags_before then
    raise exception 'ORDER_CREATE_STALE_SNAPSHOT';
  end if;
  v_customer := jsonb_populate_record(null::public.customers, p_customer);
  insert into public.customers (id, tenant_id, name, phone, latest_address, note, assigned_to,
    first_purchase_date, last_purchase_date, purchase_count, total_quantity, total_amount,
    status, vip_level, customer_score, follow_up_date, last_contact_date, last_contact_note)
  values (v_customer.id, p_tenant_id, v_customer.name, v_customer.phone, v_customer.latest_address,
    v_customer.note, v_customer.assigned_to, v_customer.first_purchase_date, v_customer.last_purchase_date,
    v_customer.purchase_count, v_customer.total_quantity, v_customer.total_amount,
    v_customer.status, v_customer.vip_level, v_customer.customer_score, v_customer.follow_up_date,
    v_customer.last_contact_date, v_customer.last_contact_note)
  on conflict (id) do update set name = excluded.name, phone = excluded.phone,
    latest_address = excluded.latest_address, note = excluded.note, assigned_to = excluded.assigned_to,
    first_purchase_date = excluded.first_purchase_date, last_purchase_date = excluded.last_purchase_date,
    purchase_count = excluded.purchase_count, total_quantity = excluded.total_quantity,
    total_amount = excluded.total_amount, status = excluded.status, vip_level = excluded.vip_level,
    customer_score = excluded.customer_score, follow_up_date = excluded.follow_up_date,
    last_contact_date = excluded.last_contact_date, last_contact_note = excluded.last_contact_note,
    updated_at = now()
  where public.customers.tenant_id = p_tenant_id;
  v_order := jsonb_populate_record(null::public.orders, p_order);
  insert into public.orders (id, tenant_id, customer_id, order_number, customer_name, phone, address,
    items, quantity, amount, order_date, order_time, source, source_channel, social_name, free_gift,
    vip_card_status, note, raw_text, created_by)
  values (v_order.id, p_tenant_id, v_customer_id, v_order.order_number, v_order.customer_name,
    v_order.phone, v_order.address, v_order.items, v_order.quantity, v_order.amount,
    v_order.order_date, v_order.order_time, v_order.source, v_order.source_channel,
    v_order.social_name, v_order.free_gift, v_order.vip_card_status, v_order.note,
    v_order.raw_text, v_order.created_by);
  insert into public.settings (id, tenant_id, key, value)
    values (p_tenant_id::text || ':products', p_tenant_id, 'products', p_products_after)
    on conflict (tenant_id, key) do update set value = excluded.value, updated_at = now();
  insert into public.tags (id, tenant_id, name)
    select p_tenant_id::text || ':order-tag:' || md5(value), p_tenant_id, value
    from jsonb_array_elements_text(p_customer_tags)
    on conflict do nothing;
  delete from public.customer_tags where tenant_id = p_tenant_id and customer_id = v_customer_id;
  insert into public.customer_tags (id, tenant_id, customer_id, tag_name)
    select p_tenant_id::text || ':' || v_customer_id || ':' || value, p_tenant_id, v_customer_id, value
    from jsonb_array_elements_text(p_customer_tags);
  insert into public.order_create_operations (tenant_id, idempotency_key, request_fingerprint, actor_user_id, order_id)
    values (p_tenant_id, p_token, p_fingerprint, p_actor_user_id, v_order.id);
  return jsonb_build_object('order_id', v_order.id, 'replayed', false);
end;
$$;
revoke all on function public.growup_create_order_once(uuid,text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)
  from public, anon, authenticated;
grant execute on function public.growup_create_order_once(uuid,text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)
  to service_role;
