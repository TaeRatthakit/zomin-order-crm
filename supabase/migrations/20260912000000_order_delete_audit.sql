-- Additive order deletion audit/recovery protection.
-- No historical order data is migrated by this change.

create table if not exists public.order_deletion_audit (
  id uuid primary key default gen_random_uuid(),
  order_id text not null,
  tenant_id uuid not null references public.tenants(id),
  actor_user_id text not null,
  actor_role text not null check (actor_role in ('Owner', 'Admin', 'Staff')),
  action text not null default 'order_delete' check (action = 'order_delete'),
  deleted_at timestamptz not null default now(),
  order_snapshot jsonb not null,
  request_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists order_deletion_audit_tenant_deleted_at_idx
  on public.order_deletion_audit (tenant_id, deleted_at desc);

create index if not exists order_deletion_audit_tenant_order_idx
  on public.order_deletion_audit (tenant_id, order_id, deleted_at desc);

alter table public.order_deletion_audit enable row level security;

-- The application server calls the function with its service role. The browser
-- must not be able to read, write, update, or delete recovery records directly.
revoke all on table public.order_deletion_audit from anon, authenticated;
grant all on table public.order_deletion_audit to service_role;

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
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_audit_id uuid;
  v_deleted_count integer;
  v_metadata jsonb;
begin
  if nullif(trim(p_order_id), '') is null
     or p_tenant_id is null
     or nullif(trim(p_actor_user_id), '') is null
     or p_actor_role not in ('Owner', 'Admin', 'Staff') then
    raise exception 'ORDER_DELETE_INVALID_CONTEXT';
  end if;

  if not exists (
    select 1
    from public.tenant_memberships membership
    where membership.tenant_id = p_tenant_id
      and membership.user_id = p_actor_user_id
      and membership.role = p_actor_role
      and membership.is_active = true
  ) then
    raise exception 'ORDER_DELETE_ACTOR_NOT_IN_TENANT';
  end if;

  select order_row.*
    into v_order
  from public.orders order_row
  where order_row.id = p_order_id
    and order_row.tenant_id = p_tenant_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
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

  insert into public.order_deletion_audit (
    order_id,
    tenant_id,
    actor_user_id,
    actor_role,
    action,
    deleted_at,
    order_snapshot,
    request_metadata
  ) values (
    v_order.id,
    v_order.tenant_id,
    p_actor_user_id,
    p_actor_role,
    'order_delete',
    now(),
    to_jsonb(v_order),
    jsonb_strip_nulls(v_metadata)
  ) returning id into v_audit_id;

  delete from public.orders
  where id = v_order.id
    and tenant_id = p_tenant_id;
  get diagnostics v_deleted_count = row_count;
  if v_deleted_count <> 1 then
    raise exception 'ORDER_DELETE_COMMIT_FAILED';
  end if;

  return jsonb_build_object(
    'ok', true,
    'audit_id', v_audit_id,
    'order_id', v_order.id,
    'tenant_id', v_order.tenant_id
  );
end;
$$;

revoke all on function public.delete_order_with_audit(text, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.delete_order_with_audit(text, uuid, text, text, jsonb) to service_role;

-- Rollback (only with explicit approval after confirming no recovery records are needed):
-- revoke execute on function public.delete_order_with_audit(text, uuid, text, text, jsonb) from service_role;
-- drop function if exists public.delete_order_with_audit(text, uuid, text, text, jsonb);
-- drop table if exists public.order_deletion_audit;
