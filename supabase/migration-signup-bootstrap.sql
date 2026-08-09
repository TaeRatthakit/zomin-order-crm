-- Growup Pilot public signup bootstrap.
-- Tenant-scoped only. Does not rewrite, migrate, or change existing tenant ownership data.

create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'settings_tenant_id_key_key' and conrelid = 'public.settings'::regclass) then
    alter table public.settings add constraint settings_tenant_id_key_key unique (tenant_id, key);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'follow_up_rules_tenant_id_jars_key' and conrelid = 'public.follow_up_rules'::regclass) then
    alter table public.follow_up_rules add constraint follow_up_rules_tenant_id_jars_key unique (tenant_id, jars);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'customer_tags_tenant_id_customer_id_tag_name_key' and conrelid = 'public.customer_tags'::regclass) then
    alter table public.customer_tags add constraint customer_tags_tenant_id_customer_id_tag_name_key unique (tenant_id, customer_id, tag_name);
  end if;
  if exists (select 1 from pg_constraint where conname = 'settings_key_key' and conrelid = 'public.settings'::regclass) then
    alter table public.settings drop constraint settings_key_key;
  end if;
  if exists (select 1 from pg_constraint where conname = 'follow_up_rules_jars_key' and conrelid = 'public.follow_up_rules'::regclass) then
    alter table public.follow_up_rules drop constraint follow_up_rules_jars_key;
  end if;
end $$;

create table if not exists public.signup_bootstraps (
  idempotency_key text primary key,
  username text not null,
  user_id text not null unique references public.users(id) on delete restrict,
  tenant_id uuid not null unique references public.tenants(id) on delete restrict,
  status text not null default 'completed' check (status in ('completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (length(trim(idempotency_key)) > 0),
  check (length(trim(username)) > 0)
);

drop trigger if exists signup_bootstraps_updated_at on public.signup_bootstraps;
create trigger signup_bootstraps_updated_at before update on public.signup_bootstraps
for each row execute function public.set_updated_at();

alter table public.signup_bootstraps enable row level security;

create or replace function public.growup_signup_bootstrap(
  p_idempotency_key text,
  p_user_id text,
  p_username text,
  p_password_hash text,
  p_name text,
  p_business_name text,
  p_defaults jsonb default '{}'::jsonb
)
returns table (
  user_id text,
  username text,
  name text,
  role text,
  phone text,
  is_active boolean,
  tenant_id uuid,
  tenant_name text,
  tenant_role text
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_idempotency_key text := trim(coalesce(p_idempotency_key, ''));
  v_user_id text := trim(coalesce(p_user_id, ''));
  v_username text := lower(trim(coalesce(p_username, '')));
  v_name text := trim(coalesce(p_name, ''));
  v_business_name text := trim(coalesce(p_business_name, ''));
  v_password_hash text := trim(coalesce(p_password_hash, ''));
  v_tenant_id uuid;
  v_setting record;
  v_rule record;
begin
  if length(v_idempotency_key) < 8
    or length(v_idempotency_key) > 120
    or length(v_user_id) < 3
    or length(v_user_id) > 120
    or length(v_username) < 3
    or length(v_username) > 120
    or length(v_password_hash) < 20
    or length(v_business_name) < 2
    or length(v_business_name) > 120 then
    raise exception 'INVALID_SIGNUP_INPUT';
  end if;

  if exists (select 1 from public.signup_bootstraps sb where sb.idempotency_key = v_idempotency_key) then
    if not exists (
      select 1
      from public.signup_bootstraps sb
      where sb.idempotency_key = v_idempotency_key
        and sb.username = v_username
    ) then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return query
      select u.id, u.username, u.name, u.role, u.phone, u.is_active, t.id, t.name, tm.role
      from public.signup_bootstraps sb
      join public.users u on u.id = sb.user_id
      join public.tenants t on t.id = sb.tenant_id
      join public.tenant_memberships tm on tm.tenant_id = t.id and tm.user_id = u.id and tm.is_active = true
      where sb.idempotency_key = v_idempotency_key
        and t.status = 'active'
      limit 1;
    return;
  end if;

  if exists (select 1 from public.users u where lower(u.username) = v_username) then
    raise exception 'ACCOUNT_EXISTS';
  end if;

  if v_name = '' then
    v_name := v_business_name;
  end if;

  insert into public.users (id, username, password_hash, name, role, phone, is_active)
  values (v_user_id, v_username, v_password_hash, v_name, 'Owner', '', true);

  insert into public.tenants (name, status, metadata)
  values (v_business_name, 'active', jsonb_build_object('source', 'public_signup'))
  returning id into v_tenant_id;

  insert into public.tenant_memberships (tenant_id, user_id, role, is_active)
  values (v_tenant_id, v_user_id, 'Owner', true);

  insert into public.tenant_role_permissions (tenant_id, role, permissions)
  values
    (v_tenant_id, 'Owner', '{}'::jsonb),
    (v_tenant_id, 'Admin', '{}'::jsonb),
    (v_tenant_id, 'Staff', '{}'::jsonb)
  on conflict (tenant_id, role) do nothing;

  for v_setting in
    select key, value
    from jsonb_each(coalesce(p_defaults->'settings', '{}'::jsonb))
  loop
    insert into public.settings (id, key, value, tenant_id)
    values (v_tenant_id::text || ':' || v_setting.key, v_setting.key, v_setting.value, v_tenant_id)
    on conflict (tenant_id, key) do update
      set value = excluded.value;
  end loop;

  for v_rule in
    select jars, days
    from jsonb_to_recordset(coalesce(p_defaults->'followUpRules', '[]'::jsonb)) as x(jars integer, days integer)
    where jars is not null and days is not null
  loop
    insert into public.follow_up_rules (id, jars, days, tenant_id)
    values (v_tenant_id::text || ':' || v_rule.jars::text, v_rule.jars, v_rule.days, v_tenant_id)
    on conflict (tenant_id, jars) do update
      set days = excluded.days;
  end loop;

  insert into public.signup_bootstraps (idempotency_key, username, user_id, tenant_id, status)
  values (v_idempotency_key, v_username, v_user_id, v_tenant_id, 'completed');

  return query
    select u.id, u.username, u.name, u.role, u.phone, u.is_active, t.id, t.name, tm.role
    from public.users u
    join public.tenants t on t.id = v_tenant_id
    join public.tenant_memberships tm on tm.tenant_id = t.id and tm.user_id = u.id
    where u.id = v_user_id
    limit 1;
end;
$$;
