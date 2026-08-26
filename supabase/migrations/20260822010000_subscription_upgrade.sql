-- Growup Pilot forward-only subscription plan upgrades.
-- This migration is additive. Existing signup and renewal payment contracts remain unchanged.

create extension if not exists pgcrypto;

create table if not exists public.subscription_upgrade_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  subscription_id uuid not null references public.subscriptions(id) on delete restrict,
  payment_id uuid not null unique references public.payments(id) on delete restrict,
  idempotency_key text not null,
  current_plan text not null check (current_plan in ('starter', 'business', 'enterprise')),
  target_plan text not null check (target_plan in ('starter', 'business', 'enterprise')),
  currency text not null default 'THB' check (currency = 'THB'),
  amount_minor integer not null check (amount_minor > 0),
  billing_interval text not null default 'monthly' check (billing_interval = 'monthly'),
  provider text not null,
  provider_payment_reference text,
  status text not null default 'pending' check (status in ('pending', 'processing', 'paid', 'failed', 'expired', 'cancelled')),
  created_by_user_id text references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz,
  failed_at timestamptz,
  expired_at timestamptz,
  cancelled_at timestamptz,
  check (current_plan <> target_plan),
  check (length(trim(idempotency_key)) between 8 and 160),
  check (length(trim(provider)) between 2 and 80)
);

create unique index if not exists uniq_subscription_upgrade_tenant_idempotency
on public.subscription_upgrade_attempts (tenant_id, idempotency_key);

create index if not exists idx_subscription_upgrade_tenant_status
on public.subscription_upgrade_attempts (tenant_id, status, created_at desc);

create index if not exists idx_subscription_upgrade_provider_reference
on public.subscription_upgrade_attempts (provider, provider_payment_reference)
where provider_payment_reference is not null;

drop trigger if exists subscription_upgrade_attempts_updated_at on public.subscription_upgrade_attempts;
create trigger subscription_upgrade_attempts_updated_at before update on public.subscription_upgrade_attempts
for each row execute function public.set_updated_at();

alter table public.subscription_upgrade_attempts enable row level security;

create or replace function public.growup_begin_subscription_upgrade(
  p_tenant_id uuid,
  p_user_id text,
  p_target_plan text,
  p_idempotency_key text,
  p_provider text default 'provider_required'
)
returns table (
  upgrade_id uuid,
  payment_id uuid,
  tenant_id uuid,
  subscription_id uuid,
  current_plan text,
  target_plan text,
  provider text,
  status text,
  currency text,
  amount_minor integer,
  billing_interval text,
  idempotency_key text,
  provider_payment_reference text,
  billing_period_started_at timestamptz,
  billing_period_ends_at timestamptz,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_target_plan text := lower(trim(coalesce(p_target_plan, '')));
  v_provider text := lower(trim(coalesce(nullif(p_provider, ''), 'provider_required')));
  v_key text := trim(coalesce(p_idempotency_key, ''));
  v_subscription public.subscriptions%rowtype;
  v_existing public.subscription_upgrade_attempts%rowtype;
  v_payment public.payments%rowtype;
  v_amount integer;
  v_now timestamptz := now();
  v_started_at timestamptz := now();
  v_ends_at timestamptz;
begin
  if p_tenant_id is null
    or length(trim(coalesce(p_user_id, ''))) < 2
    or v_target_plan not in ('starter', 'business', 'enterprise')
    or length(v_key) < 8
    or length(v_key) > 160
    or length(v_provider) < 2 then
    raise exception 'INVALID_SUBSCRIPTION_UPGRADE_INPUT';
  end if;

  if not exists (
    select 1
    from public.tenant_memberships tm
    where tm.tenant_id = p_tenant_id
      and tm.user_id = p_user_id
      and tm.is_active = true
      and lower(trim(tm.role)) = 'owner'
  ) then
    raise exception 'UPGRADE_TENANT_FORBIDDEN';
  end if;

  select *
  into v_subscription
  from public.subscriptions s
  where s.tenant_id = p_tenant_id
    and s.is_initial = true
  for update;

  if not found then raise exception 'SUBSCRIPTION_NOT_FOUND'; end if;

  if v_subscription.plan = 'enterprise'
    or (v_subscription.plan = 'business' and v_target_plan <> 'enterprise')
    or (v_subscription.plan = 'starter' and v_target_plan = 'starter')
    or (v_subscription.plan = 'starter' and v_target_plan not in ('business', 'enterprise')) then
    raise exception 'UPGRADE_NOT_ALLOWED';
  end if;

  if v_subscription.status in ('cancelled', 'expired') then
    raise exception 'SUBSCRIPTION_NOT_UPGRADABLE';
  end if;

  select *
  into v_existing
  from public.subscription_upgrade_attempts sua
  where sua.tenant_id = p_tenant_id
    and sua.idempotency_key = v_key
  limit 1;

  if found then
    if v_existing.current_plan <> v_subscription.plan or v_existing.target_plan <> v_target_plan then
      raise exception 'UPGRADE_IDEMPOTENCY_CONFLICT';
    end if;
    select * into v_payment from public.payments p where p.id = v_existing.payment_id;
    return query
      select v_existing.id, v_payment.id, v_existing.tenant_id, v_existing.subscription_id,
        v_existing.current_plan, v_existing.target_plan, v_existing.provider, v_existing.status,
        v_existing.currency, v_existing.amount_minor, v_existing.billing_interval,
        v_existing.idempotency_key, v_existing.provider_payment_reference,
        v_payment.billing_period_started_at, v_payment.billing_period_ends_at, v_existing.created_at;
    return;
  end if;

  -- A retry for the same target plan resumes the existing provider payment.
  -- A different target remains blocked so one tenant cannot create competing upgrades.
  select *
  into v_existing
  from public.subscription_upgrade_attempts sua
  where sua.tenant_id = p_tenant_id
    and sua.status in ('pending', 'processing')
  order by sua.created_at desc
  limit 1;

  if found then
    select * into v_payment from public.payments p where p.id = v_existing.payment_id;
    if v_payment.status in ('failed', 'cancelled', 'expired') then
      -- A provider-terminal payment cannot keep a retry blocked. Preserve
      -- the payment row as historical evidence and close only the stale
      -- attempt snapshot before creating the new owner-authorized attempt.
      update public.subscription_upgrade_attempts
      set status = v_payment.status,
          provider_payment_reference = coalesce(provider_payment_reference, v_payment.provider_payment_reference),
          failed_at = case when v_payment.status = 'failed' then coalesce(failed_at, v_payment.failed_at, v_now) else failed_at end,
          expired_at = case when v_payment.status = 'expired' then coalesce(expired_at, v_payment.expired_at, v_now) else expired_at end,
          cancelled_at = case when v_payment.status = 'cancelled' then coalesce(cancelled_at, v_payment.cancelled_at, v_now) else cancelled_at end,
          updated_at = v_now
      where id = v_existing.id;
    else
      if v_existing.target_plan <> v_target_plan then
        raise exception 'UPGRADE_IN_PROGRESS';
      end if;
      return query
        select v_existing.id, v_payment.id, v_existing.tenant_id, v_existing.subscription_id,
          v_existing.current_plan, v_existing.target_plan, v_existing.provider, v_existing.status,
          v_existing.currency, v_existing.amount_minor, v_existing.billing_interval,
          v_existing.idempotency_key, v_existing.provider_payment_reference,
          v_payment.billing_period_started_at, v_payment.billing_period_ends_at, v_existing.created_at;
      return;
    end if;
  end if;

  if exists (
    select 1 from public.subscription_upgrade_attempts sua
    where sua.tenant_id = p_tenant_id
      and sua.status in ('pending', 'processing')
  ) then
    raise exception 'UPGRADE_IN_PROGRESS';
  end if;

  v_amount := public.growup_subscription_base_amount_minor(v_target_plan, 'monthly');
  v_ends_at := public.growup_payment_period_end(v_started_at, 'monthly');

  insert into public.payments (
    tenant_id, subscription_id, idempotency_key, provider, status, currency,
    amount_minor, plan, billing_interval, billing_period_started_at,
    billing_period_ends_at, checkout_metadata, created_by_user_id
  ) values (
    p_tenant_id, v_subscription.id, v_key, v_provider, 'pending', 'THB',
    v_amount, v_target_plan, 'monthly', v_started_at, v_ends_at,
    jsonb_build_object(
      'operation', 'subscription_upgrade',
      'current_plan', v_subscription.plan,
      'target_plan', v_target_plan,
      'amount_minor', v_amount,
      'currency', 'THB',
      'billing_interval', 'monthly'
    ), p_user_id
  ) returning * into v_payment;

  insert into public.subscription_upgrade_attempts (
    tenant_id, subscription_id, payment_id, idempotency_key, current_plan,
    target_plan, currency, amount_minor, billing_interval, provider,
    created_by_user_id
  ) values (
    p_tenant_id, v_subscription.id, v_payment.id, v_key, v_subscription.plan,
    v_target_plan, 'THB', v_amount, 'monthly', v_provider, p_user_id
  ) returning * into v_existing;

  return query
    select v_existing.id, v_payment.id, v_existing.tenant_id, v_existing.subscription_id,
      v_existing.current_plan, v_existing.target_plan, v_existing.provider, v_existing.status,
      v_existing.currency, v_existing.amount_minor, v_existing.billing_interval,
      v_existing.idempotency_key, v_existing.provider_payment_reference,
      v_payment.billing_period_started_at, v_payment.billing_period_ends_at, v_existing.created_at;
end;
$$;

create or replace function public.growup_record_subscription_upgrade_status(
  p_provider text,
  p_provider_event_id text,
  p_payment_id uuid,
  p_provider_payment_reference text,
  p_amount_minor integer,
  p_currency text,
  p_status text,
  p_raw_event jsonb default '{}'::jsonb
)
returns table (
  upgrade_id uuid,
  payment_id uuid,
  subscription_id uuid,
  tenant_id uuid,
  status text,
  current_plan text,
  target_plan text,
  paid_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_provider text := lower(trim(coalesce(p_provider, '')));
  v_event_id text := trim(coalesce(p_provider_event_id, ''));
  v_reference text := trim(coalesce(p_provider_payment_reference, ''));
  v_currency text := upper(trim(coalesce(p_currency, '')));
  v_status text := lower(trim(coalesce(p_status, '')));
  v_payment public.payments%rowtype;
  v_attempt public.subscription_upgrade_attempts%rowtype;
  v_existing_event public.payment_provider_events%rowtype;
  v_now timestamptz := now();
begin
  if length(v_provider) < 2 or length(v_event_id) < 3 or p_payment_id is null
    or p_amount_minor is null or v_currency <> 'THB'
    or v_status not in ('processing', 'failed', 'expired', 'cancelled') then
    raise exception 'INVALID_SUBSCRIPTION_UPGRADE_EVENT';
  end if;

  select * into v_attempt from public.subscription_upgrade_attempts sua where sua.payment_id = p_payment_id for update;
  if not found then raise exception 'SUBSCRIPTION_UPGRADE_NOT_FOUND'; end if;
  select * into v_payment from public.payments p where p.id = p_payment_id for update;

  select * into v_existing_event
  from public.payment_provider_events ppe
  where ppe.provider = v_provider and ppe.provider_event_id = v_event_id
  limit 1;
  if found then
    return query select v_attempt.id, v_payment.id, v_attempt.subscription_id, v_attempt.tenant_id,
      v_attempt.status, v_attempt.current_plan, v_attempt.target_plan, v_payment.paid_at;
    return;
  end if;

  insert into public.payment_provider_events (provider, provider_event_id, payment_id, event_type, status, raw_event)
  values (v_provider, v_event_id, v_payment.id, 'subscription_upgrade_payment_' || v_status, 'received', coalesce(p_raw_event, '{}'::jsonb));

  if v_payment.provider <> v_provider or v_payment.amount_minor <> p_amount_minor
    or v_payment.currency <> v_currency or v_payment.status not in ('pending', 'processing')
    or (v_payment.provider_payment_reference is not null and v_payment.provider_payment_reference <> v_reference) then
    update public.payment_provider_events set status = 'rejected', error = 'SUBSCRIPTION_UPGRADE_EVENT_MISMATCH', processed_at = v_now
    where provider = v_provider and provider_event_id = v_event_id;
    raise exception 'SUBSCRIPTION_UPGRADE_EVENT_MISMATCH';
  end if;

  update public.payments set status = v_status,
    provider_payment_reference = coalesce(nullif(v_reference, ''), provider_payment_reference),
    failed_at = case when v_status = 'failed' then v_now else failed_at end,
    expired_at = case when v_status = 'expired' then v_now else expired_at end,
    cancelled_at = case when v_status = 'cancelled' then v_now else cancelled_at end,
    provider_metadata = coalesce(provider_metadata, '{}'::jsonb) || jsonb_build_object('last_event_id', v_event_id, 'last_provider_status', v_status)
  where id = v_payment.id returning * into v_payment;

  update public.subscription_upgrade_attempts set status = v_status,
    provider_payment_reference = coalesce(nullif(v_reference, ''), provider_payment_reference), updated_at = v_now,
    failed_at = case when v_status = 'failed' then v_now else failed_at end,
    expired_at = case when v_status = 'expired' then v_now else expired_at end,
    cancelled_at = case when v_status = 'cancelled' then v_now else cancelled_at end
  where id = v_attempt.id returning * into v_attempt;

  update public.payment_provider_events set status = 'processed', processed_at = v_now
  where provider = v_provider and provider_event_id = v_event_id;

  return query select v_attempt.id, v_payment.id, v_attempt.subscription_id, v_attempt.tenant_id,
    v_attempt.status, v_attempt.current_plan, v_attempt.target_plan, v_payment.paid_at;
end;
$$;

create or replace function public.growup_record_subscription_upgrade_success(
  p_provider text,
  p_provider_event_id text,
  p_payment_id uuid,
  p_provider_payment_reference text,
  p_amount_minor integer,
  p_currency text,
  p_raw_event jsonb default '{}'::jsonb
)
returns table (
  upgrade_id uuid,
  payment_id uuid,
  subscription_id uuid,
  tenant_id uuid,
  status text,
  current_plan text,
  target_plan text,
  paid_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_provider text := lower(trim(coalesce(p_provider, '')));
  v_event_id text := trim(coalesce(p_provider_event_id, ''));
  v_reference text := trim(coalesce(p_provider_payment_reference, ''));
  v_currency text := upper(trim(coalesce(p_currency, '')));
  v_payment public.payments%rowtype;
  v_attempt public.subscription_upgrade_attempts%rowtype;
  v_subscription public.subscriptions%rowtype;
  v_existing_event public.payment_provider_events%rowtype;
  v_now timestamptz := now();
begin
  if length(v_provider) < 2 or length(v_event_id) < 3 or p_payment_id is null
    or p_amount_minor is null or v_currency <> 'THB' then
    raise exception 'INVALID_SUBSCRIPTION_UPGRADE_EVENT';
  end if;

  select * into v_attempt from public.subscription_upgrade_attempts sua where sua.payment_id = p_payment_id for update;
  if not found then raise exception 'SUBSCRIPTION_UPGRADE_NOT_FOUND'; end if;
  select * into v_payment from public.payments p where p.id = p_payment_id for update;
  select * into v_subscription from public.subscriptions s where s.id = v_attempt.subscription_id for update;

  select * into v_existing_event
  from public.payment_provider_events ppe
  where ppe.provider = v_provider and ppe.provider_event_id = v_event_id
  limit 1;
  if found then
    return query select v_attempt.id, v_payment.id, v_attempt.subscription_id, v_attempt.tenant_id,
      v_attempt.status, v_attempt.current_plan, v_attempt.target_plan, v_payment.paid_at;
    return;
  end if;

  insert into public.payment_provider_events (provider, provider_event_id, payment_id, event_type, status, raw_event)
  values (v_provider, v_event_id, v_payment.id, 'subscription_upgrade_payment_succeeded', 'received', coalesce(p_raw_event, '{}'::jsonb));

  if v_payment.provider <> v_provider or v_payment.amount_minor <> p_amount_minor
    or v_payment.currency <> v_currency or v_payment.status not in ('pending', 'processing')
    or (v_payment.provider_payment_reference is not null and v_payment.provider_payment_reference <> v_reference)
    or v_attempt.status not in ('pending', 'processing')
    or v_subscription.plan <> v_attempt.current_plan then
    update public.payment_provider_events set status = 'rejected', error = 'SUBSCRIPTION_UPGRADE_EVENT_MISMATCH', processed_at = v_now
    where provider = v_provider and provider_event_id = v_event_id;
    raise exception 'SUBSCRIPTION_UPGRADE_EVENT_MISMATCH';
  end if;

  update public.payments set status = 'paid',
    provider_payment_reference = coalesce(nullif(v_reference, ''), provider_payment_reference),
    paid_at = v_now,
    provider_metadata = coalesce(provider_metadata, '{}'::jsonb) || jsonb_build_object('last_event_id', v_event_id, 'last_provider_status', 'succeeded')
  where id = v_payment.id returning * into v_payment;

  update public.subscriptions set
    plan = v_attempt.target_plan,
    billing_interval = v_attempt.billing_interval,
    currency = v_attempt.currency,
    base_amount_minor = v_attempt.amount_minor,
    discount_amount_minor = 0,
    amount_due_minor = v_attempt.amount_minor,
    status = 'active',
    trial_started_at = null,
    trial_ends_at = null,
    current_period_started_at = coalesce(v_payment.billing_period_started_at, v_now),
    current_period_ends_at = coalesce(v_payment.billing_period_ends_at, public.growup_payment_period_end(v_now, 'monthly')),
    next_renewal_at = coalesce(v_payment.billing_period_ends_at, public.growup_payment_period_end(v_now, 'monthly')),
    payment_due_at = coalesce(v_payment.billing_period_ends_at, public.growup_payment_period_end(v_now, 'monthly')),
    promotion_code_id = null,
    promotion_redemption_id = null,
    promotion_code = null,
    promotion_benefit_type = null,
    promotion_benefit_value = null,
    promotion_benefit_description = null,
    promotion_applicable_plans = null,
    promotion_applicable_billing = null,
    promotion_snapshot = '{}'::jsonb,
    extra_trial_days = 0,
    free_months = 0,
    updated_at = v_now
  where id = v_subscription.id and plan = v_attempt.current_plan;

  if not found then
    update public.payment_provider_events set status = 'rejected', error = 'SUBSCRIPTION_UPGRADE_STATE_MISMATCH', processed_at = v_now
    where provider = v_provider and provider_event_id = v_event_id;
    raise exception 'SUBSCRIPTION_UPGRADE_STATE_MISMATCH';
  end if;

  update public.subscription_upgrade_attempts set status = 'paid',
    provider_payment_reference = coalesce(nullif(v_reference, ''), provider_payment_reference),
    paid_at = v_now, updated_at = v_now
  where id = v_attempt.id returning * into v_attempt;

  update public.payment_provider_events set status = 'processed', processed_at = v_now
  where provider = v_provider and provider_event_id = v_event_id;

  return query select v_attempt.id, v_payment.id, v_attempt.subscription_id, v_attempt.tenant_id,
    v_attempt.status, v_attempt.current_plan, v_attempt.target_plan, v_payment.paid_at;
end;
$$;

comment on table public.subscription_upgrade_attempts is 'Authoritative tenant-scoped target-plan upgrade snapshots. A successful verified provider event is required before subscription activation.';
comment on function public.growup_begin_subscription_upgrade(uuid, text, text, text, text) is 'Creates or reuses an owner-authorized monthly target-plan upgrade using the server-side price catalog.';
comment on function public.growup_record_subscription_upgrade_status(text, text, uuid, text, integer, text, text, jsonb) is 'Records non-success upgrade provider events idempotently without changing the subscription plan.';
comment on function public.growup_record_subscription_upgrade_success(text, text, uuid, text, integer, text, jsonb) is 'Atomically applies a verified successful target-plan payment and activates the new subscription plan.';

revoke execute on function public.growup_begin_subscription_upgrade(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.growup_begin_subscription_upgrade(uuid, text, text, text, text) to service_role;
revoke execute on function public.growup_record_subscription_upgrade_status(text, text, uuid, text, integer, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.growup_record_subscription_upgrade_status(text, text, uuid, text, integer, text, text, jsonb) to service_role;
revoke execute on function public.growup_record_subscription_upgrade_success(text, text, uuid, text, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.growup_record_subscription_upgrade_success(text, text, uuid, text, integer, text, jsonb) to service_role;
