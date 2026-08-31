-- PREVIEW ONLY, prospective. Reuse subscription snapshots, not another subscription.
-- Base plan/status/paid periods/trial/prices remain unchanged by free service.
begin;
alter table public.promotion_redemptions add column entitlement_request_key text unique;

create function public.growup_zero_promo_grant(p_subscription public.subscriptions,p_redemption public.promotion_redemptions,p_code text,p_key text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_start timestamptz:=now(); v_end timestamptz; v_unit text;
begin
  if p_redemption.tenant_id <> p_subscription.tenant_id or p_redemption.benefit_type not in ('service_days','free_months') then
    raise exception 'PROMOTION_CODE_INVALID';
  end if;
  -- Same-plan service follows already-earned base access. An upgrade starts now
  -- and temporarily overlays (never destroys) the previous/base plan.
  if p_redemption.selected_plan=p_subscription.plan then
    if p_subscription.status='trialing' and p_subscription.trial_ends_at > now() then v_start:=p_subscription.trial_ends_at;
    elsif p_subscription.status='active' and p_subscription.current_period_ends_at > now() then v_start:=p_subscription.current_period_ends_at;
    end if;
  end if;
  v_unit:=case p_redemption.benefit_type when 'service_days' then 'days' else 'months' end;
  v_end:=public.growup_promo_service_period_end(v_start,v_unit,p_redemption.benefit_value);
  return jsonb_build_object('version',1,'source','promotion_zero_payment','state','granted',
    'tenant_id',p_subscription.tenant_id,'subscription_id',p_subscription.id,'plan',p_redemption.selected_plan,'billing_interval',p_redemption.selected_billing,
    'promotion_code_id',p_redemption.promotion_code_id,'code',p_code,'redemption_id',p_redemption.id,'request_key',p_key,
    'unit',v_unit,'value',p_redemption.benefit_value,'starts_at',v_start,'ends_at',v_end,'timezone','Asia/Bangkok',
    'base_subscription',jsonb_build_object('plan',p_subscription.plan,'status',p_subscription.status,
      'billing_interval',p_subscription.billing_interval,'trial_started_at',p_subscription.trial_started_at,'trial_ends_at',p_subscription.trial_ends_at,
      'current_period_started_at',p_subscription.current_period_started_at,'current_period_ends_at',p_subscription.current_period_ends_at));
end; $$;

create function public.growup_quote_checkout_promotion(p_tenant_id uuid,p_user_id text,p_code text,p_plan text,p_billing text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_validation record; v_code public.promotion_codes%rowtype; v_sub public.subscriptions%rowtype;
  v_base integer; v_discount integer:=0; v_amount integer; v_mode text;
begin
  if not exists (select 1 from public.tenant_memberships m join public.users u on u.id=m.user_id
    where m.tenant_id=p_tenant_id and m.user_id=p_user_id and m.is_active and u.is_active and lower(m.role)='owner') then
    raise exception 'SUBSCRIPTION_CHECKOUT_OWNER_REQUIRED';
  end if;
  select * into v_sub from public.subscriptions where tenant_id=p_tenant_id and is_initial;
  if not found or v_sub.status not in ('active','trialing','expired','pending_payment')
    or array_position(array['starter','business','enterprise'],p_plan) < array_position(array['starter','business','enterprise'],v_sub.plan) then
    raise exception 'PROMOTION_CHECKOUT_NOT_ALLOWED';
  end if;
  if v_sub.promotion_snapshot->'service_entitlement'->>'state'='pending_verified_payment' then
    raise exception 'PROMOTION_CHECKOUT_SIGNUP_BENEFIT_PENDING';
  end if;
  select * into v_code from public.promotion_codes where public.growup_normalize_promotion_code(code)=public.growup_normalize_promotion_code(p_code) for update;
  if not found then raise exception 'PROMOTION_CODE_INVALID'; end if;
  select * into v_validation from public.growup_validate_promotion_code(p_code,p_plan,p_billing,p_tenant_id);
  if not v_validation.valid then raise exception '%',v_validation.reason; end if;
  perform public.growup_require_promo_capacity(v_code.id,p_tenant_id);
  v_base:=public.growup_subscription_base_amount_minor(p_plan,p_billing);
  if v_code.benefit_type in ('service_days','free_months') then
    perform public.growup_promo_service_period_end(now(),case v_code.benefit_type when 'service_days' then 'days' else 'months' end,v_code.benefit_value);
    v_mode:='free_service'; v_amount:=0;
  else
    v_mode:='payment';
    if v_sub.status='pending_payment' and v_sub.current_period_started_at is null and p_plan=v_sub.plan then
      raise exception 'PROMOTION_CHECKOUT_NOT_ALLOWED';
    end if;
    if v_code.benefit_type='percent_discount' then v_discount:=round(v_base::numeric*v_code.benefit_value/100)::integer;
    elsif v_code.benefit_type='fixed_amount_discount' then v_discount:=least(v_base::numeric,round(v_code.benefit_value*100))::integer;
    else raise exception 'PROMOTION_CODE_INVALID'; end if;
    v_amount:=v_base-v_discount;
    if v_amount<=0 then raise exception 'PROMOTION_CHECKOUT_POSITIVE_PAYMENT_REQUIRED'; end if;
    if v_amount<1000 then raise exception 'PROMOTION_CHECKOUT_STRIPE_MINIMUM'; end if;
  end if;
  return jsonb_build_object('code',public.growup_normalize_promotion_code(v_code.code),'plan',p_plan,'billing',p_billing,
    'mode',v_mode,'benefit_type',v_code.benefit_type,'benefit_value',v_code.benefit_value,
    'amount_minor',v_amount,'base_amount_minor',v_base,'discount_amount_minor',v_discount,
    'definition_version',md5(to_jsonb(v_code)::text));
end; $$;

create function public.growup_redeem_zero_payment_promo(p_tenant_id uuid,p_user_id text,p_code text,p_plan text,p_billing text,p_request_key text,p_definition_version text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_sub public.subscriptions%rowtype; v_code public.promotion_codes%rowtype; v_redemption public.promotion_redemptions%rowtype;
  v_quote jsonb; v_grant jsonb; v_existing jsonb; v_grants jsonb;
begin
  if length(p_request_key)<>64 or p_request_key !~ '^[a-f0-9]+$' or not exists (
    select 1 from public.tenant_memberships m join public.users u on u.id=m.user_id
    where m.tenant_id=p_tenant_id and m.user_id=p_user_id and m.is_active and u.is_active and lower(m.role)='owner'
  ) then raise exception 'SUBSCRIPTION_CHECKOUT_OWNER_REQUIRED'; end if;
  select * into v_sub from public.subscriptions where tenant_id=p_tenant_id and is_initial for update;
  if not found then raise exception 'SUBSCRIPTION_NOT_FOUND'; end if;
  v_grants:=coalesce(v_sub.promotion_snapshot->'zero_payment_entitlements','[]'::jsonb);
  select value into v_existing from jsonb_array_elements(v_grants)
    where value->>'request_key'=p_request_key limit 1;
  if found then return jsonb_build_object('grant',v_existing,'reused',true); end if;
  -- Refresh/new quote while the same grant is live/scheduled cannot extend it.
  select value into v_existing from jsonb_array_elements(v_grants)
    where value->>'code'=public.growup_normalize_promotion_code(p_code) and value->>'plan'=p_plan
      and value->>'billing_interval'=p_billing and (value->>'ends_at')::timestamptz > now() limit 1;
  if found then return jsonb_build_object('grant',v_existing,'reused',true); end if;
  if exists(select 1 from jsonb_array_elements(v_grants) where (value->>'ends_at')::timestamptz>now()) then
    raise exception 'PROMOTION_SERVICE_ALREADY_GRANTED';
  end if;
  if exists(select 1 from public.payments where tenant_id=p_tenant_id and status in ('pending','processing')) then
    raise exception 'PROMOTION_CHECKOUT_CONFLICT';
  end if;
  v_quote:=public.growup_quote_checkout_promotion(p_tenant_id,p_user_id,p_code,p_plan,p_billing);
  if v_quote->>'mode'<>'free_service' or v_quote->>'definition_version' is distinct from p_definition_version then
    raise exception 'PROMOTION_QUOTE_CHANGED';
  end if;
  select * into v_code from public.promotion_codes where public.growup_normalize_promotion_code(code)=v_quote->>'code';
  insert into public.promotion_redemptions(promotion_code_id,tenant_id,selected_plan,selected_billing,benefit_type,benefit_value,benefit_description,entitlement_request_key)
  values(v_code.id,p_tenant_id,p_plan,p_billing,v_code.benefit_type,v_code.benefit_value,
    'ใช้ฟรี '||v_code.benefit_value::text||case v_code.benefit_type when 'service_days' then ' วัน' else ' เดือน' end,p_request_key)
  returning * into v_redemption;
  v_grant:=public.growup_zero_promo_grant(v_sub,v_redemption,v_quote->>'code',p_request_key);
  update public.subscriptions set promotion_snapshot=promotion_snapshot||jsonb_build_object('zero_payment_entitlements',v_grants||jsonb_build_array(v_grant)) where id=v_sub.id;
  insert into public.platform_admin_audit_log(actor_user_id,action,target_type,target_id,details)
  values(p_user_id,'promotion_code.service_entitlement','promotion_code',v_code.id::text,jsonb_build_object('code',v_quote->>'code','grant',v_grant));
  return jsonb_build_object('grant',v_grant,'reused',false);
end; $$;

-- New Signup Free Days/Months uses exactly the same grant builder. Existing
-- historical paid-bonus grants are not backfilled or reinterpreted.
create function public.growup_signup_zero_payment_promo()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_redemption public.promotion_redemptions%rowtype; v_grant jsonb;
begin
  if new.source<>'public_signup' or not new.is_initial or new.promotion_benefit_type is null
    or new.promotion_benefit_type not in ('service_days','free_months') then return new; end if;
  select * into v_redemption from public.promotion_redemptions where id=new.promotion_redemption_id
    and tenant_id=new.tenant_id and promotion_code_id=new.promotion_code_id and selected_plan=new.plan and selected_billing=new.billing_interval;
  if not found or v_redemption.benefit_type<>new.promotion_benefit_type or v_redemption.benefit_value<>new.promotion_benefit_value then
    raise exception 'PROMOTION_CODE_INVALID'; end if;
  -- Stable redemption identifier, not a credential; no extension/search_path dependency.
  v_grant:=public.growup_zero_promo_grant(new,v_redemption,new.promotion_code,
    md5('signup:'||v_redemption.id::text)||md5('grant:'||v_redemption.id::text));
  new.promotion_snapshot:=new.promotion_snapshot||jsonb_build_object('zero_payment_entitlements',jsonb_build_array(v_grant));
  insert into public.platform_admin_audit_log(actor_user_id,action,target_type,target_id,details)
  values(null,'promotion_code.service_entitlement','promotion_code',new.promotion_code_id::text,jsonb_build_object('code',new.promotion_code,'grant',v_grant));
  return new;
end; $$;
drop trigger subscriptions_promo_service_entitlement on public.subscriptions;
create trigger subscriptions_promo_service_entitlement before update on public.subscriptions
for each row execute function public.growup_apply_promo_service_entitlement();
create trigger subscriptions_signup_zero_promo before insert on public.subscriptions
for each row execute function public.growup_signup_zero_payment_promo();

revoke execute on function public.growup_zero_promo_grant(public.subscriptions,public.promotion_redemptions,text,text) from public,anon,authenticated;
revoke execute on function public.growup_signup_zero_payment_promo() from public,anon,authenticated;
revoke execute on function public.growup_quote_checkout_promotion(uuid,text,text,text,text) from public,anon,authenticated;
revoke execute on function public.growup_redeem_zero_payment_promo(uuid,text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.growup_quote_checkout_promotion(uuid,text,text,text,text) to service_role;
grant execute on function public.growup_redeem_zero_payment_promo(uuid,text,text,text,text,text,text) to service_role;
commit;
