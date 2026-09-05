-- Additive Promo audience support for signup and existing customers.
-- Legacy rows keep their current behavior: new_customer_only=true means new;
-- false means both. No customer, payment, subscription, or redemption history
-- is rewritten by this migration.
begin;

alter table public.promotion_codes
  add column if not exists customer_scope text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.promotion_codes'::regclass
      and conname = 'promotion_codes_customer_scope_check'
  ) then
    alter table public.promotion_codes
      add constraint promotion_codes_customer_scope_check
      check (customer_scope is null or customer_scope in ('new', 'existing', 'both'));
  end if;
end;
$$;

create or replace function public.growup_platform_admin_promo_list(
  p_user_id text,
  p_limit integer default 200,
  p_offset integer default 0
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.growup_require_single_platform_super_admin(p_user_id);
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  return jsonb_build_object(
    'role', v_role,
    'kpis', jsonb_build_object(
      'active', (select count(*) from public.promotion_codes pc
        where pc.active = true and (pc.starts_at is null or pc.starts_at <= now())
          and (pc.ends_at is null or pc.ends_at >= now())
          and (pc.max_redemptions is null or (select count(*) from public.promotion_redemptions pr where pr.promotion_code_id = pc.id) < pc.max_redemptions)),
      'used', (select count(*) from public.promotion_redemptions),
      'total', (select count(*) from public.promotion_codes)
    ),
    'items', coalesce((
      with redemption_counts as (
        select pr.promotion_code_id, count(*)::integer as redemptions
        from public.promotion_redemptions pr group by pr.promotion_code_id
      )
      select jsonb_agg(to_jsonb(x) order by x.updated_at desc)
      from (
        select pc.id, public.growup_normalize_promotion_code(pc.code) as code,
          pc.description, pc.source_campaign, pc.active, pc.benefit_type, pc.benefit_value,
          pc.applicable_plans, pc.applicable_billing, pc.starts_at, pc.ends_at,
          pc.max_redemptions, pc.max_redemptions_per_tenant,
          case when pc.customer_scope in ('new', 'existing', 'both') then pc.customer_scope
            when pc.new_customer_only then 'new' else 'both' end as customer_scope,
          pc.new_customer_only, pc.created_by_user_id, pc.updated_by_user_id,
          pc.created_at, pc.updated_at, coalesce(rc.redemptions, 0) as redemptions,
          case
            when not pc.active then 'disabled'
            when pc.starts_at is not null and pc.starts_at > now() then 'scheduled'
            when pc.ends_at is not null and pc.ends_at < now() then 'expired'
            when pc.max_redemptions is not null and coalesce(rc.redemptions, 0) >= pc.max_redemptions then 'exhausted'
            else 'active'
          end as status
        from public.promotion_codes pc left join redemption_counts rc on rc.promotion_code_id = pc.id
        order by pc.updated_at desc limit v_limit offset v_offset
      ) x
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.growup_platform_admin_save_promotion_code(
  p_user_id text, p_input jsonb
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.growup_require_single_platform_super_admin(p_user_id);
  v_id uuid := nullif(trim(coalesce(p_input->>'id', '')), '')::uuid;
  v_code text := public.growup_normalize_promotion_code(p_input->>'code');
  v_description text := trim(coalesce(p_input->>'description', ''));
  v_source_campaign text := nullif(left(trim(coalesce(p_input->>'source_campaign', '')), 200), '');
  v_benefit_type text := lower(trim(coalesce(p_input->>'benefit_type', '')));
  v_benefit_value numeric := nullif(trim(coalesce(p_input->>'benefit_value', '')), '')::numeric;
  v_plans text[] := array(select lower(trim(value)) from jsonb_array_elements_text(coalesce(p_input->'applicable_plans', '[]'::jsonb)) as value);
  v_billing text[] := array(select lower(trim(value)) from jsonb_array_elements_text(coalesce(p_input->'applicable_billing', '[]'::jsonb)) as value);
  v_active boolean := coalesce((p_input->>'active')::boolean, true);
  v_starts_at timestamptz := nullif(trim(coalesce(p_input->>'starts_at', '')), '')::timestamptz;
  v_ends_at timestamptz := nullif(trim(coalesce(p_input->>'ends_at', '')), '')::timestamptz;
  v_max_redemptions integer := nullif(trim(coalesce(p_input->>'max_redemptions', '')), '')::integer;
  v_max_per_tenant integer := nullif(trim(coalesce(p_input->>'max_redemptions_per_tenant', '')), '')::integer;
  v_customer_scope text := lower(trim(coalesce(p_input->>'customer_scope', '')));
  v_old public.promotion_codes%rowtype;
  v_row public.promotion_codes%rowtype;
  v_changed_fields jsonb := '[]'::jsonb;
  v_action text;
begin
  if v_customer_scope not in ('new', 'existing', 'both') then
    v_customer_scope := case when coalesce((p_input->>'new_customer_only')::boolean, false) then 'new' else 'both' end;
  end if;
  if length(v_code) not between 2 and 64 or v_code !~ '^[A-Z0-9][A-Z0-9_-]*$'
    or length(v_description) > 500
    or v_benefit_type not in ('percent_discount', 'fixed_amount_discount', 'service_days', 'free_months')
    or v_benefit_value is null or v_benefit_value <= 0
    or (v_benefit_type = 'percent_discount' and v_benefit_value > 100)
    or (v_benefit_type in ('service_days', 'free_months') and v_benefit_value <> trunc(v_benefit_value))
    or cardinality(v_plans) = 0 or cardinality(v_billing) = 0
    or not (v_plans <@ array['starter', 'business', 'enterprise'])
    or not (v_billing <@ array['monthly', 'yearly'])
    or (v_max_redemptions is not null and v_max_redemptions <= 0)
    or (v_max_per_tenant is not null and v_max_per_tenant <= 0)
    or (v_starts_at is not null and v_ends_at is not null and v_ends_at <= v_starts_at)
    or length(coalesce(p_input->>'source_campaign', '')) > 200 then
    raise exception 'INVALID_PROMOTION_CODE';
  end if;
  if v_id is null then
    insert into public.promotion_codes (
      code, description, source_campaign, active, benefit_type, benefit_value,
      applicable_plans, applicable_billing, starts_at, ends_at,
      max_redemptions, max_redemptions_per_tenant, customer_scope, new_customer_only,
      created_by_user_id, updated_by_user_id
    ) values (
      v_code, v_description, v_source_campaign, v_active, v_benefit_type, v_benefit_value,
      v_plans, v_billing, v_starts_at, v_ends_at, v_max_redemptions, v_max_per_tenant,
      v_customer_scope, v_customer_scope = 'new', trim(p_user_id), trim(p_user_id)
    ) returning * into v_row;
    v_action := 'promotion_code.create';
    v_changed_fields := '["code","description","source_campaign","active","benefit_type","benefit_value","applicable_plans","applicable_billing","starts_at","ends_at","max_redemptions","max_redemptions_per_tenant","customer_scope"]'::jsonb;
  else
    select * into v_old from public.promotion_codes where id = v_id for update;
    if not found then raise exception 'PROMOTION_CODE_NOT_FOUND'; end if;
    if v_old.code is distinct from v_code then v_changed_fields := v_changed_fields || '"code"'::jsonb; end if;
    if v_old.description is distinct from v_description then v_changed_fields := v_changed_fields || '"description"'::jsonb; end if;
    if v_old.source_campaign is distinct from v_source_campaign then v_changed_fields := v_changed_fields || '"source_campaign"'::jsonb; end if;
    if v_old.active is distinct from v_active then v_changed_fields := v_changed_fields || '"active"'::jsonb; end if;
    if v_old.benefit_type is distinct from v_benefit_type then v_changed_fields := v_changed_fields || '"benefit_type"'::jsonb; end if;
    if v_old.benefit_value is distinct from v_benefit_value then v_changed_fields := v_changed_fields || '"benefit_value"'::jsonb; end if;
    if v_old.applicable_plans is distinct from v_plans then v_changed_fields := v_changed_fields || '"applicable_plans"'::jsonb; end if;
    if v_old.applicable_billing is distinct from v_billing then v_changed_fields := v_changed_fields || '"applicable_billing"'::jsonb; end if;
    if v_old.starts_at is distinct from v_starts_at then v_changed_fields := v_changed_fields || '"starts_at"'::jsonb; end if;
    if v_old.ends_at is distinct from v_ends_at then v_changed_fields := v_changed_fields || '"ends_at"'::jsonb; end if;
    if v_old.max_redemptions is distinct from v_max_redemptions then v_changed_fields := v_changed_fields || '"max_redemptions"'::jsonb; end if;
    if v_old.max_redemptions_per_tenant is distinct from v_max_per_tenant then v_changed_fields := v_changed_fields || '"max_redemptions_per_tenant"'::jsonb; end if;
    if coalesce(v_old.customer_scope, case when v_old.new_customer_only then 'new' else 'both' end) is distinct from v_customer_scope then v_changed_fields := v_changed_fields || '"customer_scope"'::jsonb; end if;
    update public.promotion_codes set
      code = v_code, description = v_description, source_campaign = v_source_campaign,
      active = v_active, benefit_type = v_benefit_type, benefit_value = v_benefit_value,
      applicable_plans = v_plans, applicable_billing = v_billing, starts_at = v_starts_at,
      ends_at = v_ends_at, max_redemptions = v_max_redemptions,
      max_redemptions_per_tenant = v_max_per_tenant, customer_scope = v_customer_scope,
      new_customer_only = v_customer_scope = 'new', updated_by_user_id = trim(p_user_id)
      where id = v_id returning * into v_row;
    v_action := case when v_old.active and not v_active then 'promotion_code.disable'
      when not v_old.active and v_active then 'promotion_code.reenable' else 'promotion_code.update' end;
  end if;
  insert into public.platform_admin_audit_log (actor_user_id, action, target_type, target_id, details)
    values (trim(p_user_id), v_action, 'promotion_code', v_row.id::text,
      jsonb_build_object('code', v_row.code, 'changed_fields', v_changed_fields));
  return jsonb_build_object('role', v_role, 'promotion', to_jsonb(v_row));
exception when unique_violation then raise exception 'PROMOTION_CODE_EXISTS' using errcode = '23505';
end;
$$;

create or replace function public.growup_validate_promotion_code(
  p_code text, p_selected_plan text, p_selected_billing text, p_tenant_id uuid default null
)
returns table (
  valid boolean, code text, selected_plan text, selected_billing text,
  benefit_type text, benefit_value numeric, benefit_description text, reason text
)
language plpgsql security definer set search_path = public as $$
declare
  v_code text := public.growup_normalize_promotion_code(p_code);
  v_selected_plan text := lower(trim(coalesce(p_selected_plan, '')));
  v_selected_billing text := lower(trim(coalesce(p_selected_billing, '')));
  v_promotion public.promotion_codes%rowtype;
  v_scope text;
  v_total_redemptions integer := 0;
  v_tenant_redemptions integer := 0;
begin
  if length(v_code) < 2 or v_selected_plan not in ('starter', 'business', 'enterprise')
    or v_selected_billing not in ('monthly', 'yearly') then
    return query select false, v_code, v_selected_plan, v_selected_billing, null::text, null::numeric, null::text, 'PROMOTION_CODE_INVALID'; return;
  end if;
  select * into v_promotion from public.promotion_codes pc
    where public.growup_normalize_promotion_code(pc.code) = v_code limit 1;
  if not found then
    return query select false, v_code, v_selected_plan, v_selected_billing, null::text, null::numeric, null::text, 'PROMOTION_CODE_INVALID'; return;
  end if;
  v_scope := case when v_promotion.customer_scope in ('new', 'existing', 'both') then v_promotion.customer_scope
    when v_promotion.new_customer_only then 'new' else 'both' end;
  if v_scope = 'existing' and p_tenant_id is null then
    return query select false, v_code, v_selected_plan, v_selected_billing, null::text, null::numeric, null::text, 'PROMOTION_CODE_EXISTING_CUSTOMERS_ONLY'; return;
  end if;
  if v_scope = 'new' and p_tenant_id is not null then
    return query select false, v_code, v_selected_plan, v_selected_billing, null::text, null::numeric, null::text, 'PROMOTION_CODE_NEW_CUSTOMERS_ONLY'; return;
  end if;
  if not v_promotion.active then
    return query select false, v_code, v_selected_plan, v_selected_billing, null::text, null::numeric, null::text, 'PROMOTION_CODE_INVALID'; return;
  end if;
  if (v_promotion.starts_at is not null and v_promotion.starts_at > now()) or (v_promotion.ends_at is not null and v_promotion.ends_at < now()) then
    return query select false, v_code, v_selected_plan, v_selected_billing, null::text, null::numeric, null::text, 'PROMOTION_CODE_EXPIRED'; return;
  end if;
  if not v_selected_plan = any(v_promotion.applicable_plans) or not v_selected_billing = any(v_promotion.applicable_billing) then
    return query select false, v_code, v_selected_plan, v_selected_billing, null::text, null::numeric, null::text, 'PROMOTION_CODE_INVALID'; return;
  end if;
  if v_promotion.max_redemptions is not null then
    select count(*) into v_total_redemptions from public.promotion_redemptions pr where pr.promotion_code_id = v_promotion.id;
    if v_total_redemptions >= v_promotion.max_redemptions then
      return query select false, v_code, v_selected_plan, v_selected_billing, null::text, null::numeric, null::text, 'PROMOTION_CODE_EXHAUSTED'; return;
    end if;
  end if;
  if p_tenant_id is not null and v_promotion.max_redemptions_per_tenant is not null then
    select count(*) into v_tenant_redemptions from public.promotion_redemptions pr
      where pr.promotion_code_id = v_promotion.id and pr.tenant_id = p_tenant_id;
    if v_tenant_redemptions >= v_promotion.max_redemptions_per_tenant then
      return query select false, v_code, v_selected_plan, v_selected_billing, null::text, null::numeric, null::text, 'PROMOTION_CODE_EXHAUSTED'; return;
    end if;
  end if;
  return query select true, public.growup_normalize_promotion_code(v_promotion.code), v_selected_plan, v_selected_billing,
    v_promotion.benefit_type, v_promotion.benefit_value,
    public.growup_promotion_benefit_description(v_promotion.benefit_type, v_promotion.benefit_value), null::text;
end;
$$;

create or replace function public.growup_quote_signup_promotion(
  p_code text, p_selected_plan text, p_selected_billing text
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_validation record;
  v_promotion public.promotion_codes%rowtype;
  v_base integer;
  v_discount integer := 0;
  v_amount integer;
  v_mode text := 'payment';
begin
  select * into v_validation from public.growup_validate_promotion_code(p_code, p_selected_plan, p_selected_billing, null);
  if not coalesce(v_validation.valid, false) then raise exception '%', coalesce(v_validation.reason, 'PROMOTION_CODE_INVALID'); end if;
  select * into v_promotion from public.promotion_codes where public.growup_normalize_promotion_code(code) = v_validation.code limit 1;
  v_base := public.growup_subscription_base_amount_minor(v_validation.selected_plan, v_validation.selected_billing);
  if v_promotion.benefit_type = 'percent_discount' then
    v_discount := least(v_base, round(v_base::numeric * v_promotion.benefit_value / 100)::integer);
  elsif v_promotion.benefit_type = 'fixed_amount_discount' then
    v_discount := least(v_base, round(v_promotion.benefit_value * 100)::integer);
  elsif v_promotion.benefit_type in ('service_days', 'free_months') then
    v_mode := 'free_service';
  end if;
  v_amount := case when v_mode = 'free_service' then 0 else v_base - v_discount end;
  return jsonb_build_object(
    'code', v_validation.code, 'plan', v_validation.selected_plan, 'billing', v_validation.selected_billing,
    'mode', v_mode, 'benefit_type', v_validation.benefit_type, 'benefit_value', v_validation.benefit_value,
    'benefit_description', v_validation.benefit_description, 'amount_minor', v_amount,
    'base_amount_minor', v_base, 'discount_amount_minor', v_discount,
    'definition_version', md5(to_jsonb(v_promotion)::text)
  );
end;
$$;

create or replace function public.growup_enforce_signup_promo_scope()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_scope text;
  v_source text;
begin
  select case when pc.customer_scope in ('new', 'existing', 'both') then pc.customer_scope
    when pc.new_customer_only then 'new' else 'both' end
    into v_scope
    from public.promotion_codes pc where pc.id = new.promotion_code_id;
  select coalesce(t.metadata->>'source', '') into v_source from public.tenants t where t.id = new.tenant_id;
  if v_source = 'public_signup' and v_scope = 'existing' then
    raise exception 'PROMOTION_CODE_EXISTING_CUSTOMERS_ONLY';
  end if;
  return new;
end;
$$;

drop trigger if exists promotion_redemptions_signup_scope on public.promotion_redemptions;
create trigger promotion_redemptions_signup_scope
before insert on public.promotion_redemptions
for each row execute function public.growup_enforce_signup_promo_scope();

revoke execute on function public.growup_quote_signup_promotion(text, text, text) from public, anon, authenticated;
grant execute on function public.growup_quote_signup_promotion(text, text, text) to service_role;

commit;
