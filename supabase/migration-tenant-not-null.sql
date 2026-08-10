-- Defense-in-depth for multi-tenant ownership.
-- Apply only after the fail-closed application write-path fix is deployed and
-- read-only production validation shows zero NULL tenant_id rows.
--
-- Rollback:
--   alter table public.customers alter column tenant_id drop not null;
--   alter table public.orders alter column tenant_id drop not null;
--   alter table public.line_messages alter column tenant_id drop not null;
--   alter table public.follow_up_rules alter column tenant_id drop not null;
--   alter table public.settings alter column tenant_id drop not null;
--   alter table public.tags alter column tenant_id drop not null;
--   alter table public.customer_tags alter column tenant_id drop not null;
--   alter table public.contact_logs alter column tenant_id drop not null;
--   alter table public.notification_reads alter column tenant_id drop not null;
--   alter table public.tenant_role_permissions alter column tenant_id drop not null;
--   alter table public.tenant_settings alter column tenant_id drop not null;

do $$
declare
  table_name text;
  null_count bigint;
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
    'tenant_settings'
  ];
begin
  foreach table_name in array tenant_tables loop
    execute format('select count(*) from public.%I where tenant_id is null', table_name)
      into null_count;
    if null_count > 0 then
      raise exception 'Cannot set %.tenant_id NOT NULL: % NULL rows remain', table_name, null_count;
    end if;
  end loop;
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
