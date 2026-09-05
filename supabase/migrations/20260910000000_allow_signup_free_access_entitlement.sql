-- Preview-only forward repair for the initial subscription trigger.
-- Explicit free-access Promo codes are paid-required after entitlement expiry,
-- so they must be allowed through the initial paid-signup guard.
begin;

create or replace function public.growup_enforce_initial_trial_window()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.source = 'public_signup' and new.is_initial = true then
    if new.promotion_benefit_type is not null
      and new.promotion_benefit_type not in ('percent_discount', 'fixed_amount_discount', 'service_days', 'free_months') then
      raise exception 'PROMOTION_CODE_NOT_ALLOWED';
    end if;
    if new.amount_due_minor <= 0
      and new.promotion_benefit_type not in ('service_days', 'free_months') then
      raise exception 'PROMOTION_CHECKOUT_POSITIVE_PAYMENT_REQUIRED';
    end if;
    new.status := 'pending_payment';
    new.extra_trial_days := 0;
    new.free_months := case when new.promotion_benefit_type = 'free_months' then floor(new.promotion_benefit_value)::integer else 0 end;
    new.trial_started_at := null;
    new.trial_ends_at := null;
    new.current_period_started_at := null;
    new.current_period_ends_at := null;
    new.next_renewal_at := null;
    new.payment_due_at := now();
    new.promotion_snapshot := coalesce(new.promotion_snapshot, '{}'::jsonb)
      || jsonb_build_object('paid_signup', true, 'free_access', new.promotion_benefit_type in ('service_days', 'free_months'),
        'trial_days', 0, 'extra_trial_days', 0,
        'free_months', case when new.promotion_benefit_type = 'free_months' then floor(new.promotion_benefit_value)::integer else 0 end);
  end if;
  return new;
end;
$$;

comment on function public.growup_enforce_initial_trial_window()
  is 'Paid-first signup guard; explicit service_days/free_months use the zero-payment entitlement trigger and expire into checkout.';

commit;
