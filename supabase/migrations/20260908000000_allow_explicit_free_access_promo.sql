-- Preview-only forward compatibility for explicit Promo free access.
-- Keep legacy trial extensions and zero-charge discounts rejected.
begin;

create or replace function public.growup_guard_paid_promotion_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT'
    or new.benefit_type is distinct from old.benefit_type
    or new.benefit_value is distinct from old.benefit_value then
    if new.benefit_type not in ('percent_discount', 'fixed_amount_discount', 'service_days', 'free_months')
      or new.benefit_value is null
      or new.benefit_value::text in ('NaN', 'Infinity', '-Infinity')
      or new.benefit_value <= 0
      or (new.benefit_type = 'percent_discount' and new.benefit_value >= 100)
      or (new.benefit_type in ('service_days', 'free_months') and new.benefit_value <> trunc(new.benefit_value)) then
      raise exception 'PROMOTION_CODE_NOT_ALLOWED';
    end if;
  end if;
  return new;
end;
$$;

comment on function public.growup_guard_paid_promotion_code()
  is 'Allows paid discounts and explicit integer free-access days/months; rejects legacy trials and zero-charge discounts.';

commit;
