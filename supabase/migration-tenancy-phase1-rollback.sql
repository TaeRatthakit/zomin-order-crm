-- Growup Pilot multi-tenant Phase 1 rollback.
-- Reverses only Phase 1 tenant primitives. It does not modify users or existing global data columns.

drop index if exists public.uniq_notification_reads_tenant_user_notification;
drop index if exists public.idx_notification_reads_tenant_user;
drop index if exists public.idx_notification_reads_tenant_id;
drop index if exists public.idx_contact_logs_tenant_customer;
drop index if exists public.idx_contact_logs_tenant_id;
drop index if exists public.uniq_customer_tags_tenant_customer_tag;
drop index if exists public.idx_customer_tags_tenant_customer;
drop index if exists public.idx_customer_tags_tenant_id;
drop index if exists public.uniq_tags_tenant_name;
drop index if exists public.idx_tags_tenant_id;
drop index if exists public.uniq_settings_tenant_key;
drop index if exists public.idx_settings_tenant_id;
drop index if exists public.uniq_follow_up_rules_tenant_jars;
drop index if exists public.idx_follow_up_rules_tenant_id;
drop index if exists public.idx_line_messages_tenant_id;
drop index if exists public.idx_orders_tenant_import_duplicate;
drop index if exists public.idx_orders_tenant_order_number;
drop index if exists public.idx_orders_tenant_order_date;
drop index if exists public.idx_orders_tenant_id;
drop index if exists public.uniq_customers_tenant_phone;
drop index if exists public.idx_customers_tenant_id;
drop index if exists public.idx_tenant_settings_key;
drop index if exists public.idx_tenant_role_permissions_role;
drop index if exists public.idx_tenant_memberships_tenant_role;
drop index if exists public.idx_tenant_memberships_user;
drop index if exists public.idx_tenants_status;

alter table public.notification_reads drop column if exists tenant_id;
alter table public.contact_logs drop column if exists tenant_id;
alter table public.customer_tags drop column if exists tenant_id;
alter table public.tags drop column if exists tenant_id;
alter table public.settings drop column if exists tenant_id;
alter table public.follow_up_rules drop column if exists tenant_id;
alter table public.line_messages drop column if exists tenant_id;
alter table public.orders drop column if exists tenant_id;
alter table public.customers drop column if exists tenant_id;

drop trigger if exists tenant_settings_updated_at on public.tenant_settings;
drop trigger if exists tenant_role_permissions_updated_at on public.tenant_role_permissions;
drop trigger if exists tenant_memberships_updated_at on public.tenant_memberships;
drop trigger if exists tenants_updated_at on public.tenants;

drop table if exists public.tenant_role_permissions;
drop table if exists public.tenant_settings;
drop table if exists public.tenant_memberships;
drop table if exists public.tenants;
