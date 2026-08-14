-- Growup Pilot Platform Admin Core.
-- Preview-safe additive schema/RPC for non-tenant platform operations and audit.

create extension if not exists pgcrypto;

create table if not exists public.platform_admin_memberships (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.users(id) on delete cascade,
  role text not null default 'support' check (role in ('super_admin', 'admin', 'support')),
  active boolean not null default true,
  created_by_user_id text references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uniq_platform_admin_memberships_user
on public.platform_admin_memberships (user_id);

drop trigger if exists platform_admin_memberships_updated_at on public.platform_admin_memberships;
create trigger platform_admin_memberships_updated_at before update on public.platform_admin_memberships
for each row execute function public.set_updated_at();

create table if not exists public.platform_admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_user_id text references public.users(id) on delete set null,
  action text not null,
  target_type text not null,
  target_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (length(trim(action)) between 3 and 120),
  check (length(trim(target_type)) between 3 and 80)
);

create index if not exists idx_platform_admin_audit_actor
on public.platform_admin_audit_log (actor_user_id, created_at desc);

create index if not exists idx_platform_admin_audit_target
on public.platform_admin_audit_log (target_type, target_id, created_at desc);

alter table public.platform_admin_memberships enable row level security;
alter table public.platform_admin_audit_log enable row level security;

create or replace function public.growup_platform_admin_role(p_user_id text)
returns text
language sql
security definer
set search_path = public
as $$
  select pam.role
  from public.platform_admin_memberships pam
  where pam.user_id = trim(coalesce(p_user_id, ''))
    and pam.active = true
  limit 1
$$;

create or replace function public.growup_require_platform_admin(p_user_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  select public.growup_platform_admin_role(p_user_id) into v_role;
  if v_role is null then
    raise exception 'PLATFORM_ADMIN_REQUIRED';
  end if;
  return v_role;
end;
$$;

create or replace function public.growup_platform_admin_overview(p_user_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.growup_require_platform_admin(p_user_id);
begin
  return jsonb_build_object(
    'role', v_role,
    'tenants', jsonb_build_object(
      'total', (select count(*) from public.tenants),
      'active', (select count(*) from public.tenants where status = 'active')
    ),
    'subscriptions', jsonb_build_object(
      'trialing', (select count(*) from public.subscriptions where status = 'trialing'),
      'pending_payment', (select count(*) from public.subscriptions where status = 'pending_payment'),
      'active', (select count(*) from public.subscriptions where status = 'active'),
      'expired', (select count(*) from public.subscriptions where status = 'expired')
    ),
    'payments', jsonb_build_object(
      'pending', (select count(*) from public.payments where status = 'pending'),
      'paid', (select count(*) from public.payments where status = 'paid'),
      'failed', (select count(*) from public.payments where status = 'failed')
    )
  );
end;
$$;

create or replace function public.growup_platform_admin_tenants(
  p_user_id text,
  p_search text default '',
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.growup_require_platform_admin(p_user_id);
  v_search text := '%' || lower(trim(coalesce(p_search, ''))) || '%';
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  return jsonb_build_object(
    'role', v_role,
    'items', coalesce((
      select jsonb_agg(row_to_json(x)::jsonb order by x.created_at desc)
      from (
        select
          t.id,
          t.name,
          t.status,
          t.created_at,
          s.plan,
          s.billing_interval,
          s.status as subscription_status,
          s.amount_due_minor,
          (select count(*) from public.tenant_memberships tm where tm.tenant_id = t.id and tm.is_active = true) as active_users
        from public.tenants t
        left join public.subscriptions s on s.tenant_id = t.id and s.is_initial = true
        where trim(coalesce(p_search, '')) = ''
          or lower(t.name) like v_search
          or t.id::text = trim(coalesce(p_search, ''))
        order by t.created_at desc
        limit v_limit offset v_offset
      ) x
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.growup_platform_admin_tenant_detail(
  p_user_id text,
  p_tenant_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.growup_require_platform_admin(p_user_id);
begin
  if p_tenant_id is null then
    raise exception 'INVALID_TENANT';
  end if;
  return jsonb_build_object(
    'role', v_role,
    'tenant', (select to_jsonb(t) from public.tenants t where t.id = p_tenant_id),
    'subscription', (select to_jsonb(s) from public.subscriptions s where s.tenant_id = p_tenant_id and s.is_initial = true limit 1),
    'users', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', u.id,
        'username', u.username,
        'name', u.name,
        'role', tm.role,
        'active', u.is_active and tm.is_active
      ) order by u.name)
      from public.tenant_memberships tm
      join public.users u on u.id = tm.user_id
      where tm.tenant_id = p_tenant_id
    ), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.created_at desc)
      from public.payments p
      where p.tenant_id = p_tenant_id
      limit 20
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.growup_platform_admin_payments(
  p_user_id text,
  p_status text default '',
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.growup_require_platform_admin(p_user_id);
  v_status text := lower(trim(coalesce(p_status, '')));
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  return jsonb_build_object(
    'role', v_role,
    'items', coalesce((
      select jsonb_agg(row_to_json(x)::jsonb order by x.created_at desc)
      from (
        select p.*, t.name as tenant_name
        from public.payments p
        join public.tenants t on t.id = p.tenant_id
        where v_status = '' or p.status = v_status
        order by p.created_at desc
        limit v_limit offset v_offset
      ) x
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.growup_platform_admin_promotion_codes(p_user_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.growup_require_platform_admin(p_user_id);
begin
  return jsonb_build_object(
    'role', v_role,
    'items', coalesce((
      select jsonb_agg(row_to_json(x)::jsonb order by x.updated_at desc)
      from (
        select
          pc.*,
          (select count(*) from public.promotion_redemptions pr where pr.promotion_code_id = pc.id) as redemptions
        from public.promotion_codes pc
        order by pc.updated_at desc
        limit 200
      ) x
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.growup_platform_admin_upsert_promotion_code(
  p_user_id text,
  p_input jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.growup_require_platform_admin(p_user_id);
  v_id uuid := nullif(trim(coalesce(p_input->>'id', '')), '')::uuid;
  v_code text := public.growup_normalize_promotion_code(p_input->>'code');
  v_benefit_type text := lower(trim(coalesce(p_input->>'benefit_type', '')));
  v_benefit_value numeric := nullif(trim(coalesce(p_input->>'benefit_value', '')), '')::numeric;
  v_plans text[] := coalesce(array(select jsonb_array_elements_text(coalesce(p_input->'applicable_plans', '[]'::jsonb))), array['starter', 'business', 'enterprise']);
  v_billing text[] := coalesce(array(select jsonb_array_elements_text(coalesce(p_input->'applicable_billing', '[]'::jsonb))), array['monthly', 'yearly']);
  v_active boolean := coalesce((p_input->>'active')::boolean, true);
  v_max_redemptions integer := nullif(trim(coalesce(p_input->>'max_redemptions', '')), '')::integer;
  v_max_per_tenant integer := nullif(trim(coalesce(p_input->>'max_redemptions_per_tenant', '')), '')::integer;
  v_row public.promotion_codes%rowtype;
begin
  if v_role not in ('super_admin', 'admin') then
    raise exception 'PLATFORM_ADMIN_WRITE_FORBIDDEN';
  end if;
  if length(v_code) < 2
    or v_benefit_type not in ('percent_discount', 'fixed_amount_discount', 'extra_trial_days', 'free_months')
    or v_benefit_value is null
    or v_benefit_value <= 0
    or not (v_plans <@ array['starter', 'business', 'enterprise'])
    or not (v_billing <@ array['monthly', 'yearly']) then
    raise exception 'INVALID_PROMOTION_CODE';
  end if;

  if v_id is null then
    insert into public.promotion_codes (
      code,
      active,
      benefit_type,
      benefit_value,
      applicable_plans,
      applicable_billing,
      starts_at,
      ends_at,
      max_redemptions,
      max_redemptions_per_tenant
    )
    values (
      v_code,
      v_active,
      v_benefit_type,
      v_benefit_value,
      v_plans,
      v_billing,
      nullif(trim(coalesce(p_input->>'starts_at', '')), '')::timestamptz,
      nullif(trim(coalesce(p_input->>'ends_at', '')), '')::timestamptz,
      v_max_redemptions,
      v_max_per_tenant
    )
    returning * into v_row;
  else
    update public.promotion_codes
    set code = v_code,
        active = v_active,
        benefit_type = v_benefit_type,
        benefit_value = v_benefit_value,
        applicable_plans = v_plans,
        applicable_billing = v_billing,
        starts_at = nullif(trim(coalesce(p_input->>'starts_at', '')), '')::timestamptz,
        ends_at = nullif(trim(coalesce(p_input->>'ends_at', '')), '')::timestamptz,
        max_redemptions = v_max_redemptions,
        max_redemptions_per_tenant = v_max_per_tenant
    where id = v_id
    returning * into v_row;

    if not found then
      raise exception 'PROMOTION_CODE_NOT_FOUND';
    end if;
  end if;

  insert into public.platform_admin_audit_log (actor_user_id, action, target_type, target_id, details)
  values (
    trim(p_user_id),
    case when v_id is null then 'promotion_code.create' else 'promotion_code.update' end,
    'promotion_code',
    v_row.id::text,
    to_jsonb(v_row)
  );

  return jsonb_build_object('role', v_role, 'promotion', to_jsonb(v_row));
end;
$$;

comment on table public.platform_admin_memberships is 'Global platform-admin membership independent of tenant Owner/Admin roles.';
comment on table public.platform_admin_audit_log is 'Append-only platform-admin action audit log.';
