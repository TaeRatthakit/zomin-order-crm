-- Keep explicitly marked disposable Preview verification records out of normal
-- Platform Admin Promo review without deleting their audit/redemption evidence.
-- This is intentionally marker-based; real Promo records are not classified by name.

begin;

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
  v_total integer;
  v_items jsonb;
begin
  select count(*)::integer into v_total
  from public.promotion_codes pc
  where pc.description not like '[TEST DISPOSABLE VERIFIED %';

  select coalesce(jsonb_agg(to_jsonb(x) order by x.updated_at desc), '[]'::jsonb)
  into v_items
  from (
    with redemption_counts as (
      select pr.promotion_code_id, count(*)::integer as redemptions
      from public.promotion_redemptions pr
      group by pr.promotion_code_id
    )
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
    where pc.description not like '[TEST DISPOSABLE VERIFIED %'
    order by pc.updated_at desc
    limit v_limit offset v_offset
  ) x;

  return jsonb_build_object(
    'role', v_role,
    'kpis', jsonb_build_object(
      'active', (
        select count(*)::integer
        from public.promotion_codes pc
        left join (
          select pr.promotion_code_id, count(*)::integer as redemptions
          from public.promotion_redemptions pr
          group by pr.promotion_code_id
        ) rc on rc.promotion_code_id = pc.id
        where pc.description not like '[TEST DISPOSABLE VERIFIED %'
          and pc.active = true
          and (pc.starts_at is null or pc.starts_at <= now())
          and (pc.ends_at is null or pc.ends_at >= now())
          and (pc.max_redemptions is null or coalesce(rc.redemptions, 0) < pc.max_redemptions)
      ),
      'used', (
        select count(*)::integer
        from public.promotion_redemptions pr
        join public.promotion_codes pc on pc.id = pr.promotion_code_id
        where pc.description not like '[TEST DISPOSABLE VERIFIED %'
      ),
      'total', v_total
    ),
    'items', v_items,
    'pagination', jsonb_build_object(
      'limit', v_limit,
      'offset', v_offset,
      'total', v_total,
      'has_more', v_offset + jsonb_array_length(v_items) < v_total
    )
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
  v_items jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
  into v_items
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
      and pal.action in ('promotion_code.create', 'promotion_code.update', 'promotion_code.disable', 'promotion_code.reenable', 'promotion_code.redeem')
      and coalesce(pc.description, '') not like '[TEST DISPOSABLE VERIFIED %'
    order by pal.created_at desc
    limit v_limit offset v_offset
  ) x;

  return jsonb_build_object(
    'role', v_role,
    'items', v_items,
    'pagination', jsonb_build_object(
      'limit', v_limit,
      'offset', v_offset,
      'has_more', jsonb_array_length(v_items) = v_limit
    )
  );
end;
$$;

revoke execute on function public.growup_platform_admin_promo_list(text, integer, integer) from public, anon, authenticated;
revoke execute on function public.growup_platform_admin_promo_audit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.growup_platform_admin_promo_list(text, integer, integer) to service_role;
grant execute on function public.growup_platform_admin_promo_audit(text, integer, integer) to service_role;

commit;

-- Rollback: reapply 20260827000000_platform_admin_promo_preview.sql to restore
-- the prior list/audit definitions. No rows are deleted by this migration.
