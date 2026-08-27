-- Growup Pilot authoritative subscription lifecycle.
-- Forward-only Preview migration: preserves all historical subscription,
-- payment, attempt, and provider-event rows.

begin;

create extension if not exists pgcrypto;

-- New checkouts support the already-authoritative monthly and yearly catalog.
alter table public.subscription_upgrade_attempts
  drop constraint if exists subscription_upgrade_attempts_billing_interval_check;

alter table public.subscription_upgrade_attempts
  add constraint subscription_upgrade_attempts_billing_interval_check
  check (billing_interval in ('monthly', 'yearly')) not valid;

alter table public.subscription_upgrade_attempts
  validate constraint subscription_upgrade_attempts_billing_interval_check;

-- The approved initial trial is exactly 30 days. Promotion redemption remains
-- historical evidence, but cannot extend or reset the initial trial window.
create or replace function public.growup_enforce_initial_trial_window()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.source = 'public_signup'
    and new.is_initial = true
    and new.status = 'trialing' then
    if new.promotion_benefit_type = 'extra_trial_days' then
      raise exception 'PROMOTION_CODE_INVALID';
    end if;
    new.trial_started_at := coalesce(new.trial_started_at, now());
    new.trial_ends_at := new.trial_started_at + interval '30 days';
    new.current_period_started_at := new.trial_started_at;
    new.current_period_ends_at := new.trial_ends_at;
    new.next_renewal_at := new.trial_ends_at;
    new.payment_due_at := new.trial_ends_at;
    new.extra_trial_days := 0;
    new.promotion_snapshot := coalesce(new.promotion_snapshot, '{}'::jsonb)
      || jsonb_build_object('applied_trial_days', 30, 'applied_extra_trial_days', 0);
  end if;
  return new;
end;
$$;

drop trigger if exists subscriptions_initial_trial_window on public.subscriptions;
create trigger subscriptions_initial_trial_window
before insert on public.subscriptions
for each row execute function public.growup_enforce_initial_trial_window();

create or replace function public.growup_begin_subscription_checkout(
  p_tenant_id uuid,
  p_user_id text,
  p_target_plan text,
  p_billing_interval text,
  p_intent text,
  p_idempotency_key text,
  p_provider text default 'provider_required'
)
returns table (
  payment_id uuid,
  upgrade_id uuid,
  tenant_id uuid,
  subscription_id uuid,
  current_plan text,
  target_plan text,
  operation text,
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
  v_interval text := lower(trim(coalesce(p_billing_interval, '')));
  v_requested_intent text := lower(trim(coalesce(p_intent, '')));
  v_key text := trim(coalesce(p_idempotency_key, ''));
  v_provider text := lower(trim(coalesce(nullif(p_provider, ''), 'provider_required')));
  v_subscription public.subscriptions%rowtype;
  v_payment public.payments%rowtype;
  v_attempt public.subscription_upgrade_attempts%rowtype;
  v_operation text;
  v_existing_operation text;
  v_amount integer;
  v_now timestamptz := now();
  v_started_at timestamptz;
  v_ends_at timestamptz;
  v_current_rank integer;
  v_target_rank integer;
  v_entitled boolean := false;
begin
  if p_tenant_id is null
    or length(trim(coalesce(p_user_id, ''))) < 2
    or v_target_plan not in ('starter', 'business', 'enterprise')
    or v_interval not in ('monthly', 'yearly')
    or v_requested_intent not in ('subscription_activation', 'subscription_renewal', 'subscription_upgrade')
    or length(v_key) < 8 or length(v_key) > 160 then
    raise exception 'INVALID_SUBSCRIPTION_CHECKOUT_INPUT';
  end if;

  if not exists (
    select 1 from public.tenant_memberships tm
    where tm.tenant_id = p_tenant_id
      and tm.user_id = p_user_id
      and tm.is_active = true
      and lower(trim(tm.role)) = 'owner'
  ) then
    raise exception 'SUBSCRIPTION_CHECKOUT_OWNER_REQUIRED';
  end if;

  select * into v_subscription
  from public.subscriptions s
  where s.tenant_id = p_tenant_id and s.is_initial = true
  for update;
  if not found then raise exception 'SUBSCRIPTION_NOT_FOUND'; end if;

  v_current_rank := case v_subscription.plan when 'starter' then 0 when 'business' then 1 when 'enterprise' then 2 else -1 end;
  v_target_rank := case v_target_plan when 'starter' then 0 when 'business' then 1 when 'enterprise' then 2 else -1 end;
  if v_target_rank < v_current_rank then raise exception 'SUBSCRIPTION_DOWNGRADE_NOT_ALLOWED'; end if;

  v_entitled := (v_subscription.status = 'trialing' and v_subscription.trial_ends_at > v_now)
    or (v_subscription.status = 'active' and (v_subscription.current_period_ends_at is null or v_subscription.current_period_ends_at > v_now));

  if v_subscription.status = 'pending_payment'
    and v_target_plan = v_subscription.plan
    and v_interval = v_subscription.billing_interval
    and v_subscription.current_period_started_at is null then
    v_operation := 'subscription_activation';
  elsif v_target_plan = v_subscription.plan then
    v_operation := 'subscription_renewal';
  else
    v_operation := 'subscription_upgrade';
  end if;

  if v_requested_intent <> v_operation then raise exception 'SUBSCRIPTION_CHECKOUT_INTENT_MISMATCH'; end if;
  if v_operation = 'subscription_renewal'
    and v_subscription.status = 'trialing'
    and v_subscription.trial_ends_at > v_now then
    raise exception 'PAYMENT_NOT_REQUIRED';
  end if;

  -- First protect request idempotency, then logical pending-payment idempotency.
  select * into v_payment from public.payments p
  where p.tenant_id = p_tenant_id and p.idempotency_key = v_key
  limit 1;
  if found then
    if v_payment.plan <> v_target_plan or v_payment.billing_interval <> v_interval
      or coalesce(v_payment.checkout_metadata->>'operation', '') <> v_operation then
      raise exception 'SUBSCRIPTION_CHECKOUT_IDEMPOTENCY_CONFLICT';
    end if;
  else
    select * into v_payment from public.payments p
    where p.tenant_id = p_tenant_id and p.status in ('pending', 'processing')
    order by p.created_at desc
    limit 1;
    if found then
      v_existing_operation := coalesce(nullif(v_payment.checkout_metadata->>'operation', ''),
        case
          when v_payment.plan <> v_subscription.plan then 'subscription_upgrade'
          when v_subscription.status = 'pending_payment' and v_subscription.current_period_started_at is null then 'subscription_activation'
          else 'subscription_renewal'
        end);
      if v_payment.plan <> v_target_plan or v_payment.billing_interval <> v_interval
        or v_existing_operation <> v_operation then
        raise exception 'SUBSCRIPTION_CHECKOUT_IN_PROGRESS';
      end if;
    end if;
  end if;

  if found then
    select * into v_attempt from public.subscription_upgrade_attempts sua where sua.payment_id = v_payment.id;
    return query select v_payment.id, v_attempt.id, v_payment.tenant_id, v_payment.subscription_id,
      v_subscription.plan, v_payment.plan, coalesce(nullif(v_payment.checkout_metadata->>'operation', ''), v_operation),
      v_payment.provider, v_payment.status, v_payment.currency, v_payment.amount_minor,
      v_payment.billing_interval, v_payment.idempotency_key, v_payment.provider_payment_reference,
      v_payment.billing_period_started_at, v_payment.billing_period_ends_at, v_payment.created_at;
    return;
  end if;

  v_amount := case
    when v_operation = 'subscription_activation' then v_subscription.amount_due_minor
    else public.growup_subscription_base_amount_minor(v_target_plan, v_interval)
  end;
  if v_amount <= 0 then raise exception 'ZERO_AMOUNT_CHECKOUT_REQUIRES_ACTIVATION'; end if;

  v_started_at := case
    when v_operation = 'subscription_renewal' and v_entitled and v_subscription.status = 'active'
      and v_subscription.current_period_ends_at > v_now then v_subscription.current_period_ends_at
    else v_now
  end;
  v_ends_at := public.growup_payment_period_end(v_started_at, v_interval);

  insert into public.payments (
    tenant_id, subscription_id, idempotency_key, provider, status, currency,
    amount_minor, plan, billing_interval, billing_period_started_at,
    billing_period_ends_at, checkout_metadata, created_by_user_id
  ) values (
    p_tenant_id, v_subscription.id, v_key, v_provider, 'pending', 'THB',
    v_amount, v_target_plan, v_interval, v_started_at, v_ends_at,
    jsonb_build_object(
      'source', 'growup_subscription_lifecycle',
      'operation', v_operation,
      'current_plan', v_subscription.plan,
      'target_plan', v_target_plan,
      'billing_interval', v_interval,
      'amount_minor', v_amount,
      'currency', 'THB'
    ), p_user_id
  ) returning * into v_payment;

  if v_operation = 'subscription_upgrade' then
    insert into public.subscription_upgrade_attempts (
      tenant_id, subscription_id, payment_id, idempotency_key, current_plan,
      target_plan, currency, amount_minor, billing_interval, provider,
      created_by_user_id
    ) values (
      p_tenant_id, v_subscription.id, v_payment.id, v_key, v_subscription.plan,
      v_target_plan, 'THB', v_amount, v_interval, v_provider, p_user_id
    ) returning * into v_attempt;
  end if;

  -- Normalize only the label; request-time entitlement was already authoritative.
  if (v_subscription.status = 'trialing' and v_subscription.trial_ends_at <= v_now)
    or (v_subscription.status = 'active' and v_subscription.current_period_ends_at is not null
      and v_subscription.current_period_ends_at <= v_now) then
    update public.subscriptions set status = 'expired', updated_at = v_now where id = v_subscription.id;
  end if;

  return query select v_payment.id, v_attempt.id, v_payment.tenant_id, v_payment.subscription_id,
    v_subscription.plan, v_payment.plan, v_operation, v_payment.provider, v_payment.status,
    v_payment.currency, v_payment.amount_minor, v_payment.billing_interval,
    v_payment.idempotency_key, v_payment.provider_payment_reference,
    v_payment.billing_period_started_at, v_payment.billing_period_ends_at, v_payment.created_at;
end;
$$;

create or replace function public.growup_record_subscription_checkout_success(
  p_provider text,
  p_provider_event_id text,
  p_payment_id uuid,
  p_provider_payment_reference text,
  p_amount_minor integer,
  p_currency text,
  p_raw_event jsonb default '{}'::jsonb
)
returns table (
  payment_id uuid,
  subscription_id uuid,
  tenant_id uuid,
  status text,
  paid_at timestamptz,
  operation text
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
  v_subscription public.subscriptions%rowtype;
  v_attempt public.subscription_upgrade_attempts%rowtype;
  v_existing_event public.payment_provider_events%rowtype;
  v_operation text;
  v_now timestamptz := now();
  v_base_amount integer;
begin
  if length(v_provider) < 2 or length(v_event_id) < 3 or p_payment_id is null
    or p_amount_minor is null or v_currency <> 'THB' then
    raise exception 'INVALID_SUBSCRIPTION_CHECKOUT_EVENT';
  end if;

  select * into v_payment from public.payments p where p.id = p_payment_id for update;
  if not found then raise exception 'PAYMENT_NOT_FOUND'; end if;
  v_operation := coalesce(v_payment.checkout_metadata->>'operation', 'subscription_activation');
  if v_operation not in ('subscription_activation', 'subscription_renewal', 'subscription_upgrade') then
    raise exception 'SUBSCRIPTION_CHECKOUT_EVENT_MISMATCH';
  end if;
  select * into v_subscription from public.subscriptions s
  where s.id = v_payment.subscription_id and s.tenant_id = v_payment.tenant_id for update;
  if not found then raise exception 'SUBSCRIPTION_NOT_FOUND'; end if;
  select * into v_attempt from public.subscription_upgrade_attempts sua where sua.payment_id = v_payment.id for update;

  select * into v_existing_event from public.payment_provider_events ppe
  where ppe.provider = v_provider and ppe.provider_event_id = v_event_id limit 1;
  if found then
    return query select v_payment.id, v_payment.subscription_id, v_payment.tenant_id,
      v_payment.status, v_payment.paid_at, v_operation;
    return;
  end if;

  insert into public.payment_provider_events (provider, provider_event_id, payment_id, event_type, status, raw_event)
  values (v_provider, v_event_id, v_payment.id, 'subscription_checkout_payment_succeeded', 'received', coalesce(p_raw_event, '{}'::jsonb));

  if v_payment.status = 'paid' then
    update public.payment_provider_events set status = 'ignored', processed_at = v_now
    where provider = v_provider and provider_event_id = v_event_id;
    return query select v_payment.id, v_payment.subscription_id, v_payment.tenant_id,
      v_payment.status, v_payment.paid_at, v_operation;
    return;
  end if;

  if v_payment.provider <> v_provider or v_payment.amount_minor <> p_amount_minor
    or v_payment.currency <> v_currency or v_payment.status not in ('pending', 'processing')
    or (v_payment.provider_payment_reference is not null and v_payment.provider_payment_reference <> v_reference)
    or v_payment.billing_period_started_at is null or v_payment.billing_period_ends_at is null
    or v_payment.billing_period_ends_at <= v_payment.billing_period_started_at
    or (v_operation = 'subscription_upgrade' and (v_attempt.id is null
      or v_attempt.status not in ('pending', 'processing')
      or v_attempt.current_plan <> v_subscription.plan
      or v_attempt.target_plan <> v_payment.plan
      or v_attempt.billing_interval <> v_payment.billing_interval))
    or (v_operation <> 'subscription_upgrade' and v_payment.plan <> v_subscription.plan) then
    update public.payment_provider_events set status = 'rejected', error = 'SUBSCRIPTION_CHECKOUT_EVENT_MISMATCH', processed_at = v_now
    where provider = v_provider and provider_event_id = v_event_id;
    raise exception 'SUBSCRIPTION_CHECKOUT_EVENT_MISMATCH';
  end if;

  update public.payments set status = 'paid',
    provider_payment_reference = coalesce(nullif(v_reference, ''), provider_payment_reference),
    paid_at = coalesce(paid_at, v_now),
    provider_metadata = coalesce(provider_metadata, '{}'::jsonb)
      || jsonb_build_object('last_event_id', v_event_id, 'last_provider_status', 'succeeded')
  where id = v_payment.id returning * into v_payment;

  v_base_amount := public.growup_subscription_base_amount_minor(v_payment.plan, v_payment.billing_interval);
  update public.subscriptions set
    plan = v_payment.plan,
    billing_interval = v_payment.billing_interval,
    status = 'active',
    currency = v_payment.currency,
    base_amount_minor = v_base_amount,
    discount_amount_minor = greatest(0, v_base_amount - v_payment.amount_minor),
    amount_due_minor = v_payment.amount_minor,
    current_period_started_at = v_payment.billing_period_started_at,
    current_period_ends_at = v_payment.billing_period_ends_at,
    next_renewal_at = v_payment.billing_period_ends_at,
    payment_due_at = v_payment.billing_period_ends_at,
    updated_at = v_now
  where id = v_subscription.id;

  if v_attempt.id is not null then
    update public.subscription_upgrade_attempts set status = 'paid',
      provider_payment_reference = coalesce(nullif(v_reference, ''), provider_payment_reference),
      paid_at = coalesce(paid_at, v_now), updated_at = v_now
    where id = v_attempt.id;
  end if;

  update public.payment_provider_events set status = 'processed', processed_at = v_now
  where provider = v_provider and provider_event_id = v_event_id;

  return query select v_payment.id, v_payment.subscription_id, v_payment.tenant_id,
    v_payment.status, v_payment.paid_at, v_operation;
end;
$$;

-- Compatibility wrappers keep rollback-safe callers on the same activation contract.
create or replace function public.growup_record_provider_payment_success(
  p_provider text,
  p_provider_event_id text,
  p_payment_id uuid,
  p_provider_payment_reference text,
  p_amount_minor integer,
  p_currency text,
  p_raw_event jsonb default '{}'::jsonb
)
returns table (payment_id uuid, subscription_id uuid, tenant_id uuid, status text, paid_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select r.payment_id, r.subscription_id, r.tenant_id, r.status, r.paid_at
  from public.growup_record_subscription_checkout_success(
    p_provider, p_provider_event_id, p_payment_id, p_provider_payment_reference,
    p_amount_minor, p_currency, p_raw_event
  ) r;
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
  upgrade_id uuid, payment_id uuid, subscription_id uuid, tenant_id uuid,
  status text, current_plan text, target_plan text, paid_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_result record;
  v_attempt public.subscription_upgrade_attempts%rowtype;
begin
  select * into v_result from public.growup_record_subscription_checkout_success(
    p_provider, p_provider_event_id, p_payment_id, p_provider_payment_reference,
    p_amount_minor, p_currency, p_raw_event
  );
  select * into v_attempt from public.subscription_upgrade_attempts sua where sua.payment_id = p_payment_id;
  return query select v_attempt.id, v_result.payment_id, v_result.subscription_id,
    v_result.tenant_id, v_attempt.status, v_attempt.current_plan, v_attempt.target_plan, v_result.paid_at;
end;
$$;

comment on function public.growup_begin_subscription_checkout(uuid, text, text, text, text, text, text)
is 'Owner-only tenant checkout contract for activation, same-plan renewal, interval selection, and forward upgrades. Reuses one compatible pending payment.';
comment on function public.growup_record_subscription_checkout_success(text, text, uuid, text, integer, text, jsonb)
is 'Single verified-provider activation contract. Applies a paid period exactly once and preserves historical trial timestamps.';

revoke execute on function public.growup_enforce_initial_trial_window() from public, anon, authenticated;
revoke execute on function public.growup_begin_subscription_checkout(uuid, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.growup_begin_subscription_checkout(uuid, text, text, text, text, text, text) to service_role;
revoke execute on function public.growup_record_subscription_checkout_success(text, text, uuid, text, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.growup_record_subscription_checkout_success(text, text, uuid, text, integer, text, jsonb) to service_role;
revoke execute on function public.growup_record_provider_payment_success(text, text, uuid, text, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.growup_record_provider_payment_success(text, text, uuid, text, integer, text, jsonb) to service_role;
revoke execute on function public.growup_record_subscription_upgrade_success(text, text, uuid, text, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.growup_record_subscription_upgrade_success(text, text, uuid, text, integer, text, jsonb) to service_role;

commit;
