-- Growup Pilot Stripe PromptPay provider support.
-- Forward-only additions over provider-independent Payment Core.

create extension if not exists pgcrypto;

create or replace function public.growup_set_payment_provider_reference(
  p_payment_id uuid,
  p_tenant_id uuid,
  p_provider text,
  p_provider_payment_reference text,
  p_status text default 'pending',
  p_provider_metadata jsonb default '{}'::jsonb
)
returns table (
  payment_id uuid,
  tenant_id uuid,
  subscription_id uuid,
  provider text,
  status text,
  currency text,
  amount_minor integer,
  plan text,
  billing_interval text,
  provider_payment_reference text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_payment public.payments%rowtype;
  v_provider text := lower(trim(coalesce(p_provider, '')));
  v_reference text := trim(coalesce(p_provider_payment_reference, ''));
  v_status text := lower(trim(coalesce(p_status, 'pending')));
begin
  if p_payment_id is null
    or p_tenant_id is null
    or length(v_provider) < 2
    or length(v_reference) < 3
    or v_status not in ('pending', 'processing') then
    raise exception 'INVALID_PROVIDER_REFERENCE';
  end if;

  select *
  into v_payment
  from public.payments p
  where p.id = p_payment_id
    and p.tenant_id = p_tenant_id
  for update;

  if not found then
    raise exception 'PAYMENT_NOT_FOUND';
  end if;

  if v_payment.provider <> v_provider
    or v_payment.status not in ('pending', 'processing') then
    raise exception 'PAYMENT_REFERENCE_STATE_MISMATCH';
  end if;

  if v_payment.provider_payment_reference is not null
    and v_payment.provider_payment_reference <> v_reference then
    raise exception 'PAYMENT_REFERENCE_CONFLICT';
  end if;

  update public.payments
  set provider_payment_reference = v_reference,
      status = v_status,
      provider_metadata = jsonb_strip_nulls(coalesce(provider_metadata, '{}'::jsonb) || coalesce(p_provider_metadata, '{}'::jsonb))
  where id = v_payment.id
  returning * into v_payment;

  return query select
    v_payment.id,
    v_payment.tenant_id,
    v_payment.subscription_id,
    v_payment.provider,
    v_payment.status,
    v_payment.currency,
    v_payment.amount_minor,
    v_payment.plan,
    v_payment.billing_interval,
    v_payment.provider_payment_reference,
    v_payment.created_at;
end;
$$;

create or replace function public.growup_record_provider_payment_status(
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
  payment_id uuid,
  subscription_id uuid,
  tenant_id uuid,
  status text,
  paid_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_provider text := lower(trim(coalesce(p_provider, '')));
  v_currency text := upper(trim(coalesce(p_currency, '')));
  v_status text := lower(trim(coalesce(p_status, '')));
  v_event_id text := trim(coalesce(p_provider_event_id, ''));
  v_reference text := trim(coalesce(p_provider_payment_reference, ''));
  v_payment public.payments%rowtype;
  v_existing_event public.payment_provider_events%rowtype;
  v_now timestamptz := now();
begin
  if length(v_provider) < 2
    or length(v_event_id) < 3
    or p_payment_id is null
    or p_amount_minor is null
    or v_currency <> 'THB'
    or v_status not in ('pending', 'processing', 'failed', 'expired', 'cancelled') then
    raise exception 'INVALID_PROVIDER_PAYMENT_EVENT';
  end if;

  select *
  into v_existing_event
  from public.payment_provider_events ppe
  where ppe.provider = v_provider
    and ppe.provider_event_id = v_event_id
  limit 1;

  if found then
    select *
    into v_payment
    from public.payments p
    where p.id = coalesce(v_existing_event.payment_id, p_payment_id);

    return query select
      v_payment.id,
      v_payment.subscription_id,
      v_payment.tenant_id,
      v_payment.status,
      v_payment.paid_at;
    return;
  end if;

  select *
  into v_payment
  from public.payments p
  where p.id = p_payment_id
  for update;

  if not found then
    raise exception 'PAYMENT_NOT_FOUND';
  end if;

  insert into public.payment_provider_events (
    provider,
    provider_event_id,
    payment_id,
    event_type,
    status,
    raw_event
  )
  values (
    v_provider,
    v_event_id,
    v_payment.id,
    'payment_' || v_status,
    'received',
    coalesce(p_raw_event, '{}'::jsonb)
  );

  if v_payment.provider <> v_provider then
    update public.payment_provider_events
    set status = 'rejected',
        error = 'PAYMENT_PROVIDER_MISMATCH',
        processed_at = v_now
    where provider = v_provider
      and provider_event_id = v_event_id;
    raise exception 'PAYMENT_PROVIDER_MISMATCH';
  end if;

  if v_payment.amount_minor <> p_amount_minor then
    update public.payment_provider_events
    set status = 'rejected',
        error = 'PAYMENT_AMOUNT_MISMATCH',
        processed_at = v_now
    where provider = v_provider
      and provider_event_id = v_event_id;
    raise exception 'PAYMENT_AMOUNT_MISMATCH';
  end if;

  if v_payment.currency <> v_currency then
    update public.payment_provider_events
    set status = 'rejected',
        error = 'PAYMENT_CURRENCY_MISMATCH',
        processed_at = v_now
    where provider = v_provider
      and provider_event_id = v_event_id;
    raise exception 'PAYMENT_CURRENCY_MISMATCH';
  end if;

  if v_reference <> '' and v_payment.provider_payment_reference is not null and v_payment.provider_payment_reference <> v_reference then
    update public.payment_provider_events
    set status = 'rejected',
        error = 'PAYMENT_REFERENCE_MISMATCH',
        processed_at = v_now
    where provider = v_provider
      and provider_event_id = v_event_id;
    raise exception 'PAYMENT_REFERENCE_MISMATCH';
  end if;

  if v_payment.status = 'paid' then
    update public.payment_provider_events
    set status = 'ignored',
        processed_at = v_now
    where provider = v_provider
      and provider_event_id = v_event_id;

    return query select
      v_payment.id,
      v_payment.subscription_id,
      v_payment.tenant_id,
      v_payment.status,
      v_payment.paid_at;
    return;
  end if;

  update public.payments
  set status = v_status,
      provider_payment_reference = coalesce(nullif(v_reference, ''), provider_payment_reference),
      provider_metadata = jsonb_strip_nulls(coalesce(provider_metadata, '{}'::jsonb) || jsonb_build_object('last_event_id', v_event_id, 'last_provider_status', v_status)),
      failed_at = case when v_status = 'failed' then v_now else failed_at end,
      expired_at = case when v_status = 'expired' then v_now else expired_at end,
      cancelled_at = case when v_status = 'cancelled' then v_now else cancelled_at end
  where id = v_payment.id
    and status in ('pending', 'processing', 'failed', 'expired', 'cancelled')
  returning * into v_payment;

  update public.payment_provider_events
  set status = 'processed',
      processed_at = v_now
  where provider = v_provider
    and provider_event_id = v_event_id;

  return query select
    v_payment.id,
    v_payment.subscription_id,
    v_payment.tenant_id,
    v_payment.status,
    v_payment.paid_at;
end;
$$;

create or replace function public.growup_record_provider_payment_success(
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
  paid_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_provider text := lower(trim(coalesce(p_provider, '')));
  v_currency text := upper(trim(coalesce(p_currency, '')));
  v_event_id text := trim(coalesce(p_provider_event_id, ''));
  v_reference text := trim(coalesce(p_provider_payment_reference, ''));
  v_payment public.payments%rowtype;
  v_existing_event public.payment_provider_events%rowtype;
  v_now timestamptz := now();
begin
  if length(v_provider) < 2
    or length(v_event_id) < 3
    or p_payment_id is null
    or p_amount_minor is null
    or v_currency <> 'THB' then
    raise exception 'INVALID_PROVIDER_PAYMENT_EVENT';
  end if;

  select *
  into v_existing_event
  from public.payment_provider_events ppe
  where ppe.provider = v_provider
    and ppe.provider_event_id = v_event_id
  limit 1;

  if found then
    select *
    into v_payment
    from public.payments p
    where p.id = coalesce(v_existing_event.payment_id, p_payment_id);

    return query select
      v_payment.id,
      v_payment.subscription_id,
      v_payment.tenant_id,
      v_payment.status,
      v_payment.paid_at;
    return;
  end if;

  select *
  into v_payment
  from public.payments p
  where p.id = p_payment_id
  for update;

  if not found then
    raise exception 'PAYMENT_NOT_FOUND';
  end if;

  insert into public.payment_provider_events (
    provider,
    provider_event_id,
    payment_id,
    event_type,
    status,
    raw_event
  )
  values (
    v_provider,
    v_event_id,
    v_payment.id,
    'payment_succeeded',
    'received',
    coalesce(p_raw_event, '{}'::jsonb)
  );

  if v_payment.provider <> v_provider then
    update public.payment_provider_events
    set status = 'rejected',
        error = 'PAYMENT_PROVIDER_MISMATCH',
        processed_at = v_now
    where provider = v_provider
      and provider_event_id = v_event_id;
    raise exception 'PAYMENT_PROVIDER_MISMATCH';
  end if;

  if v_payment.amount_minor <> p_amount_minor then
    update public.payment_provider_events
    set status = 'rejected',
        error = 'PAYMENT_AMOUNT_MISMATCH',
        processed_at = v_now
    where provider = v_provider
      and provider_event_id = v_event_id;
    raise exception 'PAYMENT_AMOUNT_MISMATCH';
  end if;

  if v_payment.currency <> v_currency then
    update public.payment_provider_events
    set status = 'rejected',
        error = 'PAYMENT_CURRENCY_MISMATCH',
        processed_at = v_now
    where provider = v_provider
      and provider_event_id = v_event_id;
    raise exception 'PAYMENT_CURRENCY_MISMATCH';
  end if;

  if v_reference <> '' and v_payment.provider_payment_reference is not null and v_payment.provider_payment_reference <> v_reference then
    update public.payment_provider_events
    set status = 'rejected',
        error = 'PAYMENT_REFERENCE_MISMATCH',
        processed_at = v_now
    where provider = v_provider
      and provider_event_id = v_event_id;
    raise exception 'PAYMENT_REFERENCE_MISMATCH';
  end if;

  if v_payment.status = 'paid' then
    update public.payment_provider_events
    set status = 'ignored',
        processed_at = v_now
    where provider = v_provider
      and provider_event_id = v_event_id;

    return query select
      v_payment.id,
      v_payment.subscription_id,
      v_payment.tenant_id,
      v_payment.status,
      v_payment.paid_at;
    return;
  end if;

  if v_payment.status not in ('pending', 'processing') then
    update public.payment_provider_events
    set status = 'rejected',
        error = 'PAYMENT_EVENT_MISMATCH',
        processed_at = v_now
    where provider = v_provider
      and provider_event_id = v_event_id;
    raise exception 'PAYMENT_EVENT_MISMATCH';
  end if;

  update public.payments
  set status = 'paid',
      provider_payment_reference = coalesce(nullif(v_reference, ''), provider_payment_reference),
      paid_at = coalesce(paid_at, v_now),
      provider_metadata = jsonb_strip_nulls(coalesce(provider_metadata, '{}'::jsonb) || jsonb_build_object('last_event_id', v_event_id, 'last_provider_status', 'succeeded'))
  where id = v_payment.id
  returning * into v_payment;

  update public.subscriptions
  set status = 'active',
      current_period_started_at = v_payment.billing_period_started_at,
      current_period_ends_at = v_payment.billing_period_ends_at,
      next_renewal_at = v_payment.billing_period_ends_at,
      payment_due_at = v_payment.billing_period_ends_at,
      updated_at = v_now
  where id = v_payment.subscription_id
    and tenant_id = v_payment.tenant_id
    and status <> 'active';

  update public.payment_provider_events
  set status = 'processed',
      processed_at = v_now
  where provider = v_provider
    and provider_event_id = v_event_id;

  return query select
    v_payment.id,
    v_payment.subscription_id,
    v_payment.tenant_id,
    v_payment.status,
    v_payment.paid_at;
end;
$$;

create or replace function public.growup_activate_zero_amount_subscription_payment(
  p_tenant_id uuid,
  p_user_id text,
  p_idempotency_key text
)
returns table (
  payment_id uuid,
  tenant_id uuid,
  subscription_id uuid,
  provider text,
  status text,
  currency text,
  amount_minor integer,
  plan text,
  billing_interval text,
  provider_payment_reference text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_key text := trim(coalesce(p_idempotency_key, ''));
  v_subscription public.subscriptions%rowtype;
  v_payment public.payments%rowtype;
  v_started_at timestamptz := now();
  v_ends_at timestamptz;
begin
  if p_tenant_id is null
    or length(trim(coalesce(p_user_id, ''))) < 2
    or length(v_key) < 8
    or length(v_key) > 160 then
    raise exception 'INVALID_ZERO_AMOUNT_PAYMENT_INPUT';
  end if;

  if not exists (
    select 1 from public.tenant_memberships tm
    where tm.tenant_id = p_tenant_id
      and tm.user_id = p_user_id
      and tm.is_active = true
  ) then
    raise exception 'PAYMENT_TENANT_FORBIDDEN';
  end if;

  select *
  into v_payment
  from public.payments p
  where p.tenant_id = p_tenant_id
    and p.idempotency_key = v_key
  limit 1;

  if found then
    return query select
      v_payment.id,
      v_payment.tenant_id,
      v_payment.subscription_id,
      v_payment.provider,
      v_payment.status,
      v_payment.currency,
      v_payment.amount_minor,
      v_payment.plan,
      v_payment.billing_interval,
      v_payment.provider_payment_reference,
      v_payment.created_at;
    return;
  end if;

  select *
  into v_subscription
  from public.subscriptions s
  where s.tenant_id = p_tenant_id
    and s.is_initial = true
  for update;

  if not found then
    raise exception 'SUBSCRIPTION_NOT_FOUND';
  end if;

  if v_subscription.amount_due_minor <> 0 then
    raise exception 'ZERO_AMOUNT_PAYMENT_NOT_ALLOWED';
  end if;

  if v_subscription.status = 'active' then
    raise exception 'PAYMENT_NOT_REQUIRED';
  end if;

  if v_subscription.status = 'trialing' and v_subscription.trial_ends_at > now() then
    raise exception 'PAYMENT_NOT_REQUIRED';
  end if;

  v_ends_at := public.growup_payment_period_end(v_started_at, v_subscription.billing_interval);

  insert into public.payments (
    tenant_id,
    subscription_id,
    idempotency_key,
    provider,
    status,
    currency,
    amount_minor,
    plan,
    billing_interval,
    billing_period_started_at,
    billing_period_ends_at,
    provider_payment_reference,
    checkout_metadata,
    provider_metadata,
    created_by_user_id,
    paid_at
  )
  values (
    p_tenant_id,
    v_subscription.id,
    v_key,
    'zero_amount',
    'paid',
    v_subscription.currency,
    0,
    v_subscription.plan,
    v_subscription.billing_interval,
    v_started_at,
    v_ends_at,
    'zero_amount:' || v_key,
    jsonb_build_object('source', 'growup_zero_amount_activation'),
    jsonb_build_object('zero_amount', true),
    p_user_id,
    v_started_at
  )
  returning * into v_payment;

  update public.subscriptions
  set status = 'active',
      current_period_started_at = v_payment.billing_period_started_at,
      current_period_ends_at = v_payment.billing_period_ends_at,
      next_renewal_at = v_payment.billing_period_ends_at,
      payment_due_at = v_payment.billing_period_ends_at,
      updated_at = now()
  where id = v_subscription.id
    and tenant_id = p_tenant_id;

  insert into public.payment_provider_events (
    provider,
    provider_event_id,
    payment_id,
    event_type,
    status,
    raw_event,
    processed_at
  )
  values (
    'zero_amount',
    'zero_amount:' || v_payment.id::text,
    v_payment.id,
    'zero_amount_activated',
    'processed',
    jsonb_build_object('idempotency_key', v_key),
    now()
  )
  on conflict (provider, provider_event_id) do nothing;

  return query select
    v_payment.id,
    v_payment.tenant_id,
    v_payment.subscription_id,
    v_payment.provider,
    v_payment.status,
    v_payment.currency,
    v_payment.amount_minor,
    v_payment.plan,
    v_payment.billing_interval,
    v_payment.provider_payment_reference,
    v_payment.created_at;
end;
$$;

comment on function public.growup_set_payment_provider_reference(uuid, uuid, text, text, text, jsonb) is 'Binds a server-created local payment attempt to a Stripe test-mode PaymentIntent reference without trusting browser data.';
comment on function public.growup_record_provider_payment_status(text, text, uuid, text, integer, text, text, jsonb) is 'Records non-success provider statuses idempotently; never activates a subscription.';
comment on function public.growup_activate_zero_amount_subscription_payment(uuid, text, text) is 'Authoritative zero-charge activation path for legitimate amount_due_minor=0 subscription snapshots; does not pretend a Stripe charge occurred.';
