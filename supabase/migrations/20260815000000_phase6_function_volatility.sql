-- Phase 6 readiness: align helper-function volatility with Supabase lint findings.
-- Forward-only, metadata-only replacement. No data changes.

create or replace function public.growup_promotion_benefit_description(
  p_benefit_type text,
  p_benefit_value numeric
)
returns text
language plpgsql
stable
as $$
declare
  v_value text := trim(to_char(coalesce(p_benefit_value, 0), 'FM999999990.##'));
begin
  if p_benefit_type = 'percent_discount' then
    return 'ลด ' || v_value || '%';
  elsif p_benefit_type = 'fixed_amount_discount' then
    return 'ลด ฿' || v_value;
  elsif p_benefit_type = 'extra_trial_days' then
    return 'เพิ่มระยะทดลองใช้ฟรี ' || trim(to_char(coalesce(p_benefit_value, 0), 'FM999999990')) || ' วัน';
  elsif p_benefit_type = 'free_months' then
    return 'ใช้ฟรีเพิ่ม ' || trim(to_char(coalesce(p_benefit_value, 0), 'FM999999990')) || ' เดือน';
  end if;
  return '';
end;
$$;

create or replace function public.growup_payment_period_end(
  p_started_at timestamptz,
  p_billing_interval text
)
returns timestamptz
language plpgsql
stable
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
