-- Require a real, short-lived, one-time interactive user intent for every
-- physical order deletion. No existing business rows are updated or deleted.

set lock_timeout = '5s';

create table if not exists public.order_delete_intents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  order_id text not null,
  actor_user_id text not null,
  actor_role text not null check (actor_role in ('Owner', 'Admin', 'Staff')),
  session_fingerprint text not null check (session_fingerprint ~ '^[0-9a-f]{64}$'),
  intent_hash text not null unique check (intent_hash ~ '^[0-9a-f]{64}$'),
  proof text not null default 'EXPLICIT_USER_CONFIRMED_DELETE'
    check (proof = 'EXPLICIT_USER_CONFIRMED_DELETE'),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_transaction_id bigint,
  request_metadata jsonb not null default '{}'::jsonb,
  check (expires_at > created_at),
  check ((consumed_at is null) = (consumed_transaction_id is null))
);

create index if not exists order_delete_intents_active_lookup_idx
  on public.order_delete_intents (tenant_id, order_id, actor_user_id, expires_at)
  where consumed_at is null;

alter table public.order_delete_intents enable row level security;
revoke all on table public.order_delete_intents from public, anon, authenticated, service_role;

alter table public.order_deletion_audit
  add column if not exists delete_intent_id uuid references public.order_delete_intents(id) on delete restrict,
  add column if not exists deletion_proof text,
  add column if not exists inventory_effect jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.order_deletion_audit'::regclass
      and conname = 'order_deletion_audit_explicit_proof_check'
  ) then
    alter table public.order_deletion_audit
      add constraint order_deletion_audit_explicit_proof_check
      check (
        (delete_intent_id is null and deletion_proof is null)
        or (delete_intent_id is not null and deletion_proof = 'EXPLICIT_USER_CONFIRMED_DELETE')
      );
  end if;
end;
$$;

create index if not exists order_deletion_audit_explicit_intent_idx
  on public.order_deletion_audit (tenant_id, order_id, delete_intent_id)
  where deletion_proof = 'EXPLICIT_USER_CONFIRMED_DELETE';

-- Existing audit rows remain readable for incident investigation, but only the
-- privileged functions below may create a new deletion proof.
revoke all on table public.order_deletion_audit from public, anon, authenticated, service_role;
grant select on table public.order_deletion_audit to service_role;

create or replace function public.create_order_delete_intent(
  p_order_id text,
  p_tenant_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_session_fingerprint text,
  p_intent_hash text,
  p_request_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent_id uuid;
  v_expires_at timestamptz;
  v_metadata jsonb;
begin
  if nullif(pg_catalog.btrim(p_order_id), '') is null
     or p_tenant_id is null
     or nullif(pg_catalog.btrim(p_actor_user_id), '') is null
     or p_actor_role not in ('Owner', 'Admin', 'Staff')
     or p_session_fingerprint !~ '^[0-9a-f]{64}$'
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

  if not exists (
    select 1
    from public.orders order_row
    where order_row.tenant_id = p_tenant_id
      and order_row.id = p_order_id
  ) then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  v_metadata := pg_catalog.jsonb_build_object(
    'route', case when pg_catalog.jsonb_typeof(coalesce(p_request_metadata, '{}'::jsonb)) = 'object'
      then nullif(pg_catalog.left(coalesce(p_request_metadata->>'route', ''), 200), '') else null end,
    'method', 'POST',
    'source', 'explicit_user_confirmation',
    'request_id', case when pg_catalog.jsonb_typeof(coalesce(p_request_metadata, '{}'::jsonb)) = 'object'
      then nullif(pg_catalog.left(coalesce(p_request_metadata->>'request_id', ''), 160), '') else null end,
    'user_agent', case when pg_catalog.jsonb_typeof(coalesce(p_request_metadata, '{}'::jsonb)) = 'object'
      then nullif(pg_catalog.left(coalesce(p_request_metadata->>'user_agent', ''), 240), '') else null end
  );
  v_expires_at := clock_timestamp() + interval '2 minutes';

  insert into public.order_delete_intents (
    tenant_id, order_id, actor_user_id, actor_role,
    session_fingerprint, intent_hash, proof, expires_at, request_metadata
  ) values (
    p_tenant_id, p_order_id, p_actor_user_id, p_actor_role,
    p_session_fingerprint, p_intent_hash, 'EXPLICIT_USER_CONFIRMED_DELETE',
    v_expires_at, pg_catalog.jsonb_strip_nulls(v_metadata)
  ) returning id into v_intent_id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'intent_id', v_intent_id,
    'expires_at', v_expires_at,
    'order_id', p_order_id,
    'tenant_id', p_tenant_id
  );
end;
$$;

revoke all on function public.create_order_delete_intent(text, uuid, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_order_delete_intent(text, uuid, text, text, text, text, jsonb)
  to service_role;

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
  v_customer_after public.customers%rowtype;
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

  if pg_catalog.jsonb_typeof(p_customer_after) <> 'object' then
    raise exception 'ORDER_DELETE_CUSTOMER_AFTER_REQUIRED';
  end if;
  select populated.* into v_customer_after
  from pg_catalog.jsonb_populate_record(null::public.customers, p_customer_after) as populated;
  if v_customer_after.id is distinct from v_order.customer_id
     or nullif(pg_catalog.btrim(v_customer_after.name), '') is null
     or nullif(pg_catalog.btrim(v_customer_after.phone), '') is null then
    raise exception 'ORDER_DELETE_CUSTOMER_AFTER_INVALID';
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
  if v_customer_after.purchase_count is distinct from v_remaining_count
     or v_customer_after.total_quantity is distinct from v_remaining_quantity
     or v_customer_after.total_amount is distinct from v_remaining_amount
     or v_customer_after.first_purchase_date is distinct from v_first_purchase
     or v_customer_after.last_purchase_date is distinct from v_last_purchase then
    raise exception 'ORDER_DELETE_CUSTOMER_AGGREGATE_MISMATCH';
  end if;

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
  set name = v_customer_after.name,
      phone = v_customer_after.phone,
      latest_address = coalesce(v_customer_after.latest_address, ''),
      note = coalesce(v_customer_after.note, ''),
      assigned_to = v_customer_after.assigned_to,
      first_purchase_date = v_customer_after.first_purchase_date,
      last_purchase_date = v_customer_after.last_purchase_date,
      purchase_count = v_customer_after.purchase_count,
      total_quantity = v_customer_after.total_quantity,
      total_amount = v_customer_after.total_amount,
      status = coalesce(v_customer_after.status, 'NORMAL'),
      vip_level = coalesce(v_customer_after.vip_level, 'NORMAL'),
      customer_score = v_customer_after.customer_score,
      follow_up_date = v_customer_after.follow_up_date,
      last_contact_date = v_customer_after.last_contact_date,
      last_contact_note = coalesce(v_customer_after.last_contact_note, ''),
      updated_at = clock_timestamp()
  where tenant_id = p_tenant_id and id = v_order.customer_id;
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

-- Keep the legacy signature for stale deployments, but make it fail closed.
create or replace function public.delete_order_with_audit(
  p_order_id text,
  p_tenant_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_request_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'ORDER_DELETE_EXPLICIT_USER_INTENT_REQUIRED';
end;
$$;
revoke all on function public.delete_order_with_audit(text, uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.delete_order_with_audit(text, uuid, text, text, jsonb) to service_role;

-- Import cleanup may remove its own metadata, but never a business order.
create or replace function public.cleanup_import_job_with_audit(
  p_job_id text,
  p_tenant_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_request_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_job public.settings%rowtype;
  v_order_ids text[];
begin
  if nullif(trim(p_job_id), '') is null
     or p_tenant_id is null
     or nullif(trim(p_actor_user_id), '') is null
     or p_actor_role not in ('Owner', 'Admin', 'Staff') then
    raise exception 'IMPORT_CLEANUP_INVALID_CONTEXT';
  end if;
  if not exists (
    select 1 from public.tenant_memberships membership
    where membership.tenant_id = p_tenant_id
      and membership.user_id = p_actor_user_id
      and membership.role = p_actor_role
      and membership.is_active = true
  ) then
    raise exception 'IMPORT_CLEANUP_ACTOR_NOT_IN_TENANT';
  end if;
  select setting.* into v_job
  from public.settings setting
  where setting.tenant_id = p_tenant_id and setting.key = 'import_job_' || p_job_id
  for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;

  select coalesce(array_agg(distinct value order by value), '{}') into v_order_ids
  from jsonb_array_elements_text(coalesce(v_job.value->'importedOrderIds', '[]'::jsonb));
  if cardinality(v_order_ids) > 0 then
    raise exception 'IMPORT_CLEANUP_ORDER_DELETE_FORBIDDEN';
  end if;

  delete from public.settings where tenant_id = p_tenant_id and key = v_job.key;
  if not found then raise exception 'IMPORT_CLEANUP_JOB_DELETE_FAILED'; end if;
  update public.settings
  set value = jsonb_build_object('id', ''), updated_at = now()
  where tenant_id = p_tenant_id
    and key = 'import_active_' || coalesce(v_job.value->>'type', '')
    and value->>'id' = p_job_id;
  return jsonb_build_object(
    'ok', true, 'job_id', p_job_id, 'deleted_orders', 0,
    'deleted_customers', 0, 'deleted_import_records', 1
  );
end;
$$;
revoke all on function public.cleanup_import_job_with_audit(text, uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.cleanup_import_job_with_audit(text, uuid, text, text, jsonb) to service_role;

-- A customer deletion must be blocked by referential integrity, not converted
-- into automatic order deletion through an old cascade constraint.
do $$
declare
  v_constraint record;
begin
  for v_constraint in
    select constraint_row.conname
    from pg_constraint constraint_row
    where constraint_row.contype = 'f'
      and constraint_row.conrelid = 'public.orders'::regclass
      and constraint_row.confrelid = 'public.customers'::regclass
      and constraint_row.confdeltype = 'c'
  loop
    execute format('alter table public.orders drop constraint %I', v_constraint.conname);
  end loop;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass and conname = 'orders_customer_id_fkey'
  ) then
    alter table public.orders
      add constraint orders_customer_id_fkey
      foreign key (customer_id)
      references public.customers (id)
      on delete restrict;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.customers'::regclass and conname = 'customers_tenant_id_id_key'
  ) then
    alter table public.customers
      add constraint customers_tenant_id_id_key unique (tenant_id, id);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass and conname = 'orders_tenant_customer_fkey'
  ) then
    alter table public.orders
      add constraint orders_tenant_customer_fkey
      foreign key (tenant_id, customer_id)
      references public.customers (tenant_id, id)
      on delete restrict;
  end if;
end;
$$;

-- The trigger is the final database-level invariant. An audit row alone is no
-- longer enough: it must reference the exact intent consumed by this transaction.
create or replace function public.require_same_transaction_order_delete_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.order_deletion_audit audit
    join public.order_delete_intents intent on intent.id = audit.delete_intent_id
    where audit.tenant_id = old.tenant_id
      and audit.order_id = old.id
      and audit.action = 'order_delete'
      and audit.deletion_proof = 'EXPLICIT_USER_CONFIRMED_DELETE'
      and audit.actor_user_id = intent.actor_user_id
      and intent.tenant_id = old.tenant_id
      and intent.order_id = old.id
      and intent.proof = 'EXPLICIT_USER_CONFIRMED_DELETE'
      and intent.consumed_at is not null
      and intent.consumed_transaction_id = pg_catalog.txid_current()
      and audit.xmin::text = pg_catalog.txid_current()::text
  ) then
    raise exception 'ORDER_DELETE_EXPLICIT_USER_INTENT_REQUIRED';
  end if;
  return old;
end;
$$;
revoke all on function public.require_same_transaction_order_delete_audit()
  from public, anon, authenticated;

alter table public.line_order_reconciliation_items
  drop constraint if exists line_order_reconciliation_items_classification_check;
alter table public.line_order_reconciliation_items
  add constraint line_order_reconciliation_items_classification_check
  check (classification in (
    'PRESENT_EXACT', 'RECOVERED', 'INTENTIONAL_AUDITED_DELETE',
    'UNEXPECTED_MISSING', 'MISSING_UNRESOLVED', 'DUPLICATE',
    'WRONG_TENANT', 'SYNTHETIC_TEST'
  ));

comment on table public.order_delete_intents is
  'Server-only short-lived proof that a real authenticated session explicitly confirmed deletion of one exact order.';
comment on function public.require_same_transaction_order_delete_audit() is
  'Rejects every physical order deletion unless this transaction consumed the exact explicit-user delete intent and wrote its recovery audit.';

-- Rollback is intentionally omitted. Restoring an automatic/raw deletion path
-- would violate the permanent order-integrity invariant.
