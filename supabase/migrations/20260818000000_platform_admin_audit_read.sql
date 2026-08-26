-- Read-only Platform Admin audit access.
-- The RPC is callable only by the server service role after the server has
-- authenticated the Platform Admin membership.

create or replace function public.growup_platform_admin_audit_log(
  p_user_id text,
  p_action text default '',
  p_target_type text default '',
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.growup_require_platform_admin(p_user_id);
  v_action text := lower(trim(coalesce(p_action, '')));
  v_target_type text := lower(trim(coalesce(p_target_type, '')));
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total integer;
begin
  select count(*) into v_total
    from public.platform_admin_audit_log l
   where (v_action = '' or lower(l.action) = v_action)
     and (v_target_type = '' or lower(l.target_type) = v_target_type);

  return jsonb_build_object(
    'role', v_role,
    'limit', v_limit,
    'offset', v_offset,
    'total', v_total,
    'items', coalesce((
      select jsonb_agg(page.item order by page.created_at desc)
        from (
          select jsonb_build_object(
            'id', l.id,
            'actor_user_id', l.actor_user_id,
            'action', l.action,
            'target_type', l.target_type,
            'target_id', l.target_id,
            'details', coalesce((
              select jsonb_object_agg(x.key, x.value)
                from jsonb_each(coalesce(l.details, '{}'::jsonb)) x
               where x.key !~* '(secret|token|password|credential|api[_-]?key)'
            ), '{}'::jsonb),
            'created_at', l.created_at
          ) as item,
          l.created_at
            from public.platform_admin_audit_log l
           where (v_action = '' or lower(l.action) = v_action)
             and (v_target_type = '' or lower(l.target_type) = v_target_type)
           order by l.created_at desc
           limit v_limit offset v_offset
        ) page
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.growup_platform_admin_audit_log(text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.growup_platform_admin_audit_log(text, text, text, integer, integer) to service_role;

comment on function public.growup_platform_admin_audit_log(text, text, text, integer, integer) is 'Server-only paginated Platform Admin audit read with sensitive detail-key redaction.';
