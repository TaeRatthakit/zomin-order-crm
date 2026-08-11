-- Growup Pilot promotion code foundation for public signup.
-- Additive only. Does not seed public codes, charge payments, or activate paid subscriptions.

create extension if not exists pgcrypto;

create table if not exists public.promotion_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  active boolean not null default true,
  benefit_type text not null check (benefit_type in ('percent_discount', 'fixed_amount_discount', 'extra_trial_days', 'free_months')),
  benefit_value numeric(12, 2) not null check (benefit_value > 0),
  applicable_plans text[] not null default array['starter', 'business', 'enterprise'],
  applicable_billing text[] not null default array['monthly', 'yearly'],
  starts_at timestamptz,
  ends_at timestamptz,
  max_redemptions integer check (max_redemptions is null or max_redemptions > 0),
  max_redemptions_per_tenant integer check (max_redemptions_per_tenant is null or max_redemptions_per_tenant > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (length(trim(code)) between 2 and 64),
  check (applicable_plans <@ array['starter', 'business', 'enterprise']),
  check (applicable_billing <@ array['monthly', 'yearly']),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);

create unique index if not exists uniq_promotion_codes_normalized_code
on public.promotion_codes ((upper(trim(code))));

create index if not exists idx_promotion_codes_active_dates
on public.promotion_codes (active, starts_at, ends_at);

drop trigger if exists promotion_codes_updated_at on public.promotion_codes;
create trigger promotion_codes_updated_at before update on public.promotion_codes
for each row execute function public.set_updated_at();

create table if not exists public.promotion_redemptions (
  id uuid primary key default gen_random_uuid(),
  promotion_code_id uuid not null references public.promotion_codes(id) on delete restrict,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  selected_plan text not null check (selected_plan in ('starter', 'business', 'enterprise')),
  selected_billing text not null check (selected_billing in ('monthly', 'yearly')),
  benefit_type text not null check (benefit_type in ('percent_discount', 'fixed_amount_discount', 'extra_trial_days', 'free_months')),
  benefit_value numeric(12, 2) not null check (benefit_value > 0),
  benefit_description text not null,
  redeemed_at timestamptz not null default now()
);

create index if not exists idx_promotion_redemptions_code
on public.promotion_redemptions (promotion_code_id, redeemed_at desc);

create index if not exists idx_promotion_redemptions_tenant
on public.promotion_redemptions (tenant_id, promotion_code_id);

alter table public.promotion_codes enable row level security;
alter table public.promotion_redemptions enable row level security;

create or replace function public.growup_normalize_promotion_code(p_code text)
returns text
language sql
immutable
as $$
  select upper(trim(coalesce(p_code, '')))
$$;

create or replace function public.growup_promotion_benefit_description(
  p_benefit_type text,
  p_benefit_value numeric
)
returns text
language plpgsql
immutable
as $$
declare
  v_value text := trim(to_char(coalesce(p_benefit_value, 0), 'FM999999990.##'));
begin
  if p_benefit_type = 'percent_discount' then
    return 'ลด ' || v_value || '%';
  elsif p_benefit_type = 'fixed_amount_discount' then
    return 'ลด ฿' || v_value;
  elsif p_benefit_type = 'extra_trial_days' then
    return 'เพิ่มระยะทดลองใช้ฟรี ' || trim(to_char(coalesce(p_benefit_value, 0), 'FM999999990')) || ' วัน';
  elsif p_benefit_type = 'free_months' then
    return 'ใช้ฟรีเพิ่ม ' || trim(to_char(coalesce(p_benefit_value, 0), 'FM999999990')) || ' เดือน';
  end if;
  return '';
end;
$$;

create or replace function public.growup_validate_promotion_code(
  p_code text,
  p_selected_plan text,
  p_selected_billing text,
  p_tenant_id uuid default null
)
returns table (
  valid boolean,
  code text,
  selected_plan text,
  selected_billing text,
  benefit_type text,
  benefit_value numeric,
  benefit_description text,
  reason text
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_code text := public.growup_normalize_promotion_code(p_code);
  v_selected_plan text := lower(trim(coalesce(p_selected_plan, '')));
  v_selected_billing text := lower(trim(coalesce(p_selected_billing, '')));
  v_promotion public.promotion_codes%rowtype;
  v_total_redemptions integer := 0;
  v_tenant_redemptions integer := 0;
begin
  if length(v_code) < 2
    or v_selected_plan not in ('starter', 'business', 'enterprise')
    or v_selected_billing not in ('monthly', 'yearly') then
    return query select false, v_code, v_selected_plan, v_selected_billing, null::text, null::numeric, null::text, 'PROMOTION_CODE_INVALID';
    return;
  end if;

  select *
  into v_promotion
  from public.promotion_codes pc
  where public.growup_normalize_promotion_code(pc.code) = v_code
  limit 1;

  if not found then
    return query select false, v_code, v_selected_plan, v_selected_billing, null::text, null::numeric, null::text, 'PROMOTION_CODE_INVALID';
    return;
  end if;

  if not v_promotion.active then
    return query select false, v_code, v_selected_plan, v_selected_billing, null::text, null::numeric, null::text, 'PROMOTION_CODE_INVALID';
    return;
  end if;

  if (v_promotion.starts_at is not null and v_promotion.starts_at > now())
    or (v_promotion.ends_at is not null and v_promotion.ends_at < now()) then
    return query select false, v_code, v_selected_plan, v_selected_billing, null::text, null::numeric, null::text, 'PROMOTION_CODE_EXPIRED';
    return;
  end if;

  if not v_selected_plan = any(v_promotion.applicable_plans)
    or not v_selected_billing = any(v_promotion.applicable_billing) then
    return query select false, v_code, v_selected_plan, v_selected_billing, null::text, null::numeric, null::text, 'PROMOTION_CODE_INVALID';
    return;
  end if;

  if v_promotion.max_redemptions is not null then
    select count(*) into v_total_redemptions
    from public.promotion_redemptions pr
    where pr.promotion_code_id = v_promotion.id;
    if v_total_redemptions >= v_promotion.max_redemptions then
      return query select false, v_code, v_selected_plan, v_selected_billing, null::text, null::numeric, null::text, 'PROMOTION_CODE_EXHAUSTED';
      return;
    end if;
  end if;

  if p_tenant_id is not null and v_promotion.max_redemptions_per_tenant is not null then
    select count(*) into v_tenant_redemptions
    from public.promotion_redemptions pr
    where pr.promotion_code_id = v_promotion.id
      and pr.tenant_id = p_tenant_id;
    if v_tenant_redemptions >= v_promotion.max_redemptions_per_tenant then
      return query select false, v_code, v_selected_plan, v_selected_billing, null::text, null::numeric, null::text, 'PROMOTION_CODE_EXHAUSTED';
      return;
    end if;
  end if;

  return query select
    true,
    public.growup_normalize_promotion_code(v_promotion.code),
    v_selected_plan,
    v_selected_billing,
    v_promotion.benefit_type,
    v_promotion.benefit_value,
    public.growup_promotion_benefit_description(v_promotion.benefit_type, v_promotion.benefit_value),
    null::text;
end;
$$;

create or replace function public.growup_signup_bootstrap(
  p_idempotency_key text,
  p_user_id text,
  p_username text,
  p_password_hash text,
  p_name text,
  p_business_name text,
  p_defaults jsonb default '{}'::jsonb,
  p_promotion_code text default '',
  p_selected_plan text default '',
  p_selected_billing text default ''
)
returns table (
  user_id text,
  username text,
  name text,
  role text,
  phone text,
  is_active boolean,
  tenant_id uuid,
  tenant_name text,
  tenant_role text
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_idempotency_key text := trim(coalesce(p_idempotency_key, ''));
  v_user_id text := trim(coalesce(p_user_id, ''));
  v_username text := lower(trim(coalesce(p_username, '')));
  v_name text := trim(coalesce(p_name, ''));
  v_business_name text := trim(coalesce(p_business_name, ''));
  v_password_hash text := trim(coalesce(p_password_hash, ''));
  v_promotion_code text := public.growup_normalize_promotion_code(p_promotion_code);
  v_selected_plan text := lower(trim(coalesce(p_selected_plan, '')));
  v_selected_billing text := lower(trim(coalesce(p_selected_billing, '')));
  v_tenant_id uuid;
  v_setting record;
  v_rule record;
  v_promotion public.promotion_codes%rowtype;
  v_total_redemptions integer := 0;
begin
  if length(v_idempotency_key) < 8
    or length(v_idempotency_key) > 120
    or length(v_user_id) < 3
    or length(v_user_id) > 120
    or length(v_username) < 3
    or length(v_username) > 120
    or length(v_password_hash) < 20
    or length(v_business_name) < 2
    or length(v_business_name) > 120 then
    raise exception 'INVALID_SIGNUP_INPUT';
  end if;

  if exists (select 1 from public.signup_bootstraps sb where sb.idempotency_key = v_idempotency_key) then
    if not exists (
      select 1
      from public.signup_bootstraps sb
      where sb.idempotency_key = v_idempotency_key
        and sb.username = v_username
    ) then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return query
      select u.id, u.username, u.name, u.role, u.phone, u.is_active, t.id, t.name, tm.role
      from public.signup_bootstraps sb
      join public.users u on u.id = sb.user_id
      join public.tenants t on t.id = sb.tenant_id
      join public.tenant_memberships tm on tm.tenant_id = t.id and tm.user_id = u.id and tm.is_active = true
      where sb.idempotency_key = v_idempotency_key
        and t.status = 'active'
      limit 1;
    return;
  end if;

  if exists (select 1 from public.users u where lower(u.username) = v_username) then
    raise exception 'ACCOUNT_EXISTS';
  end if;

  if v_promotion_code <> '' then
    if v_selected_plan not in ('starter', 'business', 'enterprise')
      or v_selected_billing not in ('monthly', 'yearly') then
      raise exception 'PROMOTION_CODE_INVALID';
    end if;

    select *
    into v_promotion
    from public.promotion_codes pc
    where public.growup_normalize_promotion_code(pc.code) = v_promotion_code
    for update;

    if not found
      or not v_promotion.active
      or not v_selected_plan = any(v_promotion.applicable_plans)
      or not v_selected_billing = any(v_promotion.applicable_billing) then
      raise exception 'PROMOTION_CODE_INVALID';
    end if;

    if (v_promotion.starts_at is not null and v_promotion.starts_at > now())
      or (v_promotion.ends_at is not null and v_promotion.ends_at < now()) then
      raise exception 'PROMOTION_CODE_EXPIRED';
    end if;

    if v_promotion.max_redemptions is not null then
      select count(*) into v_total_redemptions
      from public.promotion_redemptions pr
      where pr.promotion_code_id = v_promotion.id;
      if v_total_redemptions >= v_promotion.max_redemptions then
        raise exception 'PROMOTION_CODE_EXHAUSTED';
      end if;
    end if;
  end if;

  if v_name = '' then
    v_name := v_business_name;
  end if;

  insert into public.users (id, username, password_hash, name, role, phone, is_active)
  values (v_user_id, v_username, v_password_hash, v_name, 'Owner', '', true);

  insert into public.tenants (name, status, metadata)
  values (
    v_business_name,
    'active',
    jsonb_strip_nulls(jsonb_build_object(
      'source', 'public_signup',
      'selected_plan', nullif(v_selected_plan, ''),
      'selected_billing', nullif(v_selected_billing, '')
    ))
  )
  returning id into v_tenant_id;

  insert into public.tenant_memberships (tenant_id, user_id, role, is_active)
  values (v_tenant_id, v_user_id, 'Owner', true);

  insert into public.tenant_role_permissions (tenant_id, role, permissions)
  values
    (v_tenant_id, 'Owner', '{}'::jsonb),
    (v_tenant_id, 'Admin', '{}'::jsonb),
    (v_tenant_id, 'Staff', '{}'::jsonb)
  on conflict (tenant_id, role) do nothing;

  for v_setting in
    select key, value
    from jsonb_each(coalesce(p_defaults->'settings', '{}'::jsonb))
  loop
    insert into public.settings (id, key, value, tenant_id)
    values (v_tenant_id::text || ':' || v_setting.key, v_setting.key, v_setting.value, v_tenant_id)
    on conflict (tenant_id, key) do update
      set value = excluded.value;
  end loop;

  for v_rule in
    select jars, days
    from jsonb_to_recordset(coalesce(p_defaults->'followUpRules', '[]'::jsonb)) as x(jars integer, days integer)
    where jars is not null and days is not null
  loop
    insert into public.follow_up_rules (id, jars, days, tenant_id)
    values (v_tenant_id::text || ':' || v_rule.jars::text, v_rule.jars, v_rule.days, v_tenant_id)
    on conflict (tenant_id, jars) do update
      set days = excluded.days;
  end loop;

  if v_promotion_code <> '' then
    insert into public.promotion_redemptions (
      promotion_code_id,
      tenant_id,
      selected_plan,
      selected_billing,
      benefit_type,
      benefit_value,
      benefit_description
    )
    values (
      v_promotion.id,
      v_tenant_id,
      v_selected_plan,
      v_selected_billing,
      v_promotion.benefit_type,
      v_promotion.benefit_value,
      public.growup_promotion_benefit_description(v_promotion.benefit_type, v_promotion.benefit_value)
    );
  end if;

  insert into public.signup_bootstraps (idempotency_key, username, user_id, tenant_id, status)
  values (v_idempotency_key, v_username, v_user_id, v_tenant_id, 'completed');

  return query
    select u.id, u.username, u.name, u.role, u.phone, u.is_active, t.id, t.name, tm.role
    from public.users u
    join public.tenants t on t.id = v_tenant_id
    join public.tenant_memberships tm on tm.tenant_id = t.id and tm.user_id = u.id
    where u.id = v_user_id
    limit 1;
end;
$$;

comment on table public.promotion_codes is 'Authoritative promotion code definitions for future signup and subscription campaigns. No public codes are seeded by this migration.';
comment on table public.promotion_redemptions is 'Immutable promotion redemption snapshots captured during public signup for future subscription/payment application.';
