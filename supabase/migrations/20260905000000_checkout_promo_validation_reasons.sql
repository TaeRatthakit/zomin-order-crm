-- Checkout Promo validation UX: preserve the existing server-authoritative
-- validation and reservation flow, but expose actionable reasons to the UI.
begin;

create or replace function public.growup_checkout_promotion_reason(
  p_code text,
  p_plan text,
  p_billing text,
  p_tenant_id uuid default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := public.growup_normalize_promotion_code(p_code);
  v_plan text := lower(trim(coalesce(p_plan, '')));
  v_billing text := lower(trim(coalesce(p_billing, '')));
  v_promotion public.promotion_codes%rowtype;
  v_total_redemptions bigint := 0;
  v_tenant_redemptions bigint := 0;
begin
  if length(v_code) < 2
    or v_plan not in ('starter', 'business', 'enterprise')
    or v_billing not in ('monthly', 'yearly') then
    return 'PROMOTION_CODE_INVALID';
  end if;

  select * into v_promotion
  from public.promotion_codes pc
  where public.growup_normalize_promotion_code(pc.code) = v_code
  limit 1;

  if not found then return 'PROMOTION_CODE_NOT_FOUND'; end if;
  if not v_promotion.active then return 'PROMOTION_CODE_DISABLED'; end if;

  if (v_promotion.starts_at is not null and v_promotion.starts_at > now())
    or (v_promotion.ends_at is not null and v_promotion.ends_at < now()) then
    return 'PROMOTION_CODE_EXPIRED';
  end if;

  if not v_plan = any(v_promotion.applicable_plans)
    or not v_billing = any(v_promotion.applicable_billing) then
    return 'PROMOTION_CODE_PLAN_INELIGIBLE';
  end if;

  if v_promotion.max_redemptions is not null then
    select count(*) into v_total_redemptions
    from public.promotion_redemptions pr
    where pr.promotion_code_id = v_promotion.id;
    if v_total_redemptions >= v_promotion.max_redemptions then
      return 'PROMOTION_CODE_EXHAUSTED';
    end if;
  end if;

  if p_tenant_id is not null and v_promotion.max_redemptions_per_tenant is not null then
    select count(*) into v_tenant_redemptions
    from public.promotion_redemptions pr
    where pr.promotion_code_id = v_promotion.id and pr.tenant_id = p_tenant_id;
    if v_tenant_redemptions >= v_promotion.max_redemptions_per_tenant then
      return 'PROMOTION_CODE_EXHAUSTED';
    end if;
  end if;

  return '';
end;
$$;

create or replace function public.growup_quote_checkout_promotion(
  p_tenant_id uuid, p_user_id text, p_code text, p_plan text, p_billing text
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_reason text;
  v_code public.promotion_codes%rowtype;
  v_sub public.subscriptions%rowtype;
  v_base integer;
  v_discount integer := 0;
  v_amount integer;
  v_mode text;
begin
  if not exists (select 1 from public.tenant_memberships m join public.users u on u.id = m.user_id
    where m.tenant_id = p_tenant_id and m.user_id = p_user_id and m.is_active and u.is_active and lower(m.role) = 'owner') then
    raise exception 'SUBSCRIPTION_CHECKOUT_OWNER_REQUIRED';
  end if;
  select * into v_sub from public.subscriptions where tenant_id = p_tenant_id and is_initial;
  if not found or v_sub.status not in ('active', 'trialing', 'expired', 'pending_payment')
    or array_position(array['starter', 'business', 'enterprise'], p_plan) < array_position(array['starter', 'business', 'enterprise'], v_sub.plan) then
    raise exception 'PROMOTION_CHECKOUT_NOT_ALLOWED';
  end if;
  if v_sub.promotion_snapshot->'service_entitlement'->>'state' = 'pending_verified_payment' then
    raise exception 'PROMOTION_CHECKOUT_SIGNUP_BENEFIT_PENDING';
  end if;
  select * into v_code from public.promotion_codes
  where public.growup_normalize_promotion_code(code) = public.growup_normalize_promotion_code(p_code) for update;
  if not found then raise exception 'PROMOTION_CODE_NOT_FOUND'; end if;
  v_reason := public.growup_checkout_promotion_reason(p_code, p_plan, p_billing, p_tenant_id);
  if v_reason <> '' then raise exception '%', v_reason; end if;
  perform public.growup_require_promo_capacity(v_code.id, p_tenant_id);
  v_base := public.growup_subscription_base_amount_minor(p_plan, p_billing);
  if v_code.benefit_type in ('service_days', 'free_months') then
    perform public.growup_promo_service_period_end(now(), case v_code.benefit_type when 'service_days' then 'days' else 'months' end, v_code.benefit_value);
    v_mode := 'free_service'; v_amount := 0;
  else
    v_mode := 'payment';
    if v_sub.status = 'pending_payment' and v_sub.current_period_started_at is null and p_plan = v_sub.plan then
      raise exception 'PROMOTION_CHECKOUT_NOT_ALLOWED';
    end if;
    if v_code.benefit_type = 'percent_discount' then v_discount := round(v_base::numeric * v_code.benefit_value / 100)::integer;
    elsif v_code.benefit_type = 'fixed_amount_discount' then v_discount := least(v_base::numeric, round(v_code.benefit_value * 100))::integer;
    else raise exception 'PROMOTION_CODE_INVALID'; end if;
    v_amount := v_base - v_discount;
    if v_amount <= 0 then raise exception 'PROMOTION_CHECKOUT_POSITIVE_PAYMENT_REQUIRED'; end if;
    if v_amount < 1000 then raise exception 'PROMOTION_CHECKOUT_STRIPE_MINIMUM'; end if;
  end if;
  return jsonb_build_object('code', public.growup_normalize_promotion_code(v_code.code), 'plan', p_plan, 'billing', p_billing,
    'mode', v_mode, 'benefit_type', v_code.benefit_type, 'benefit_value', v_code.benefit_value,
    'amount_minor', v_amount, 'base_amount_minor', v_base, 'discount_amount_minor', v_discount,
    'definition_version', md5(to_jsonb(v_code)::text));
end;
$$;

-- Final checkout revalidation uses the same reason resolver, while all price,
-- reservation, webhook, redemption, and exactly-once behavior stays intact.
create or replace function public.growup_begin_subscription_promo_checkout(
  p_tenant_id uuid, p_user_id text, p_target_plan text, p_billing_interval text,
  p_intent text, p_idempotency_key text, p_provider text, p_promotion_code text
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_checkout record;
  v_payment public.payments%rowtype;
  v_code public.promotion_codes%rowtype;
  v_reservation public.promotion_payment_reservations%rowtype;
  v_reason text;
  v_normalized text := public.growup_normalize_promotion_code(p_promotion_code);
  v_base integer;
  v_discount integer := 0;
  v_amount integer;
  v_snapshot jsonb;
begin
  if v_normalized <> '' and (p_provider <> 'stripe_promptpay' or p_intent not in ('subscription_renewal', 'subscription_upgrade')
    or length(v_normalized) not between 2 and 64) then
    raise exception 'PROMOTION_CHECKOUT_NOT_ALLOWED';
  end if;
  select * into v_checkout from public.growup_begin_subscription_checkout(
    p_tenant_id, p_user_id, p_target_plan, p_billing_interval, p_intent, p_idempotency_key, p_provider);
  select * into v_payment from public.payments where id = v_checkout.payment_id;
  if v_normalized = '' then return to_jsonb(v_checkout) || jsonb_build_object('checkout_metadata', v_payment.checkout_metadata); end if;
  select * into v_reservation from public.promotion_payment_reservations where payment_id = v_payment.id;
  if found then
    if v_reservation.snapshot->>'code' <> v_normalized or v_reservation.state = 'released' then raise exception 'PROMOTION_CHECKOUT_CONFLICT'; end if;
    return to_jsonb(v_checkout) || jsonb_build_object('amount_minor', v_payment.amount_minor, 'checkout_metadata', v_payment.checkout_metadata);
  end if;
  if v_payment.created_at <> now() or v_payment.status <> 'pending' or v_payment.provider_payment_reference is not null then
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
  if not found then raise exception 'PROMOTION_CODE_NOT_FOUND'; end if;
  v_reason := public.growup_checkout_promotion_reason(v_normalized, v_payment.plan, v_payment.billing_interval, p_tenant_id);
  if v_reason <> '' then raise exception '%', v_reason; end if;
  perform public.growup_require_promo_capacity(v_code.id, p_tenant_id);
  if v_code.benefit_type not in ('percent_discount', 'fixed_amount_discount')
    or v_code.benefit_value::text in ('NaN', 'Infinity', '-Infinity') or v_code.benefit_value <= 0 then raise exception 'PROMOTION_CODE_INVALID'; end if;
  v_base := public.growup_subscription_base_amount_minor(v_payment.plan, v_payment.billing_interval);
  if v_code.benefit_type = 'percent_discount' then
    if v_code.benefit_value > 100 then raise exception 'PROMOTION_CODE_INVALID'; end if;
    v_discount := round(v_base::numeric * v_code.benefit_value / 100)::integer;
  elsif v_code.benefit_type = 'fixed_amount_discount' then
    v_discount := least(v_base::numeric, round(v_code.benefit_value * 100))::integer;
  end if;
  v_amount := v_base - v_discount;
  if v_amount <= 0 then raise exception 'PROMOTION_CHECKOUT_POSITIVE_PAYMENT_REQUIRED'; end if;
  if v_amount < 1000 then raise exception 'PROMOTION_CHECKOUT_STRIPE_MINIMUM'; end if;
  v_snapshot := jsonb_build_object('version', 1, 'code', v_normalized, 'promotion_code_id', v_code.id,
    'benefit_type', v_code.benefit_type, 'benefit_value', v_code.benefit_value,
    'benefit_description', public.growup_promotion_benefit_description(v_code.benefit_type, v_code.benefit_value),
    'base_amount_minor', v_base, 'discount_amount_minor', v_discount, 'amount_minor', v_amount, 'currency', 'THB',
    'plan', v_payment.plan, 'billing_interval', v_payment.billing_interval);
  insert into public.promotion_payment_reservations(promotion_code_id, payment_id, tenant_id, snapshot)
  values(v_code.id, v_payment.id, p_tenant_id, v_snapshot) returning * into v_reservation;
  update public.payments set amount_minor = v_amount, checkout_metadata = checkout_metadata ||
    jsonb_build_object('amount_minor', v_amount, 'promotion', v_snapshot || jsonb_build_object('reservation_id', v_reservation.id))
  where id = v_payment.id returning * into v_payment;
  update public.subscription_upgrade_attempts set amount_minor = v_amount where payment_id = v_payment.id;
  insert into public.platform_admin_audit_log(actor_user_id, action, target_type, target_id, details)
  values(p_user_id, 'promotion_code.reserve', 'promotion_code', v_code.id::text,
    jsonb_build_object('code', v_normalized, 'payment_id', v_payment.id, 'reservation_id', v_reservation.id, 'tenant_id', p_tenant_id));
  return to_jsonb(v_checkout) || jsonb_build_object('amount_minor', v_amount, 'checkout_metadata', v_payment.checkout_metadata);
end;
$$;

revoke execute on function public.growup_checkout_promotion_reason(text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.growup_checkout_promotion_reason(text, text, text, uuid) to service_role;
commit;
