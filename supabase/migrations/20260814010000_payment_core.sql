-- Growup Pilot Payment Core.
-- Provider-independent only: creates auditable payment attempts and verified-provider hooks, but no commercial gateway.

create extension if not exists pgcrypto;

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  subscription_id uuid not null references public.subscriptions(id) on delete restrict,
  idempotency_key text not null,
  provider text not null,
  provider_payment_reference text,
  status text not null check (status in ('pending', 'processing', 'paid', 'failed', 'expired', 'cancelled', 'refunded')),
  currency text not null default 'THB' check (currency = 'THB'),
  amount_minor integer not null check (amount_minor >= 0),
  plan text not null check (plan in ('starter', 'business', 'enterprise')),
  billing_interval text not null check (billing_interval in ('monthly', 'yearly')),
  billing_period_started_at timestamptz,
  billing_period_ends_at timestamptz,
  checkout_metadata jsonb not null default '{}'::jsonb,
  provider_metadata jsonb not null default '{}'::jsonb,
  created_by_user_id text references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz,
  failed_at timestamptz,
  expired_at timestamptz,
  cancelled_at timestamptz,
  check (length(trim(idempotency_key)) between 8 and 160),
  check (length(trim(provider)) between 2 and 80)
);

create unique index if not exists uniq_payments_tenant_idempotency
on public.payments (tenant_id, idempotency_key);

create unique index if not exists uniq_payments_provider_reference
on public.payments (provider, provider_payment_reference)
where provider_payment_reference is not null;

create index if not exists idx_payments_tenant_status
on public.payments (tenant_id, status, created_at desc);

create index if not exists idx_payments_subscription
on public.payments (subscription_id, created_at desc);

drop trigger if exists payments_updated_at on public.payments;
create trigger payments_updated_at before update on public.payments
for each row execute function public.set_updated_at();

create table if not exists public.payment_provider_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  payment_id uuid references public.payments(id) on delete set null,
  event_type text not null,
  status text not null default 'received' check (status in ('received', 'processed', 'ignored', 'rejected')),
  raw_event jsonb not null default '{}'::jsonb,
  error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  check (length(trim(provider)) between 2 and 80),
  check (length(trim(provider_event_id)) between 3 and 240)
);

create unique index if not exists uniq_payment_provider_events
on public.payment_provider_events (provider, provider_event_id);

create index if not exists idx_payment_provider_events_payment
on public.payment_provider_events (payment_id, received_at desc);

alter table public.payments enable row level security;
alter table public.payment_provider_events enable row level security;

create or replace function public.growup_payment_period_end(
  p_started_at timestamptz,
  p_billing_interval text
)
returns timestamptz
language plpgsql
immutable
as $$
begin
  if lower(trim(coalesce(p_billing_interval, ''))) = 'monthly' then
    return p_started_at + interval '1 month';
  elsif lower(trim(coalesce(p_billing_interval, ''))) = 'yearly' then
    return p_started_at + interval '1 year';
  end if;
  raise exception 'INVALID_BILLING_INTERVAL';
end;
$$;

create or replace function public.growup_begin_subscription_payment(
  p_tenant_id uuid,
  p_user_id text,
  p_idempotency_key text,
  p_provider text default 'provider_required'
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
  v_idempotency_key text := trim(coalesce(p_idempotency_key, ''));
  v_provider text := lower(trim(coalesce(nullif(p_provider, ''), 'provider_required')));
  v_subscription public.subscriptions%rowtype;
  v_existing public.payments%rowtype;
  v_started_at timestamptz := now();
  v_ends_at timestamptz;
begin
  if p_tenant_id is null
    or length(trim(coalesce(p_user_id, ''))) < 2
    or length(v_idempotency_key) < 8
    or length(v_idempotency_key) > 160 then
    raise exception 'INVALID_PAYMENT_INPUT';
  end if;

  if not exists (
    select 1
    from public.tenant_memberships tm
    where tm.tenant_id = p_tenant_id
      and tm.user_id = p_user_id
      and tm.is_active = true
  ) then
    raise exception 'PAYMENT_TENANT_FORBIDDEN';
  end if;

  select *
  into v_existing
  from public.payments p
  where p.tenant_id = p_tenant_id
    and p.idempotency_key = v_idempotency_key
  limit 1;

  if found then
    return query select
      v_existing.id,
      v_existing.tenant_id,
      v_existing.subscription_id,
      v_existing.provider,
      v_existing.status,
      v_existing.currency,
      v_existing.amount_minor,
      v_existing.plan,
      v_existing.billing_interval,
      v_existing.idempotency_key,
      v_existing.provider_payment_reference,
      v_existing.billing_period_started_at,
      v_existing.billing_period_ends_at,
      v_existing.created_at;
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

  if v_subscription.status = 'active' then
    raise exception 'PAYMENT_NOT_REQUIRED';
  end if;

  if v_subscription.status = 'trialing' and v_subscription.trial_ends_at > now() then
    raise exception 'PAYMENT_NOT_REQUIRED';
  end if;

  if v_subscription.status in ('cancelled') then
    raise exception 'SUBSCRIPTION_NOT_PAYABLE';
  end if;

  if v_subscription.status = 'trialing' and v_subscription.trial_ends_at <= now() then
    update public.subscriptions
    set status = 'expired',
        updated_at = now(),
        payment_due_at = coalesce(payment_due_at, now())
    where id = v_subscription.id;
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
    checkout_metadata,
    created_by_user_id
  )
  values (
    p_tenant_id,
    v_subscription.id,
    v_idempotency_key,
    v_provider,
    'pending',
    v_subscription.currency,
    v_subscription.amount_due_minor,
    v_subscription.plan,
    v_subscription.billing_interval,
    v_started_at,
    v_ends_at,
    jsonb_build_object('source', 'growup_payment_core', 'provider_configured', v_provider <> 'provider_required'),
    p_user_id
  )
  returning * into v_existing;

  return query select
    v_existing.id,
    v_existing.tenant_id,
    v_existing.subscription_id,
    v_existing.provider,
    v_existing.status,
    v_existing.currency,
    v_existing.amount_minor,
    v_existing.plan,
    v_existing.billing_interval,
    v_existing.idempotency_key,
    v_existing.provider_payment_reference,
    v_existing.billing_period_started_at,
    v_existing.billing_period_ends_at,
    v_existing.created_at;
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
  v_payment public.payments%rowtype;
  v_now timestamptz := now();
begin
  if length(v_provider) < 2
    or length(trim(coalesce(p_provider_event_id, ''))) < 3
    or p_payment_id is null
    or p_amount_minor is null
    or v_currency <> 'THB' then
    raise exception 'INVALID_PROVIDER_PAYMENT_EVENT';
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
    trim(p_provider_event_id),
    v_payment.id,
    'payment_succeeded',
    'received',
    coalesce(p_raw_event, '{}'::jsonb)
  )
  on conflict (provider, provider_event_id) do nothing;

  if v_payment.provider <> v_provider
    or v_payment.amount_minor <> p_amount_minor
    or v_payment.currency <> v_currency
    or v_payment.status not in ('pending', 'processing') then
    update public.payment_provider_events
    set status = 'rejected',
        error = 'PAYMENT_EVENT_MISMATCH',
        processed_at = v_now
    where provider = v_provider
      and provider_event_id = trim(p_provider_event_id);
    raise exception 'PAYMENT_EVENT_MISMATCH';
  end if;

  update public.payments
  set status = 'paid',
      provider_payment_reference = nullif(trim(coalesce(p_provider_payment_reference, '')), ''),
      paid_at = v_now,
      provider_metadata = coalesce(provider_metadata, '{}'::jsonb) || jsonb_build_object('last_event_id', trim(p_provider_event_id))
  where id = v_payment.id
  returning * into v_payment;

  update public.subscriptions
  set status = 'active',
      current_period_started_at = v_payment.billing_period_started_at,
      current_period_ends_at = v_payment.billing_period_ends_at,
      next_renewal_at = v_payment.billing_period_ends_at,
      payment_due_at = v_payment.billing_period_ends_at,
      updated_at = v_now
  where id = v_payment.subscription_id;

  update public.payment_provider_events
  set status = 'processed',
      processed_at = v_now
  where provider = v_provider
    and provider_event_id = trim(p_provider_event_id);

  return query select
    v_payment.id,
    v_payment.subscription_id,
    v_payment.tenant_id,
    v_payment.status,
    v_payment.paid_at;
end;
$$;

comment on table public.payments is 'Provider-independent payment attempts for subscription billing. Commercial gateway artifacts are nullable until a provider is configured.';
comment on table public.payment_provider_events is 'Idempotency and audit log for verified provider callback events.';
comment on function public.growup_begin_subscription_payment(uuid, text, text, text) is 'Creates or reuses a tenant-scoped payment attempt from the authoritative subscription snapshot.';
comment on function public.growup_record_provider_payment_success(text, text, uuid, text, integer, text, jsonb) is 'Future provider callback hook: only exact provider, amount, currency, and pending payment matches can activate a subscription.';
