-- PREVIEW ONLY. No backfill, no changes to existing checkout/webhook RPCs.
-- Apply only to enwabsfsmwwcwwirdwok after rollback rehearsal.
-- Failed/expired/abandoned Stripe TEST intents must be verified canceled by
-- the server before reservation release. Cancellation approved 2026-09-01.
begin;

create table public.promotion_payment_reservations (
  id uuid primary key default gen_random_uuid(),
  promotion_code_id uuid not null references public.promotion_codes(id) on delete restrict,
  payment_id uuid not null unique references public.payments(id) on delete restrict,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  state text not null default 'reserved' check (state in ('reserved','redeemed','released')),
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.promotion_payment_reservations enable row level security;
revoke all on public.promotion_payment_reservations from public, anon, authenticated;
grant select, insert, update on public.promotion_payment_reservations to service_role;
create index promotion_payment_reservations_capacity
  on public.promotion_payment_reservations(promotion_code_id, tenant_id) where state = 'reserved';
alter table public.promotion_redemptions
  add column payment_id uuid unique references public.payments(id) on delete restrict;

-- All consumers serialize capacity on the SAME promotion row. Reservations
-- never expire by wall-clock alone while a Stripe PaymentIntent can still pay.
create function public.growup_require_promo_capacity(p_promo_id uuid, p_tenant_id uuid, p_payment_id uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_code public.promotion_codes%rowtype;
  v_total bigint;
  v_tenant bigint;
begin
  select * into v_code from public.promotion_codes where id = p_promo_id for update;
  if not found then raise exception 'PROMOTION_CODE_INVALID'; end if;
  select count(*), count(*) filter (where tenant_id = p_tenant_id) into v_total, v_tenant
  from (
    select tenant_id from public.promotion_redemptions where promotion_code_id = p_promo_id
    union all
    select tenant_id from public.promotion_payment_reservations
    where promotion_code_id = p_promo_id and state = 'reserved'
      and payment_id is distinct from p_payment_id
  ) occupied;
  if (v_code.max_redemptions is not null and v_total >= v_code.max_redemptions)
    or (v_code.max_redemptions_per_tenant is not null and v_tenant >= v_code.max_redemptions_per_tenant) then
    raise exception 'PROMOTION_CODE_EXHAUSTED';
  end if;
end;
$$;

-- Signup still uses its existing validation/bootstrap. This insertion guard
-- ensures it cannot steal capacity already reserved by a concurrent checkout.
create function public.growup_guard_redemption_capacity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.payment_id is null then
    perform public.growup_require_promo_capacity(new.promotion_code_id, new.tenant_id);
  elsif not exists (
    select 1 from public.promotion_payment_reservations r join public.payments p on p.id = r.payment_id
    where r.payment_id = new.payment_id and r.promotion_code_id = new.promotion_code_id
      and r.tenant_id = new.tenant_id and r.state = 'reserved' and p.tenant_id = new.tenant_id
      and p.status = 'paid' and p.paid_at is not null and p.amount_minor > 0
      and p.provider_metadata->>'last_provider_status' = 'succeeded'
  ) then
    raise exception 'PROMOTION_PAYMENT_NOT_VERIFIED';
  end if;
  -- A verified reservation already owns capacity, even if an admin subsequently
  -- lowers the limit/disables the code. Honor that immutable paid agreement.
  return new;
end;
$$;
create trigger promotion_redemptions_capacity before insert on public.promotion_redemptions
for each row execute function public.growup_guard_redemption_capacity();

-- Optional Promo wrapper: creates/resumes the existing checkout atomically,
-- then fixes its authoritative price BEFORE any external Stripe request.
create function public.growup_begin_subscription_promo_checkout(
  p_tenant_id uuid, p_user_id text, p_target_plan text, p_billing_interval text,
  p_intent text, p_idempotency_key text, p_provider text, p_promotion_code text
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_checkout record;
  v_payment public.payments%rowtype;
  v_code public.promotion_codes%rowtype;
  v_reservation public.promotion_payment_reservations%rowtype;
  v_validation record;
  v_normalized text := public.growup_normalize_promotion_code(p_promotion_code);
  v_base integer;
  v_discount integer := 0;
  v_amount integer;
  v_snapshot jsonb;
begin
  if v_normalized <> '' and (p_provider <> 'stripe_promptpay' or p_intent not in ('subscription_renewal','subscription_upgrade')
    or length(v_normalized) not between 2 and 64) then
    raise exception 'PROMOTION_CHECKOUT_NOT_ALLOWED';
  end if;
  -- Existing RPC enforces active Owner, tenant, plan, lifecycle and idempotency.
  select * into v_checkout from public.growup_begin_subscription_checkout(
    p_tenant_id,p_user_id,p_target_plan,p_billing_interval,p_intent,p_idempotency_key,p_provider);
  select * into v_payment from public.payments where id = v_checkout.payment_id;
  if v_normalized = '' then
    return to_jsonb(v_checkout) || jsonb_build_object('checkout_metadata',v_payment.checkout_metadata);
  end if;
  select * into v_reservation from public.promotion_payment_reservations where payment_id = v_payment.id;
  if found then
    if v_reservation.snapshot->>'code' <> v_normalized or v_reservation.state = 'released' then
      raise exception 'PROMOTION_CHECKOUT_CONFLICT';
    end if;
    return to_jsonb(v_checkout) || jsonb_build_object('amount_minor',v_payment.amount_minor,'checkout_metadata',v_payment.checkout_metadata);
  end if;
  -- Never change an existing/provider-bound or previously offered price.
  if v_payment.created_at <> now() or v_payment.status <> 'pending'
    or v_payment.provider_payment_reference is not null then
    raise exception 'PROMOTION_CHECKOUT_CONFLICT';
  end if;
  if exists (select 1 from public.subscriptions s where s.id = v_payment.subscription_id
    and s.promotion_snapshot->'service_entitlement'->>'state' = 'pending_verified_payment'
    and s.promotion_snapshot->'service_entitlement'->>'plan' = v_payment.plan
    and s.promotion_snapshot->'service_entitlement'->>'billing_interval' = v_payment.billing_interval) then
    raise exception 'PROMOTION_CHECKOUT_SIGNUP_BENEFIT_PENDING';
  end if;
  select * into v_code from public.promotion_codes pc
  where public.growup_normalize_promotion_code(pc.code) = v_normalized for update;
  if not found then raise exception 'PROMOTION_CODE_INVALID'; end if;
  select * into v_validation from public.growup_validate_promotion_code(
    v_normalized, v_payment.plan, v_payment.billing_interval, p_tenant_id);
  if not v_validation.valid then raise exception '%',v_validation.reason; end if;
  perform public.growup_require_promo_capacity(v_code.id,p_tenant_id);
  if v_code.benefit_type not in ('percent_discount','fixed_amount_discount')
    or v_code.benefit_value::text in ('NaN','Infinity','-Infinity') or v_code.benefit_value <= 0 then
    raise exception 'PROMOTION_CODE_INVALID';
  end if;
  v_base := public.growup_subscription_base_amount_minor(v_payment.plan,v_payment.billing_interval);
  if v_code.benefit_type = 'percent_discount' then
    if v_code.benefit_value > 100 then raise exception 'PROMOTION_CODE_INVALID'; end if;
    v_discount := round(v_base::numeric * v_code.benefit_value / 100)::integer;
  elsif v_code.benefit_type = 'fixed_amount_discount' then
    v_discount := least(v_base::numeric,round(v_code.benefit_value * 100))::integer;
  else
    perform public.growup_promo_service_period_end(v_payment.billing_period_ends_at,
      case v_code.benefit_type when 'service_days' then 'days' else 'months' end, v_code.benefit_value);
  end if;
  v_amount := v_base - v_discount;
  -- Never manufacture a successful Stripe payment for a zero-amount checkout.
  if v_amount <= 0 then raise exception 'PROMOTION_CHECKOUT_POSITIVE_PAYMENT_REQUIRED'; end if;
  if v_amount < 1000 then raise exception 'PROMOTION_CHECKOUT_STRIPE_MINIMUM'; end if;
  v_snapshot := jsonb_build_object('version',1,'code',v_normalized,'promotion_code_id',v_code.id,
    'benefit_type',v_code.benefit_type,'benefit_value',v_code.benefit_value,
    'benefit_description',v_validation.benefit_description,'base_amount_minor',v_base,
    'discount_amount_minor',v_discount,'amount_minor',v_amount,'currency','THB',
    'plan',v_payment.plan,'billing_interval',v_payment.billing_interval);
  insert into public.promotion_payment_reservations(promotion_code_id,payment_id,tenant_id,snapshot)
  values(v_code.id,v_payment.id,p_tenant_id,v_snapshot) returning * into v_reservation;
  update public.payments set amount_minor = v_amount, checkout_metadata = checkout_metadata ||
    jsonb_build_object('amount_minor',v_amount,'promotion',v_snapshot || jsonb_build_object('reservation_id',v_reservation.id))
  where id = v_payment.id returning * into v_payment;
  update public.subscription_upgrade_attempts set amount_minor = v_amount where payment_id = v_payment.id;
  insert into public.platform_admin_audit_log(actor_user_id,action,target_type,target_id,details)
  values(p_user_id,'promotion_code.reserve','promotion_code',v_code.id::text,
    jsonb_build_object('code',v_normalized,'payment_id',v_payment.id,'reservation_id',v_reservation.id,'tenant_id',p_tenant_id));
  return to_jsonb(v_checkout) || jsonb_build_object('amount_minor',v_amount,'checkout_metadata',v_payment.checkout_metadata);
end;
$$;

-- Existing verified-payment RPCs update the payment inside the same transaction
-- as activation. A rollback also rolls back redemption and its audit.
create function public.growup_reconcile_payment_promotion()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_res public.promotion_payment_reservations%rowtype;
begin
  if new.status = old.status then return new; end if;
  select * into v_res from public.promotion_payment_reservations where payment_id = new.id for update;
  if not found then return new; end if;
  if v_res.state = 'released' and new.status in ('pending','processing','paid') then
    raise exception 'PROMOTION_RESERVATION_RELEASED';
  end if;
  if v_res.state <> 'reserved' then return new; end if;
  if new.status = 'paid' then
    if new.provider <> 'stripe_promptpay' or new.paid_at is null or new.amount_minor <= 0
      or new.provider_metadata->>'last_provider_status' is distinct from 'succeeded'
      or new.amount_minor <> (v_res.snapshot->>'amount_minor')::integer
      or new.tenant_id <> v_res.tenant_id or new.currency <> 'THB'
      or new.plan <> v_res.snapshot->>'plan' or new.billing_interval <> v_res.snapshot->>'billing_interval' then
      raise exception 'PROMOTION_PAYMENT_NOT_VERIFIED';
    end if;
    insert into public.promotion_redemptions(promotion_code_id,tenant_id,selected_plan,selected_billing,
      benefit_type,benefit_value,benefit_description,payment_id)
    values(v_res.promotion_code_id,v_res.tenant_id,new.plan,new.billing_interval,
      v_res.snapshot->>'benefit_type',(v_res.snapshot->>'benefit_value')::numeric,
      v_res.snapshot->>'benefit_description',new.id);
    update public.promotion_payment_reservations set state = 'redeemed',updated_at = now() where id = v_res.id;
  elsif new.status in ('failed','cancelled','expired') then
    if new.status <> 'cancelled' or new.provider_metadata->>'last_provider_status' is distinct from 'cancelled' then
      raise exception 'PROMOTION_PAYMENT_TERMINAL_UNCONFIRMED';
    end if;
    update public.promotion_payment_reservations set state = 'released',updated_at = now() where id = v_res.id;
    insert into public.platform_admin_audit_log(actor_user_id,action,target_type,target_id,details)
    values(null,'promotion_code.release','promotion_code',v_res.promotion_code_id::text,
      jsonb_build_object('code',v_res.snapshot->>'code','payment_id',new.id,'reservation_id',v_res.id,'reason',new.status));
  end if;
  return new;
end;
$$;
create trigger payments_promo_reconciliation after update of status on public.payments
for each row execute function public.growup_reconcile_payment_promotion();

-- Serialize terminal webhook/retry races. This does not call Stripe; callers
-- must first verify the exact TEST PaymentIntent has authoritative canceled status.
create function public.growup_release_canceled_promo_payment(
  p_payment_id uuid,p_tenant_id uuid,p_reference text,p_amount integer,p_currency text,p_event_id text
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_payment public.payments%rowtype;
begin
  select * into v_payment from public.payments where id=p_payment_id and tenant_id=p_tenant_id for update;
  if not found or v_payment.provider <> 'stripe_promptpay' or v_payment.amount_minor <> p_amount
    or v_payment.currency <> p_currency or v_payment.provider_payment_reference is distinct from p_reference
    or not exists (select 1 from public.promotion_payment_reservations where payment_id=p_payment_id and tenant_id=p_tenant_id) then
    raise exception 'PROMOTION_PAYMENT_NOT_VERIFIED';
  end if;
  if v_payment.status='cancelled' then return jsonb_build_object('status','cancelled'); end if;
  if v_payment.status not in ('pending','processing') then raise exception 'PROMOTION_PAYMENT_TERMINAL_UNCONFIRMED'; end if;
  if v_payment.checkout_metadata->>'operation'='subscription_upgrade' then
    perform public.growup_record_subscription_upgrade_status('stripe_promptpay',p_event_id,p_payment_id,p_reference,p_amount,p_currency,'cancelled',
      jsonb_build_object('source','preview_promo_verified_cancellation','stripe_status','canceled'));
  else
    perform public.growup_record_provider_payment_status('stripe_promptpay',p_event_id,p_payment_id,p_reference,p_amount,p_currency,'cancelled',
      jsonb_build_object('source','preview_promo_verified_cancellation','stripe_status','canceled'));
  end if;
  return jsonb_build_object('status','cancelled');
end; $$;
revoke execute on function public.growup_release_canceled_promo_payment(uuid,uuid,text,integer,text,text) from public,anon,authenticated;
grant execute on function public.growup_release_canceled_promo_payment(uuid,uuid,text,integer,text,text) to service_role;

-- Explicit abandonment only: a confirmed Owner action is persisted before
-- any external cancellation. This marker does not release quota or change price.
create function public.growup_abandon_promo_checkout(p_payment_id uuid,p_tenant_id uuid,p_user_id text,p_confirmed boolean)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_payment public.payments%rowtype;
begin
  if p_confirmed is distinct from true or not exists (
    select 1 from public.tenant_memberships m join public.users u on u.id=m.user_id
    where m.tenant_id=p_tenant_id and m.user_id=p_user_id and m.is_active and u.is_active and lower(m.role)='owner'
  ) then raise exception 'SUBSCRIPTION_CHECKOUT_OWNER_REQUIRED'; end if;
  select * into v_payment from public.payments where id=p_payment_id and tenant_id=p_tenant_id for update;
  if not found or v_payment.provider <> 'stripe_promptpay' or v_payment.status not in ('pending','cancelled')
    or not exists (select 1 from public.promotion_payment_reservations where payment_id=p_payment_id and tenant_id=p_tenant_id) then
    raise exception 'PROMOTION_CHECKOUT_NOT_ALLOWED';
  end if;
  if v_payment.checkout_metadata#>>'{promotion,abandoned_at}' is null then
    update public.payments set checkout_metadata=jsonb_set(checkout_metadata,'{promotion}',checkout_metadata->'promotion'
      ||jsonb_build_object('abandoned_at',now(),'abandoned_by_user_id',p_user_id))
    where id=p_payment_id returning * into v_payment;
  end if;
  return v_payment.checkout_metadata;
end; $$;
revoke execute on function public.growup_abandon_promo_checkout(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.growup_abandon_promo_checkout(uuid,uuid,text,boolean) to service_role;


revoke execute on function public.growup_require_promo_capacity(uuid,uuid,uuid) from public,anon,authenticated;
revoke execute on function public.growup_guard_redemption_capacity() from public,anon,authenticated;
revoke execute on function public.growup_begin_subscription_promo_checkout(uuid,text,text,text,text,text,text,text) from public,anon,authenticated;
revoke execute on function public.growup_reconcile_payment_promotion() from public,anon,authenticated;
grant execute on function public.growup_begin_subscription_promo_checkout(uuid,text,text,text,text,text,text,text) to service_role;
commit;
