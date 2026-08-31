-- Forward-only Promo service entitlement. Apply to Preview first.
-- No backfill: no existing subscription/redemption/payment row is rewritten.
-- The initial-trial trigger, signup RPC, checkout RPC and verified-payment RPC
-- are deliberately unchanged. A service bonus is NOT extra_trial_days.
begin;

alter table public.promotion_codes drop constraint promotion_codes_benefit_type_check;
alter table public.promotion_codes add constraint promotion_codes_benefit_type_check
  check (benefit_type in ('percent_discount', 'fixed_amount_discount', 'extra_trial_days', 'service_days', 'free_months'));
alter table public.promotion_redemptions drop constraint promotion_redemptions_benefit_type_check;
alter table public.promotion_redemptions add constraint promotion_redemptions_benefit_type_check
  check (benefit_type in ('percent_discount', 'fixed_amount_discount', 'extra_trial_days', 'service_days', 'free_months'));
alter table public.subscriptions drop constraint subscriptions_promotion_benefit_type_check;
alter table public.subscriptions add constraint subscriptions_promotion_benefit_type_check
  check (promotion_benefit_type is null or promotion_benefit_type in
    ('percent_discount', 'fixed_amount_discount', 'extra_trial_days', 'service_days', 'free_months'));

create or replace function public.growup_promotion_benefit_description(
  p_benefit_type text, p_benefit_value numeric
)
returns text language plpgsql immutable as $$
declare
  v_value text := trim(to_char(coalesce(p_benefit_value, 0), 'FM999999990.##'));
begin
  if p_benefit_type = 'percent_discount' then return 'ลด ' || v_value || '%';
  elsif p_benefit_type = 'fixed_amount_discount' then return 'ลด ฿' || v_value;
  elsif p_benefit_type = 'extra_trial_days' then
    return 'เพิ่มระยะทดลองใช้ฟรี ' || trim(to_char(coalesce(p_benefit_value, 0), 'FM999999990')) || ' วัน';
  elsif p_benefit_type = 'service_days' then
    return 'สิทธิ์บริการเพิ่ม ' || trim(to_char(p_benefit_value, 'FM999999990')) || ' วัน หลังยืนยันการชำระเงิน';
  elsif p_benefit_type = 'free_months' then
    return 'สิทธิ์บริการเพิ่ม ' || trim(to_char(p_benefit_value, 'FM999999990')) || ' เดือน หลังยืนยันการชำระเงิน';
  end if;
  return '';
end;
$$;

create or replace function public.growup_platform_admin_save_promotion_code(
  p_user_id text,
  p_input jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.growup_require_single_platform_super_admin(p_user_id);
  v_id uuid := nullif(trim(coalesce(p_input->>'id', '')), '')::uuid;
  v_code text := public.growup_normalize_promotion_code(p_input->>'code');
  v_description text := trim(coalesce(p_input->>'description', ''));
  v_benefit_type text := lower(trim(coalesce(p_input->>'benefit_type', '')));
  v_benefit_value numeric := nullif(trim(coalesce(p_input->>'benefit_value', '')), '')::numeric;
  v_plans text[] := array(select lower(trim(value)) from jsonb_array_elements_text(coalesce(p_input->'applicable_plans', '[]'::jsonb)) as value);
  v_billing text[] := array(select lower(trim(value)) from jsonb_array_elements_text(coalesce(p_input->'applicable_billing', '[]'::jsonb)) as value);
  v_active boolean := coalesce((p_input->>'active')::boolean, true);
  v_starts_at timestamptz := nullif(trim(coalesce(p_input->>'starts_at', '')), '')::timestamptz;
  v_ends_at timestamptz := nullif(trim(coalesce(p_input->>'ends_at', '')), '')::timestamptz;
  v_max_redemptions integer := nullif(trim(coalesce(p_input->>'max_redemptions', '')), '')::integer;
  v_max_per_tenant integer := nullif(trim(coalesce(p_input->>'max_redemptions_per_tenant', '')), '')::integer;
  v_new_customer_only boolean := coalesce((p_input->>'new_customer_only')::boolean, false);
  v_old public.promotion_codes%rowtype;
  v_row public.promotion_codes%rowtype;
  v_changed_fields jsonb := '[]'::jsonb;
  v_action text;
begin
  if length(v_code) not between 2 and 64
    or v_code !~ '^[A-Z0-9][A-Z0-9_-]*$'
    or length(v_description) > 500
    or v_benefit_type not in ('percent_discount', 'fixed_amount_discount', 'service_days', 'free_months')
    or v_benefit_value is null
    or v_benefit_value::text in ('NaN', 'Infinity', '-Infinity')
    or v_benefit_value <= 0
    or (v_benefit_type = 'percent_discount' and v_benefit_value > 100)
    or (v_benefit_type in ('service_days', 'free_months') and v_benefit_value <> trunc(v_benefit_value))
    or cardinality(v_plans) = 0
    or cardinality(v_billing) = 0
    or not (v_plans <@ array['starter', 'business', 'enterprise'])
    or not (v_billing <@ array['monthly', 'yearly'])
    or (v_max_redemptions is not null and v_max_redemptions <= 0)
    or (v_max_per_tenant is not null and v_max_per_tenant <= 0)
    or (v_starts_at is not null and v_ends_at is not null and v_ends_at <= v_starts_at) then
    raise exception 'INVALID_PROMOTION_CODE';
  end if;

  if v_id is null then
    insert into public.promotion_codes (
      code,
      description,
      active,
      benefit_type,
      benefit_value,
      applicable_plans,
      applicable_billing,
      starts_at,
      ends_at,
      max_redemptions,
      max_redemptions_per_tenant,
      new_customer_only,
      created_by_user_id,
      updated_by_user_id
    ) values (
      v_code,
      v_description,
      v_active,
      v_benefit_type,
      v_benefit_value,
      v_plans,
      v_billing,
      v_starts_at,
      v_ends_at,
      v_max_redemptions,
      v_max_per_tenant,
      v_new_customer_only,
      trim(p_user_id),
      trim(p_user_id)
    ) returning * into v_row;
    v_action := 'promotion_code.create';
    v_changed_fields := '["code","description","active","benefit_type","benefit_value","applicable_plans","applicable_billing","starts_at","ends_at","max_redemptions","max_redemptions_per_tenant","new_customer_only"]'::jsonb;
  else
    select * into v_old
    from public.promotion_codes pc
    where pc.id = v_id
    for update;
    if not found then raise exception 'PROMOTION_CODE_NOT_FOUND'; end if;

    if v_old.code is distinct from v_code then v_changed_fields := v_changed_fields || '"code"'::jsonb; end if;
    if v_old.description is distinct from v_description then v_changed_fields := v_changed_fields || '"description"'::jsonb; end if;
    if v_old.active is distinct from v_active then v_changed_fields := v_changed_fields || '"active"'::jsonb; end if;
    if v_old.benefit_type is distinct from v_benefit_type then v_changed_fields := v_changed_fields || '"benefit_type"'::jsonb; end if;
    if v_old.benefit_value is distinct from v_benefit_value then v_changed_fields := v_changed_fields || '"benefit_value"'::jsonb; end if;
    if v_old.applicable_plans is distinct from v_plans then v_changed_fields := v_changed_fields || '"applicable_plans"'::jsonb; end if;
    if v_old.applicable_billing is distinct from v_billing then v_changed_fields := v_changed_fields || '"applicable_billing"'::jsonb; end if;
    if v_old.starts_at is distinct from v_starts_at then v_changed_fields := v_changed_fields || '"starts_at"'::jsonb; end if;
    if v_old.ends_at is distinct from v_ends_at then v_changed_fields := v_changed_fields || '"ends_at"'::jsonb; end if;
    if v_old.max_redemptions is distinct from v_max_redemptions then v_changed_fields := v_changed_fields || '"max_redemptions"'::jsonb; end if;
    if v_old.max_redemptions_per_tenant is distinct from v_max_per_tenant then v_changed_fields := v_changed_fields || '"max_redemptions_per_tenant"'::jsonb; end if;
    if v_old.new_customer_only is distinct from v_new_customer_only then v_changed_fields := v_changed_fields || '"new_customer_only"'::jsonb; end if;

    update public.promotion_codes
    set code = v_code,
        description = v_description,
        active = v_active,
        benefit_type = v_benefit_type,
        benefit_value = v_benefit_value,
        applicable_plans = v_plans,
        applicable_billing = v_billing,
        starts_at = v_starts_at,
        ends_at = v_ends_at,
        max_redemptions = v_max_redemptions,
        max_redemptions_per_tenant = v_max_per_tenant,
        new_customer_only = v_new_customer_only,
        updated_by_user_id = trim(p_user_id)
    where id = v_id
    returning * into v_row;

    v_action := case
      when v_old.active = true and v_active = false then 'promotion_code.disable'
      when v_old.active = false and v_active = true then 'promotion_code.reenable'
      else 'promotion_code.update'
    end;
  end if;

  insert into public.platform_admin_audit_log (actor_user_id, action, target_type, target_id, details)
  values (
    trim(p_user_id),
    v_action,
    'promotion_code',
    v_row.id::text,
    jsonb_build_object('code', v_row.code, 'changed_fields', v_changed_fields)
  );

  return jsonb_build_object('role', v_role, 'promotion', to_jsonb(v_row));
exception
  when unique_violation then
    raise exception 'PROMOTION_CODE_EXISTS' using errcode = '23505';
end;
$$;

-- Explicit Bangkok calendar arithmetic: months clamp to the destination month's
-- last day. Days are calendar days in Bangkok (no DST), never fractional days.
create or replace function public.growup_promo_service_period_end(
  p_base_end timestamptz, p_unit text, p_value numeric
)
returns timestamptz
language plpgsql immutable
set search_path = public
as $$
begin
  if p_base_end is null or not isfinite(p_base_end)
    or p_unit is null or p_unit not in ('days', 'months')
    or p_value is null or p_value::text in ('NaN', 'Infinity', '-Infinity')
    or p_value <= 0 or p_value <> trunc(p_value) or p_value > 2147483647 then
    raise exception 'INVALID_PROMO_SERVICE_ENTITLEMENT';
  end if;
  return ((p_base_end at time zone 'Asia/Bangkok')
    + case when p_unit = 'days' then make_interval(days => p_value::integer)
      else make_interval(months => p_value::integer) end) at time zone 'Asia/Bangkok';
end;
$$;

-- Versioned grant is stored in the existing authoritative subscription snapshot.
-- INSERT only reserves a benefit; it does NOT change status/trial/paid dates.
-- UPDATE consumes it exactly once, only alongside an already verified paid
-- period on the SAME redeemed plan/billing interval. No webhook authority changes.
create or replace function public.growup_apply_promo_service_entitlement()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_redemption public.promotion_redemptions%rowtype;
  v_payment public.payments%rowtype;
  v_grant jsonb;
  v_end timestamptz;
begin
  if tg_op = 'INSERT' then
    if new.source <> 'public_signup' or not new.is_initial
      or new.promotion_benefit_type is null
      or new.promotion_benefit_type not in ('service_days', 'free_months') then
      return new;
    end if;
    select * into v_redemption from public.promotion_redemptions r
    where r.id = new.promotion_redemption_id and r.tenant_id = new.tenant_id
      and r.promotion_code_id = new.promotion_code_id;
    if not found or v_redemption.benefit_type <> new.promotion_benefit_type
      or v_redemption.benefit_value is distinct from new.promotion_benefit_value
      or v_redemption.selected_plan <> new.plan
      or v_redemption.selected_billing <> new.billing_interval
      or new.extra_trial_days <> 0 then
      raise exception 'INVALID_PROMO_SERVICE_ENTITLEMENT';
    end if;
    -- Also validates finite positive integer and representable calendar interval.
    perform public.growup_promo_service_period_end(now(),
      case new.promotion_benefit_type when 'service_days' then 'days' else 'months' end,
      v_redemption.benefit_value);
    new.promotion_snapshot := coalesce(new.promotion_snapshot, '{}'::jsonb)
      || jsonb_build_object('service_entitlement', jsonb_build_object(
        'version', 1, 'state', 'pending_verified_payment',
        'unit', case new.promotion_benefit_type when 'service_days' then 'days' else 'months' end,
        'value', v_redemption.benefit_value, 'redemption_id', v_redemption.id,
        'plan', new.plan, 'billing_interval', new.billing_interval,
        'reserved_at', now(), 'timezone', 'Asia/Bangkok'
      ));
    return new;
  end if;

  v_grant := old.promotion_snapshot->'service_entitlement';
  if v_grant is null or v_grant->>'version' <> '1' then return new; end if;
  -- The existing grant cannot be reset/replaced by an unrelated update.
  new.promotion_snapshot := coalesce(new.promotion_snapshot, '{}'::jsonb)
    || jsonb_build_object('service_entitlement', v_grant);
  if v_grant->>'state' <> 'pending_verified_payment'
    or new.status <> 'active'
    or new.tenant_id is distinct from old.tenant_id
    or new.promotion_redemption_id is distinct from old.promotion_redemption_id
    or new.plan <> v_grant->>'plan'
    or new.billing_interval <> v_grant->>'billing_interval' then return new; end if;

  select * into v_payment from public.payments p
  where p.subscription_id = new.id and p.tenant_id = new.tenant_id
    and p.plan = new.plan and p.billing_interval = new.billing_interval
    and p.status = 'paid' and p.paid_at is not null and p.amount_minor > 0
    and p.provider_metadata->>'last_provider_status' = 'succeeded'
    and p.billing_period_started_at = new.current_period_started_at
    and p.billing_period_ends_at = new.current_period_ends_at
    and p.amount_minor = new.amount_due_minor
  order by p.paid_at desc, p.id limit 1;
  if not found then return new; end if;

  v_end := public.growup_promo_service_period_end(
    new.current_period_ends_at, v_grant->>'unit', (v_grant->>'value')::numeric);
  v_grant := v_grant || jsonb_build_object(
    'state', 'applied', 'payment_id', v_payment.id,
    'service_started_at', new.current_period_ends_at, 'service_ends_at', v_end,
    'applied_at', now()
  );
  new.current_period_ends_at := v_end;
  new.next_renewal_at := v_end;
  new.payment_due_at := v_end;
  new.promotion_snapshot := new.promotion_snapshot
    || jsonb_build_object('service_entitlement', v_grant);

  insert into public.platform_admin_audit_log(actor_user_id, action, target_type, target_id, details)
  values(null, 'promotion_code.service_entitlement', 'promotion_code', new.promotion_code_id::text,
    jsonb_build_object('subscription_id', new.id, 'tenant_id', new.tenant_id,
      'redemption_id', new.promotion_redemption_id, 'grant', v_grant));
  return new;
end;
$$;

-- Alphabetically AFTER subscriptions_initial_trial_window, which stays intact.
create trigger subscriptions_promo_service_entitlement
before insert or update on public.subscriptions
for each row execute function public.growup_apply_promo_service_entitlement();

revoke execute on function public.growup_platform_admin_save_promotion_code(text, jsonb) from public, anon, authenticated;
grant execute on function public.growup_platform_admin_save_promotion_code(text, jsonb) to service_role;
revoke execute on function public.growup_promo_service_period_end(timestamptz, text, numeric) from public, anon, authenticated;
grant execute on function public.growup_promo_service_period_end(timestamptz, text, numeric) to service_role;
revoke execute on function public.growup_apply_promo_service_entitlement() from public, anon, authenticated;
-- Trigger only; no callable customer or Platform Admin activation endpoint.

comment on function public.growup_apply_promo_service_entitlement() is
  'Prospective one-time Promo service bonus after verified paid period; never extends signup trial, never rewrites historical grants.';
commit;

-- Rollback policy: disable Promo creation first. Do not remove an applied
-- entitlement or mutate orders/payments/subscriptions. Prior app remains able
-- to read the extended authoritative period; retain snapshot/audit history.
