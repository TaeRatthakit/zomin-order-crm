-- Growup Pilot Platform Admin Promo completion.
-- Additive/backward-compatible. Apply to Preview project enwabsfsmwwcwwirdwok only until approved.

begin;

alter table public.promotion_codes
  add column if not exists description text not null default '',
  add column if not exists new_customer_only boolean not null default false,
  add column if not exists created_by_user_id text references public.users(id) on delete set null,
  add column if not exists updated_by_user_id text references public.users(id) on delete set null;

create index if not exists idx_promotion_redemptions_code_tenant
on public.promotion_redemptions (promotion_code_id, tenant_id, redeemed_at desc);

create or replace function public.growup_require_single_platform_super_admin(p_user_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id text := trim(coalesce(p_user_id, ''));
  v_count integer;
begin
  select count(*) into v_count
  from public.platform_admin_memberships pam
  join public.users u on u.id = pam.user_id
  where pam.active = true
    and pam.role = 'super_admin'
    and u.is_active = true;

  if v_count <> 1 or not exists (
    select 1
    from public.platform_admin_memberships pam
    join public.users u on u.id = pam.user_id
    where pam.user_id = v_user_id
      and pam.active = true
      and pam.role = 'super_admin'
      and u.is_active = true
  ) then
    raise exception 'PLATFORM_ADMIN_SUPER_ADMIN_REQUIRED';
  end if;
  return 'super_admin';
end;
$$;

create or replace function public.growup_platform_admin_promo_list(
  p_user_id text,
  p_limit integer default 200,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.growup_require_single_platform_super_admin(p_user_id);
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  return jsonb_build_object(
    'role', v_role,
    'kpis', jsonb_build_object(
      'active', (
        select count(*)
        from public.promotion_codes pc
        where pc.active = true
          and (pc.starts_at is null or pc.starts_at <= now())
          and (pc.ends_at is null or pc.ends_at >= now())
          and (pc.max_redemptions is null or (
            select count(*) from public.promotion_redemptions pr where pr.promotion_code_id = pc.id
          ) < pc.max_redemptions)
      ),
      'used', (select count(*) from public.promotion_redemptions),
      'total', (select count(*) from public.promotion_codes)
    ),
    'items', coalesce((
      with redemption_counts as (
        select pr.promotion_code_id, count(*)::integer as redemptions
        from public.promotion_redemptions pr
        group by pr.promotion_code_id
      )
      select jsonb_agg(to_jsonb(x) order by x.updated_at desc)
      from (
        select
          pc.id,
          public.growup_normalize_promotion_code(pc.code) as code,
          pc.description,
          pc.active,
          pc.benefit_type,
          pc.benefit_value,
          pc.applicable_plans,
          pc.applicable_billing,
          pc.starts_at,
          pc.ends_at,
          pc.max_redemptions,
          pc.max_redemptions_per_tenant,
          pc.new_customer_only,
          pc.created_by_user_id,
          pc.updated_by_user_id,
          pc.created_at,
          pc.updated_at,
          coalesce(rc.redemptions, 0) as redemptions,
          case
            when not pc.active then 'disabled'
            when pc.starts_at is not null and pc.starts_at > now() then 'scheduled'
            when pc.ends_at is not null and pc.ends_at < now() then 'expired'
            when pc.max_redemptions is not null and coalesce(rc.redemptions, 0) >= pc.max_redemptions then 'exhausted'
            else 'active'
          end as status
        from public.promotion_codes pc
        left join redemption_counts rc on rc.promotion_code_id = pc.id
        order by pc.updated_at desc
        limit v_limit offset v_offset
      ) x
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.growup_platform_admin_promo_audit(
  p_user_id text,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.growup_require_single_platform_super_admin(p_user_id);
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  return jsonb_build_object(
    'role', v_role,
    'items', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at desc)
      from (
        select
          pal.id,
          pal.actor_user_id,
          u.username as actor_username,
          u.name as actor_name,
          pal.action,
          pal.target_type,
          pal.target_id,
          pal.details,
          coalesce(pc.code, pal.details->>'code', '') as code,
          pal.created_at
        from public.platform_admin_audit_log pal
        left join public.users u on u.id = pal.actor_user_id
        left join public.promotion_codes pc on pc.id::text = pal.target_id
        where pal.target_type = 'promotion_code'
          and pal.action in (
            'promotion_code.create',
            'promotion_code.update',
            'promotion_code.disable',
            'promotion_code.reenable',
            'promotion_code.redeem'
          )
        order by pal.created_at desc
        limit v_limit offset v_offset
      ) x
    ), '[]'::jsonb)
  );
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
    or v_benefit_type not in ('percent_discount', 'fixed_amount_discount', 'extra_trial_days', 'free_months')
    or v_benefit_value is null
    or v_benefit_value <= 0
    or (v_benefit_type = 'percent_discount' and v_benefit_value > 100)
    or (v_benefit_type in ('extra_trial_days', 'free_months') and v_benefit_value <> trunc(v_benefit_value))
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

create or replace function public.growup_platform_admin_set_promotion_status(
  p_user_id text,
  p_promotion_id uuid,
  p_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.growup_require_single_platform_super_admin(p_user_id);
  v_old public.promotion_codes%rowtype;
  v_row public.promotion_codes%rowtype;
  v_action text;
begin
  if p_promotion_id is null or p_active is null then raise exception 'INVALID_PROMOTION_CODE'; end if;
  select * into v_old from public.promotion_codes where id = p_promotion_id for update;
  if not found then raise exception 'PROMOTION_CODE_NOT_FOUND'; end if;
  if v_old.active = p_active then
    return jsonb_build_object('role', v_role, 'promotion', to_jsonb(v_old));
  end if;
  update public.promotion_codes
  set active = p_active,
      updated_by_user_id = trim(p_user_id)
  where id = p_promotion_id
  returning * into v_row;
  v_action := case when p_active then 'promotion_code.reenable' else 'promotion_code.disable' end;
  insert into public.platform_admin_audit_log (actor_user_id, action, target_type, target_id, details)
  values (trim(p_user_id), v_action, 'promotion_code', v_row.id::text, jsonb_build_object('code', v_row.code, 'changed_fields', jsonb_build_array('active')));
  return jsonb_build_object('role', v_role, 'promotion', to_jsonb(v_row));
end;
$$;

create or replace function public.growup_validate_promotion_code(
  p_code text,
  p_selected_plan text,
  p_selected_billing text,
  p_tenant_id uuid default null
)
returns table (
  valid boolean,
  code text,
  selected_plan text,
  selected_billing text,
  benefit_type text,
  benefit_value numeric,
  benefit_description text,
  reason text
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_code text := public.growup_normalize_promotion_code(p_code);
  v_selected_plan text := lower(trim(coalesce(p_selected_plan, '')));
  v_selected_billing text := lower(trim(coalesce(p_selected_billing, '')));
  v_promotion public.promotion_codes%rowtype;
  v_total_redemptions integer := 0;
  v_tenant_redemptions integer := 0;
begin
  if length(v_code) < 2
    or v_selected_plan not in ('starter', 'business', 'enterprise')
    or v_selected_billing not in ('monthly', 'yearly') then
    return query select false, v_code, v_selected_plan, v_selected_billing, null::text, null::numeric, null::text, 'PROMOTION_CODE_INVALID';
    return;
  end if;

  select * into v_promotion
  from public.promotion_codes pc
  where public.growup_normalize_promotion_code(pc.code) = v_code
  limit 1;

  if not found or not v_promotion.active then
    return query select false, v_code, v_selected_plan, v_selected_billing, null::text, null::numeric, null::text, 'PROMOTION_CODE_INVALID';
    return;
  end if;
  if (v_promotion.starts_at is not null and v_promotion.starts_at > now())
    or (v_promotion.ends_at is not null and v_promotion.ends_at < now()) then
    return query select false, v_code, v_selected_plan, v_selected_billing, null::text, null::numeric, null::text, 'PROMOTION_CODE_EXPIRED';
    return;
  end if;
  if not v_selected_plan = any(v_promotion.applicable_plans)
    or not v_selected_billing = any(v_promotion.applicable_billing) then
    return query select false, v_code, v_selected_plan, v_selected_billing, null::text, null::numeric, null::text, 'PROMOTION_CODE_INVALID';
    return;
  end if;
  if v_promotion.new_customer_only and p_tenant_id is not null then
    return query select false, v_code, v_selected_plan, v_selected_billing, null::text, null::numeric, null::text, 'PROMOTION_CODE_NEW_CUSTOMERS_ONLY';
    return;
  end if;
  if v_promotion.max_redemptions is not null then
    select count(*) into v_total_redemptions from public.promotion_redemptions pr where pr.promotion_code_id = v_promotion.id;
    if v_total_redemptions >= v_promotion.max_redemptions then
      return query select false, v_code, v_selected_plan, v_selected_billing, null::text, null::numeric, null::text, 'PROMOTION_CODE_EXHAUSTED';
      return;
    end if;
  end if;
  if p_tenant_id is not null and v_promotion.max_redemptions_per_tenant is not null then
    select count(*) into v_tenant_redemptions
    from public.promotion_redemptions pr
    where pr.promotion_code_id = v_promotion.id and pr.tenant_id = p_tenant_id;
    if v_tenant_redemptions >= v_promotion.max_redemptions_per_tenant then
      return query select false, v_code, v_selected_plan, v_selected_billing, null::text, null::numeric, null::text, 'PROMOTION_CODE_EXHAUSTED';
      return;
    end if;
  end if;
  return query select true, public.growup_normalize_promotion_code(v_promotion.code), v_selected_plan, v_selected_billing,
    v_promotion.benefit_type, v_promotion.benefit_value,
    public.growup_promotion_benefit_description(v_promotion.benefit_type, v_promotion.benefit_value), null::text;
end;
$$;

create or replace function public.growup_audit_promotion_redemption()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
begin
  select public.growup_normalize_promotion_code(pc.code) into v_code
  from public.promotion_codes pc where pc.id = new.promotion_code_id;
  insert into public.platform_admin_audit_log (actor_user_id, action, target_type, target_id, details)
  values (
    null,
    'promotion_code.redeem',
    'promotion_code',
    new.promotion_code_id::text,
    jsonb_build_object(
      'code', coalesce(v_code, ''),
      'redemption_id', new.id,
      'tenant_id', new.tenant_id,
      'selected_plan', new.selected_plan,
      'selected_billing', new.selected_billing
    )
  );
  return new;
end;
$$;

drop trigger if exists promotion_redemptions_platform_admin_audit on public.promotion_redemptions;
create trigger promotion_redemptions_platform_admin_audit
after insert on public.promotion_redemptions
for each row execute function public.growup_audit_promotion_redemption();

revoke execute on function public.growup_require_single_platform_super_admin(text) from public, anon, authenticated;
revoke execute on function public.growup_platform_admin_promo_list(text, integer, integer) from public, anon, authenticated;
revoke execute on function public.growup_platform_admin_promo_audit(text, integer, integer) from public, anon, authenticated;
revoke execute on function public.growup_platform_admin_save_promotion_code(text, jsonb) from public, anon, authenticated;
revoke execute on function public.growup_platform_admin_set_promotion_status(text, uuid, boolean) from public, anon, authenticated;
revoke execute on function public.growup_audit_promotion_redemption() from public, anon, authenticated;
revoke execute on function public.growup_validate_promotion_code(text, text, text, uuid) from public, anon, authenticated;

grant execute on function public.growup_require_single_platform_super_admin(text) to service_role;
grant execute on function public.growup_platform_admin_promo_list(text, integer, integer) to service_role;
grant execute on function public.growup_platform_admin_promo_audit(text, integer, integer) to service_role;
grant execute on function public.growup_platform_admin_save_promotion_code(text, jsonb) to service_role;
grant execute on function public.growup_platform_admin_set_promotion_status(text, uuid, boolean) to service_role;
grant execute on function public.growup_audit_promotion_redemption() to service_role;
grant execute on function public.growup_validate_promotion_code(text, text, text, uuid) to service_role;

comment on function public.growup_platform_admin_save_promotion_code(text, jsonb)
is 'Preview-authorized Platform Admin Promo create/update with server validation and append-only audit.';

commit;

-- Preview rollback plan (manual, only if required):
-- 1) disable PLATFORM_ADMIN_PROMO_WRITES_ENABLED;
-- 2) drop the five growup_platform_admin_promo_* / status/helper RPCs and redemption audit trigger/function;
-- 3) leave additive promotion metadata columns in place to preserve history, or drop them only after exporting Preview audit data.
