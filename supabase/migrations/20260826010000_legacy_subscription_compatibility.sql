-- Preserve the effective Starter entitlement of active tenants that predate
-- Subscription Core, while giving the upgrade RPC its required persisted row.
-- This is idempotent and does not create payments or provider events.

alter table public.subscriptions
  drop constraint if exists subscriptions_source_check;

alter table public.subscriptions
  add constraint subscriptions_source_check
  check (source in ('public_signup', 'legacy_backfill'));

insert into public.subscriptions (
  tenant_id,
  source,
  is_initial,
  plan,
  billing_interval,
  status,
  currency,
  base_amount_minor,
  discount_amount_minor,
  amount_due_minor,
  current_period_started_at
)
select
  t.id,
  'legacy_backfill',
  true,
  'starter',
  'monthly',
  'active',
  'THB',
  public.growup_subscription_base_amount_minor('starter', 'monthly'),
  0,
  public.growup_subscription_base_amount_minor('starter', 'monthly'),
  t.created_at
from public.tenants t
where t.status = 'active'
  and exists (
    select 1
    from public.tenant_memberships tm
    where tm.tenant_id = t.id
      and tm.is_active = true
      and lower(trim(tm.role)) = 'owner'
  )
  and not exists (
    select 1
    from public.subscriptions s
    where s.tenant_id = t.id
      and s.is_initial = true
  )
on conflict do nothing;

comment on constraint subscriptions_source_check on public.subscriptions is
  'Identifies subscriptions created by public signup or the one-time legacy compatibility backfill.';
