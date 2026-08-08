-- Growup Pilot Production tenant NOT NULL guard.
-- Manual Supabase SQL Editor workflow:
--   1. Run PRECHECK first.
--   2. Run APPLY only when every PRECHECK row reports zero violations.
--   3. Run VERIFY after APPLY.
--   4. Keep ROLLBACK for emergency reversal of only these NOT NULL guards.
--
-- This migration intentionally performs no data rewrite and creates no tenant fallback behavior.

-- ============================================================
-- A. PRECHECK
-- Read-only. Safe to run before APPLY.
-- Continue only if every violation column is 0 and every status is OK.
-- ============================================================

with ownership as (
  select 'customers' as table_name, count(*) as total_rows,
    count(*) filter (where r.tenant_id is null) as null_tenant_id,
    count(*) filter (where r.tenant_id is not null and t.id is null) as orphan_tenant_id
  from public.customers r left join public.tenants t on t.id = r.tenant_id
  union all
  select 'orders', count(*),
    count(*) filter (where r.tenant_id is null),
    count(*) filter (where r.tenant_id is not null and t.id is null)
  from public.orders r left join public.tenants t on t.id = r.tenant_id
  union all
  select 'line_messages', count(*),
    count(*) filter (where r.tenant_id is null),
    count(*) filter (where r.tenant_id is not null and t.id is null)
  from public.line_messages r left join public.tenants t on t.id = r.tenant_id
  union all
  select 'follow_up_rules', count(*),
    count(*) filter (where r.tenant_id is null),
    count(*) filter (where r.tenant_id is not null and t.id is null)
  from public.follow_up_rules r left join public.tenants t on t.id = r.tenant_id
  union all
  select 'settings', count(*),
    count(*) filter (where r.tenant_id is null),
    count(*) filter (where r.tenant_id is not null and t.id is null)
  from public.settings r left join public.tenants t on t.id = r.tenant_id
  union all
  select 'tags', count(*),
    count(*) filter (where r.tenant_id is null),
    count(*) filter (where r.tenant_id is not null and t.id is null)
  from public.tags r left join public.tenants t on t.id = r.tenant_id
  union all
  select 'customer_tags', count(*),
    count(*) filter (where r.tenant_id is null),
    count(*) filter (where r.tenant_id is not null and t.id is null)
  from public.customer_tags r left join public.tenants t on t.id = r.tenant_id
  union all
  select 'contact_logs', count(*),
    count(*) filter (where r.tenant_id is null),
    count(*) filter (where r.tenant_id is not null and t.id is null)
  from public.contact_logs r left join public.tenants t on t.id = r.tenant_id
  union all
  select 'notification_reads', count(*),
    count(*) filter (where r.tenant_id is null),
    count(*) filter (where r.tenant_id is not null and t.id is null)
  from public.notification_reads r left join public.tenants t on t.id = r.tenant_id
  union all
  select 'tenant_role_permissions', count(*),
    count(*) filter (where r.tenant_id is null),
    count(*) filter (where r.tenant_id is not null and t.id is null)
  from public.tenant_role_permissions r left join public.tenants t on t.id = r.tenant_id
  union all
  select 'tenant_settings', count(*),
    count(*) filter (where r.tenant_id is null),
    count(*) filter (where r.tenant_id is not null and t.id is null)
  from public.tenant_settings r left join public.tenants t on t.id = r.tenant_id
  union all
  select 'tenant_memberships', count(*),
    count(*) filter (where r.tenant_id is null),
    count(*) filter (where r.tenant_id is not null and t.id is null)
  from public.tenant_memberships r left join public.tenants t on t.id = r.tenant_id
)
select
  'tenant_ownership' as check_group,
  table_name,
  total_rows,
  null_tenant_id,
  orphan_tenant_id,
  case when null_tenant_id = 0 and orphan_tenant_id = 0 then 'OK' else 'BLOCK' end as status
from ownership
order by table_name;

with relationship_checks as (
  select 'orders_missing_customer' as check_name, count(*) as violations
  from public.orders o
  left join public.customers c on c.id = o.customer_id
  where c.id is null
  union all
  select 'orders_cross_tenant_customer', count(*)
  from public.orders o
  join public.customers c on c.id = o.customer_id
  where o.tenant_id is distinct from c.tenant_id
  union all
  select 'customer_tags_missing_customer', count(*)
  from public.customer_tags ct
  left join public.customers c on c.id = ct.customer_id
  where c.id is null
  union all
  select 'customer_tags_cross_tenant_customer', count(*)
  from public.customer_tags ct
  join public.customers c on c.id = ct.customer_id
  where ct.tenant_id is distinct from c.tenant_id
  union all
  select 'contact_logs_missing_customer', count(*)
  from public.contact_logs cl
  left join public.customers c on c.id = cl.customer_id
  where c.id is null
  union all
  select 'contact_logs_cross_tenant_customer', count(*)
  from public.contact_logs cl
  join public.customers c on c.id = cl.customer_id
  where cl.tenant_id is distinct from c.tenant_id
  union all
  select 'notification_reads_missing_user', count(*)
  from public.notification_reads nr
  left join public.users u on u.id = nr.user_id
  where u.id is null
  union all
  select 'notification_reads_cross_tenant_order', count(*)
  from public.notification_reads nr
  join public.orders o on o.id = substring(nr.notification_id from 'o_[A-Za-z0-9]+')
  where nr.tenant_id is distinct from o.tenant_id
  union all
  select 'tenant_memberships_missing_user', count(*)
  from public.tenant_memberships tm
  left join public.users u on u.id = tm.user_id
  where u.id is null
)
select
  'tenant_relationships' as check_group,
  check_name,
  violations,
  case when violations = 0 then 'OK' else 'BLOCK' end as status
from relationship_checks
order by check_name;

-- ============================================================
-- B. APPLY
-- Fail closed if any prerequisite is not clean. No business data updates.
-- ============================================================

begin;

do $$
declare
  tenant_table text;
  violation_count bigint;
  tenant_tables text[] := array[
    'customers',
    'orders',
    'line_messages',
    'follow_up_rules',
    'settings',
    'tags',
    'customer_tags',
    'contact_logs',
    'notification_reads',
    'tenant_role_permissions',
    'tenant_settings',
    'tenant_memberships'
  ];
begin
  foreach tenant_table in array tenant_tables loop
    execute format('select count(*) from public.%I where tenant_id is null', tenant_table)
      into violation_count;
    if violation_count <> 0 then
      raise exception 'BLOCKED: %.tenant_id has % NULL rows', tenant_table, violation_count;
    end if;

    execute format(
      'select count(*) from public.%I r left join public.tenants t on t.id = r.tenant_id where r.tenant_id is not null and t.id is null',
      tenant_table
    ) into violation_count;
    if violation_count <> 0 then
      raise exception 'BLOCKED: %.tenant_id has % orphan tenant references', tenant_table, violation_count;
    end if;
  end loop;

  select count(*) into violation_count
  from public.orders o
  left join public.customers c on c.id = o.customer_id
  where c.id is null or o.tenant_id is distinct from c.tenant_id;
  if violation_count <> 0 then
    raise exception 'BLOCKED: orders/customer tenant relationship violations = %', violation_count;
  end if;

  select count(*) into violation_count
  from public.customer_tags ct
  left join public.customers c on c.id = ct.customer_id
  where c.id is null or ct.tenant_id is distinct from c.tenant_id;
  if violation_count <> 0 then
    raise exception 'BLOCKED: customer_tags/customer tenant relationship violations = %', violation_count;
  end if;

  select count(*) into violation_count
  from public.contact_logs cl
  left join public.customers c on c.id = cl.customer_id
  where c.id is null or cl.tenant_id is distinct from c.tenant_id;
  if violation_count <> 0 then
    raise exception 'BLOCKED: contact_logs/customer tenant relationship violations = %', violation_count;
  end if;

  select count(*) into violation_count
  from public.notification_reads nr
  left join public.users u on u.id = nr.user_id
  where u.id is null;
  if violation_count <> 0 then
    raise exception 'BLOCKED: notification_reads missing user violations = %', violation_count;
  end if;

  select count(*) into violation_count
  from public.notification_reads nr
  join public.orders o on o.id = substring(nr.notification_id from 'o_[A-Za-z0-9]+')
  where nr.tenant_id is distinct from o.tenant_id;
  if violation_count <> 0 then
    raise exception 'BLOCKED: notification_reads/order tenant relationship violations = %', violation_count;
  end if;

  select count(*) into violation_count
  from public.tenant_memberships tm
  left join public.users u on u.id = tm.user_id
  where u.id is null;
  if violation_count <> 0 then
    raise exception 'BLOCKED: tenant_memberships missing user violations = %', violation_count;
  end if;
end $$;

alter table public.customers alter column tenant_id set not null;
alter table public.orders alter column tenant_id set not null;
alter table public.line_messages alter column tenant_id set not null;
alter table public.follow_up_rules alter column tenant_id set not null;
alter table public.settings alter column tenant_id set not null;
alter table public.tags alter column tenant_id set not null;
alter table public.customer_tags alter column tenant_id set not null;
alter table public.contact_logs alter column tenant_id set not null;
alter table public.notification_reads alter column tenant_id set not null;
alter table public.tenant_role_permissions alter column tenant_id set not null;
alter table public.tenant_settings alter column tenant_id set not null;
alter table public.tenant_memberships alter column tenant_id set not null;

commit;

-- ============================================================
-- C. VERIFY / ROLLBACK
-- VERIFY is read-only except for the optional rejected NULL probe, which
-- catches the expected NOT NULL violation and persists no row.
-- ============================================================

-- C1. VERIFY: run after APPLY.

select
  table_name,
  column_name,
  is_nullable,
  case when is_nullable = 'NO' then 'OK' else 'BLOCK' end as status
from information_schema.columns
where table_schema = 'public'
  and column_name = 'tenant_id'
  and table_name in (
    'customers',
    'orders',
    'line_messages',
    'follow_up_rules',
    'settings',
    'tags',
    'customer_tags',
    'contact_logs',
    'notification_reads',
    'tenant_role_permissions',
    'tenant_settings',
    'tenant_memberships'
  )
order by table_name;

do $$
declare
  probe_id text := 'not_null_probe_' || replace(gen_random_uuid()::text, '-', '');
  probe_phone text := '000' || substring(replace(gen_random_uuid()::text, '-', '') from 1 for 12);
begin
  begin
    insert into public.customers (id, name, phone)
    values (probe_id, 'NOT NULL Probe', probe_phone);
    raise exception 'BLOCKED: customers.tenant_id accepted a NULL insert';
  exception
    when not_null_violation then
      raise notice 'OK: customers.tenant_id rejects NULL inserts';
  end;
end $$;

-- C2. ROLLBACK: do not run during normal verification.
-- Run only if you must reverse the NOT NULL guards introduced by APPLY.
-- This does not remove tenant_id columns and does not change any tenant ownership data.
alter table public.customers alter column tenant_id drop not null;
alter table public.orders alter column tenant_id drop not null;
alter table public.line_messages alter column tenant_id drop not null;
alter table public.follow_up_rules alter column tenant_id drop not null;
alter table public.settings alter column tenant_id drop not null;
alter table public.tags alter column tenant_id drop not null;
alter table public.customer_tags alter column tenant_id drop not null;
alter table public.contact_logs alter column tenant_id drop not null;
alter table public.notification_reads alter column tenant_id drop not null;
alter table public.tenant_role_permissions alter column tenant_id drop not null;
alter table public.tenant_settings alter column tenant_id drop not null;
alter table public.tenant_memberships alter column tenant_id drop not null;
