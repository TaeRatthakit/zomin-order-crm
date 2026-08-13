-- Growup Pilot Subscription Core for public signup.
-- Additive schema plus atomic signup RPC replacement. No payment activation, gateway, invoice, or production data backfill.

create extension if not exists pgcrypto;

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  source text not null default 'public_signup' check (source in ('public_signup')),
  is_initial boolean not null default true,
  plan text not null check (plan in ('starter', 'business', 'enterprise')),
  billing_interval text not null check (billing_interval in ('monthly', 'yearly')),
  status text not null check (status in ('trialing', 'pending_payment', 'active', 'past_due', 'cancelled', 'expired')),
  currency text not null default 'THB' check (currency = 'THB'),
  base_amount_minor integer not null check (base_amount_minor >= 0),
  discount_amount_minor integer not null default 0 check (discount_amount_minor >= 0),
  amount_due_minor integer not null check (amount_due_minor >= 0),
  promotion_code_id uuid references public.promotion_codes(id) on delete restrict,
  promotion_redemption_id uuid unique references public.promotion_redemptions(id) on delete restrict,
  promotion_code text,
  promotion_benefit_type text check (promotion_benefit_type is null or promotion_benefit_type in ('percent_discount', 'fixed_amount_discount', 'extra_trial_days', 'free_months')),
  promotion_benefit_value numeric(12, 2),
  promotion_benefit_description text,
  promotion_applicable_plans text[],
  promotion_applicable_billing text[],
  promotion_snapshot jsonb not null default '{}'::jsonb,
  extra_trial_days integer not null default 0 check (extra_trial_days >= 0),
  free_months integer not null default 0 check (free_months >= 0),
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  current_period_started_at timestamptz,
  current_period_ends_at timestamptz,
  next_renewal_at timestamptz,
  payment_due_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (discount_amount_minor <= base_amount_minor),
  check (amount_due_minor = base_amount_minor - discount_amount_minor),
  check (
    (status = 'trialing' and trial_started_at is not null and trial_ends_at is not null)
    or status <> 'trialing'
  )
);

create unique index if not exists uniq_subscriptions_initial_tenant
on public.subscriptions (tenant_id)
where is_initial = true;

create index if not exists idx_subscriptions_tenant_status
on public.subscriptions (tenant_id, status);

create index if not exists idx_subscriptions_plan_billing
on public.subscriptions (plan, billing_interval);

create index if not exists idx_subscriptions_promotion_code
on public.subscriptions (promotion_code_id)
where promotion_code_id is not null;

drop trigger if exists subscriptions_updated_at on public.subscriptions;
create trigger subscriptions_updated_at before update on public.subscriptions
for each row execute function public.set_updated_at();

alter table public.subscriptions enable row level security;

create or replace function public.growup_subscription_base_amount_minor(
  p_plan text,
  p_billing text
)
returns integer
language plpgsql
immutable
as $$
declare
  v_plan text := lower(trim(coalesce(p_plan, '')));
  v_billing text := lower(trim(coalesce(p_billing, '')));
begin
  if v_plan = 'starter' and v_billing = 'monthly' then return 49000; end if;
  if v_plan = 'starter' and v_billing = 'yearly' then return 490000; end if;
  if v_plan = 'business' and v_billing = 'monthly' then return 99000; end if;
  if v_plan = 'business' and v_billing = 'yearly' then return 990000; end if;
  if v_plan = 'enterprise' and v_billing = 'monthly' then return 199000; end if;
  if v_plan = 'enterprise' and v_billing = 'yearly' then return 1990000; end if;
  raise exception 'INVALID_SUBSCRIPTION_PLAN';
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
  v_selected_plan text := lower(trim(coalesce(nullif(p_selected_plan, ''), 'starter')));
  v_selected_billing text := lower(trim(coalesce(nullif(p_selected_billing, ''), 'monthly')));
  v_tenant_id uuid;
  v_setting record;
  v_rule record;
  v_promotion public.promotion_codes%rowtype;
  v_total_redemptions integer := 0;
  v_promotion_redemption_id uuid;
  v_base_amount_minor integer;
  v_discount_amount_minor integer := 0;
  v_extra_trial_days integer := 0;
  v_free_months integer := 0;
  v_status text;
  v_trial_started_at timestamptz;
  v_trial_ends_at timestamptz;
  v_payment_due_at timestamptz;
begin
  if length(v_idempotency_key) < 8
    or length(v_idempotency_key) > 120
    or length(v_user_id) < 3
    or length(v_user_id) > 120
    or length(v_username) < 3
    or length(v_username) > 120
    or length(v_password_hash) < 20
    or length(v_business_name) < 2
    or length(v_business_name) > 120
    or v_selected_plan not in ('starter', 'business', 'enterprise')
    or v_selected_billing not in ('monthly', 'yearly') then
    raise exception 'INVALID_SIGNUP_INPUT';
  end if;

  v_base_amount_minor := public.growup_subscription_base_amount_minor(v_selected_plan, v_selected_billing);

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

    if v_promotion.benefit_type = 'percent_discount' then
      v_discount_amount_minor := least(v_base_amount_minor, round((v_base_amount_minor::numeric * v_promotion.benefit_value) / 100)::integer);
    elsif v_promotion.benefit_type = 'fixed_amount_discount' then
      v_discount_amount_minor := least(v_base_amount_minor, round(v_promotion.benefit_value * 100)::integer);
    elsif v_promotion.benefit_type = 'extra_trial_days' then
      v_extra_trial_days := greatest(0, floor(v_promotion.benefit_value)::integer);
    elsif v_promotion.benefit_type = 'free_months' then
      v_free_months := greatest(0, floor(v_promotion.benefit_value)::integer);
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
      'selected_plan', v_selected_plan,
      'selected_billing', v_selected_billing
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
    )
    returning id into v_promotion_redemption_id;
  end if;

  if v_selected_plan = 'starter' then
    v_status := 'trialing';
    v_trial_started_at := now();
    v_trial_ends_at := v_trial_started_at + ((30 + v_extra_trial_days)::text || ' days')::interval;
    v_payment_due_at := v_trial_ends_at;
  else
    v_status := 'pending_payment';
    v_payment_due_at := now();
  end if;

  insert into public.subscriptions (
    tenant_id,
    plan,
    billing_interval,
    status,
    base_amount_minor,
    discount_amount_minor,
    amount_due_minor,
    promotion_code_id,
    promotion_redemption_id,
    promotion_code,
    promotion_benefit_type,
    promotion_benefit_value,
    promotion_benefit_description,
    promotion_applicable_plans,
    promotion_applicable_billing,
    promotion_snapshot,
    extra_trial_days,
    free_months,
    trial_started_at,
    trial_ends_at,
    current_period_started_at,
    current_period_ends_at,
    next_renewal_at,
    payment_due_at
  )
  values (
    v_tenant_id,
    v_selected_plan,
    v_selected_billing,
    v_status,
    v_base_amount_minor,
    v_discount_amount_minor,
    v_base_amount_minor - v_discount_amount_minor,
    case when v_promotion_code <> '' then v_promotion.id else null end,
    v_promotion_redemption_id,
    case when v_promotion_code <> '' then public.growup_normalize_promotion_code(v_promotion.code) else null end,
    case when v_promotion_code <> '' then v_promotion.benefit_type else null end,
    case when v_promotion_code <> '' then v_promotion.benefit_value else null end,
    case when v_promotion_code <> '' then public.growup_promotion_benefit_description(v_promotion.benefit_type, v_promotion.benefit_value) else null end,
    case when v_promotion_code <> '' then v_promotion.applicable_plans else null end,
    case when v_promotion_code <> '' then v_promotion.applicable_billing else null end,
    case when v_promotion_code <> '' then jsonb_build_object(
      'promotion_code_id', v_promotion.id,
      'promotion_redemption_id', v_promotion_redemption_id,
      'code', public.growup_normalize_promotion_code(v_promotion.code),
      'benefit_type', v_promotion.benefit_type,
      'benefit_value', v_promotion.benefit_value,
      'benefit_description', public.growup_promotion_benefit_description(v_promotion.benefit_type, v_promotion.benefit_value),
      'applicable_plans', v_promotion.applicable_plans,
      'applicable_billing', v_promotion.applicable_billing,
      'base_amount_minor', v_base_amount_minor,
      'discount_amount_minor', v_discount_amount_minor,
      'amount_due_minor', v_base_amount_minor - v_discount_amount_minor,
      'extra_trial_days', v_extra_trial_days,
      'free_months', v_free_months
    ) else '{}'::jsonb end,
    v_extra_trial_days,
    v_free_months,
    v_trial_started_at,
    v_trial_ends_at,
    case when v_status = 'trialing' then v_trial_started_at else null end,
    case when v_status = 'trialing' then v_trial_ends_at else null end,
    case when v_status = 'trialing' then v_trial_ends_at else null end,
    v_payment_due_at
  );

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

comment on table public.subscriptions is 'Authoritative server-created subscription records for public signup. Stores immutable pricing and promotion snapshots; payment activation is out of scope.';
comment on function public.growup_subscription_base_amount_minor(text, text) is 'Server-side THB price catalog in minor units for signup subscription snapshots.';
