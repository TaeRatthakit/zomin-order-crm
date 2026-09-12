-- Additive, tenant-scoped destructive-path protection.
-- No existing rows are rewritten by this migration.

create table if not exists public.customer_deletion_audit (
  id uuid primary key default gen_random_uuid(),
  customer_id text not null,
  tenant_id uuid not null references public.tenants(id),
  actor_user_id text not null,
  actor_role text not null check (actor_role in ('Owner', 'Admin', 'Staff')),
  action text not null default 'customer_delete' check (action = 'customer_delete'),
  deleted_at timestamptz not null default now(),
  customer_snapshot jsonb not null,
  request_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists customer_deletion_audit_tenant_deleted_at_idx
  on public.customer_deletion_audit (tenant_id, deleted_at desc);

create index if not exists customer_deletion_audit_tenant_customer_idx
  on public.customer_deletion_audit (tenant_id, customer_id, deleted_at desc);

alter table public.customer_deletion_audit enable row level security;
revoke all on table public.customer_deletion_audit from anon, authenticated;
grant all on table public.customer_deletion_audit to service_role;

create or replace function public.delete_customer_with_audit(
  p_customer_id text,
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
  v_customer public.customers%rowtype;
  v_audit_id uuid;
  v_deleted_count integer;
  v_metadata jsonb;
begin
  if nullif(trim(p_customer_id), '') is null
     or p_tenant_id is null
     or nullif(trim(p_actor_user_id), '') is null
     or p_actor_role not in ('Owner', 'Admin', 'Staff') then
    raise exception 'CUSTOMER_DELETE_INVALID_CONTEXT';
  end if;

  if not exists (
    select 1
    from public.tenant_memberships membership
    where membership.tenant_id = p_tenant_id
      and membership.user_id = p_actor_user_id
      and membership.role = p_actor_role
      and membership.is_active = true
  ) then
    raise exception 'CUSTOMER_DELETE_ACTOR_NOT_IN_TENANT';
  end if;

  select customer_row.*
    into v_customer
  from public.customers customer_row
  where customer_row.id = p_customer_id
    and customer_row.tenant_id = p_tenant_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if exists (
    select 1
    from public.orders order_row
    where order_row.customer_id = p_customer_id
      and order_row.tenant_id = p_tenant_id
  ) then
    raise exception 'CUSTOMER_DELETE_HAS_ORDERS';
  end if;

  v_metadata := jsonb_build_object(
    'route', case when jsonb_typeof(coalesce(p_request_metadata, '{}'::jsonb)) = 'object'
      then nullif(left(coalesce(p_request_metadata->>'route', ''), 200), '') else null end,
    'method', case when jsonb_typeof(coalesce(p_request_metadata, '{}'::jsonb)) = 'object'
      then nullif(left(coalesce(p_request_metadata->>'method', ''), 16), '') else null end,
    'source', case when jsonb_typeof(coalesce(p_request_metadata, '{}'::jsonb)) = 'object'
      then nullif(left(coalesce(p_request_metadata->>'source', ''), 80), '') else null end,
    'request_id', case when jsonb_typeof(coalesce(p_request_metadata, '{}'::jsonb)) = 'object'
      then nullif(left(coalesce(p_request_metadata->>'request_id', ''), 160), '') else null end,
    'user_agent', case when jsonb_typeof(coalesce(p_request_metadata, '{}'::jsonb)) = 'object'
      then nullif(left(coalesce(p_request_metadata->>'user_agent', ''), 240), '') else null end
  );

  insert into public.customer_deletion_audit (
    customer_id, tenant_id, actor_user_id, actor_role, action,
    deleted_at, customer_snapshot, request_metadata
  ) values (
    v_customer.id, v_customer.tenant_id, p_actor_user_id, p_actor_role,
    'customer_delete', now(), to_jsonb(v_customer), jsonb_strip_nulls(v_metadata)
  ) returning id into v_audit_id;

  delete from public.customers
  where id = v_customer.id
    and tenant_id = p_tenant_id;
  get diagnostics v_deleted_count = row_count;
  if v_deleted_count <> 1 then
    raise exception 'CUSTOMER_DELETE_COMMIT_FAILED';
  end if;

  return jsonb_build_object(
    'ok', true,
    'audit_id', v_audit_id,
    'customer_id', v_customer.id,
    'tenant_id', v_customer.tenant_id
  );
end;
$$;

revoke all on function public.delete_customer_with_audit(text, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.delete_customer_with_audit(text, uuid, text, text, jsonb) to service_role;

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
  v_latest public.settings%rowtype;
  v_job_type text;
  v_order_ids text[];
  v_order public.orders%rowtype;
  v_order_count integer := 0;
  v_deleted_orders integer := 0;
  v_audit_id uuid;
  v_metadata jsonb;
begin
  if nullif(trim(p_job_id), '') is null
     or p_tenant_id is null
     or nullif(trim(p_actor_user_id), '') is null
     or p_actor_role not in ('Owner', 'Admin', 'Staff') then
    raise exception 'IMPORT_CLEANUP_INVALID_CONTEXT';
  end if;

  if not exists (
    select 1
    from public.tenant_memberships membership
    where membership.tenant_id = p_tenant_id
      and membership.user_id = p_actor_user_id
      and membership.role = p_actor_role
      and membership.is_active = true
  ) then
    raise exception 'IMPORT_CLEANUP_ACTOR_NOT_IN_TENANT';
  end if;

  select setting.*
    into v_job
  from public.settings setting
  where setting.tenant_id = p_tenant_id
    and setting.key = 'import_job_' || p_job_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if jsonb_typeof(v_job.value) <> 'object' then
    raise exception 'IMPORT_CLEANUP_INVALID_JOB';
  end if;
  v_job_type := nullif(trim(v_job.value->>'type'), '');
  if v_job_type is null or v_job_type <> 'orders' then
    raise exception 'IMPORT_CLEANUP_INVALID_JOB_TYPE';
  end if;

  select setting.*
    into v_latest
  from public.settings setting
  where setting.tenant_id = p_tenant_id
    and setting.key like 'import_job_%'
    and setting.value->>'type' = v_job_type
  order by setting.updated_at desc
  limit 1;
  if v_latest.id is distinct from v_job.id then
    raise exception 'IMPORT_CLEANUP_NOT_LATEST_JOB';
  end if;

  select coalesce(array_agg(distinct value order by value), '{}')
    into v_order_ids
  from jsonb_array_elements_text(coalesce(v_job.value->'importedOrderIds', '[]'::jsonb));

  v_metadata := jsonb_build_object(
    'source', 'import_cleanup',
    'job_id', left(p_job_id, 160),
    'route', case when jsonb_typeof(coalesce(p_request_metadata, '{}'::jsonb)) = 'object'
      then nullif(left(coalesce(p_request_metadata->>'route', ''), 200), '') else null end,
    'method', case when jsonb_typeof(coalesce(p_request_metadata, '{}'::jsonb)) = 'object'
      then nullif(left(coalesce(p_request_metadata->>'method', ''), 16), '') else null end,
    'request_id', case when jsonb_typeof(coalesce(p_request_metadata, '{}'::jsonb)) = 'object'
      then nullif(left(coalesce(p_request_metadata->>'request_id', ''), 160), '') else null end
  );

  if cardinality(v_order_ids) > 0 then
    for v_order in
      select order_row.*
      from public.orders order_row
      where order_row.tenant_id = p_tenant_id
        and order_row.id = any(v_order_ids)
      order by order_row.id
      for update
    loop
      v_order_count := v_order_count + 1;
      if position('"__importJobId":"' || replace(p_job_id, '"', '') || '"' in coalesce(v_order.raw_text, '')) = 0 then
        raise exception 'IMPORT_CLEANUP_ORDER_PROVENANCE_MISMATCH';
      end if;
      insert into public.order_deletion_audit (
        order_id, tenant_id, actor_user_id, actor_role, action,
        deleted_at, order_snapshot, request_metadata
      ) values (
        v_order.id, v_order.tenant_id, p_actor_user_id, p_actor_role,
        'order_delete', now(), to_jsonb(v_order), v_metadata
      ) returning id into v_audit_id;
    end loop;
    if v_order_count <> cardinality(v_order_ids) then
      raise exception 'IMPORT_CLEANUP_ORDER_PROVENANCE_MISMATCH';
    end if;
  end if;

  if cardinality(v_order_ids) > 0 then
    delete from public.orders
    where tenant_id = p_tenant_id and id = any(v_order_ids);
    get diagnostics v_deleted_orders = row_count;
    if v_deleted_orders <> cardinality(v_order_ids) then
      raise exception 'IMPORT_CLEANUP_ORDER_DELETE_FAILED';
    end if;
  end if;

  delete from public.settings
  where tenant_id = p_tenant_id
    and key = v_job.key;
  if not found then
    raise exception 'IMPORT_CLEANUP_JOB_DELETE_FAILED';
  end if;

  update public.settings
  set value = jsonb_build_object('id', ''), updated_at = now()
  where tenant_id = p_tenant_id
    and key = 'import_active_' || v_job_type
    and value->>'id' = p_job_id;

  return jsonb_build_object(
    'ok', true,
    'job_id', p_job_id,
    'deleted_orders', v_deleted_orders,
    'deleted_customers', 0,
    'deleted_import_records', 1
  );
end;
$$;

revoke all on function public.cleanup_import_job_with_audit(text, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.cleanup_import_job_with_audit(text, uuid, text, text, jsonb) to service_role;

-- Rollback (only with explicit approval after confirming no recovery records are needed):
-- revoke execute on function public.cleanup_import_job_with_audit(text, uuid, text, text, jsonb) from service_role;
-- drop function if exists public.cleanup_import_job_with_audit(text, uuid, text, text, jsonb);
-- revoke execute on function public.delete_customer_with_audit(text, uuid, text, text, jsonb) from service_role;
-- drop function if exists public.delete_customer_with_audit(text, uuid, text, text, jsonb);
-- drop table if exists public.customer_deletion_audit;
