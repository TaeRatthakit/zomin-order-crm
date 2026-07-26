-- Growup Pilot multi-tenant Phase 1.
-- Additive only: creates tenant primitives and nullable tenant_id columns.
-- This migration intentionally does not backfill data and does not enforce NOT NULL.

create extension if not exists pgcrypto;

create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'active' check (status in ('active', 'inactive', 'suspended', 'archived')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tenant_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id text not null references public.users(id) on delete cascade,
  role text not null check (role in ('Owner', 'Admin', 'Staff')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create table if not exists public.tenant_settings (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  key text not null,
  value jsonb not null default 'null'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, key),
  check (length(trim(key)) > 0)
);

create table if not exists public.tenant_role_permissions (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  role text not null check (role in ('Owner', 'Admin', 'Staff')),
  permissions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, role)
);

alter table public.customers add column if not exists tenant_id uuid references public.tenants(id) on delete restrict;
alter table public.orders add column if not exists tenant_id uuid references public.tenants(id) on delete restrict;
alter table public.line_messages add column if not exists tenant_id uuid references public.tenants(id) on delete restrict;
alter table public.follow_up_rules add column if not exists tenant_id uuid references public.tenants(id) on delete restrict;
alter table public.settings add column if not exists tenant_id uuid references public.tenants(id) on delete restrict;
alter table public.tags add column if not exists tenant_id uuid references public.tenants(id) on delete restrict;
alter table public.customer_tags add column if not exists tenant_id uuid references public.tenants(id) on delete restrict;
alter table public.contact_logs add column if not exists tenant_id uuid references public.tenants(id) on delete restrict;
alter table public.notification_reads add column if not exists tenant_id uuid references public.tenants(id) on delete restrict;

create index if not exists idx_tenants_status on public.tenants(status);
create index if not exists idx_tenant_memberships_user on public.tenant_memberships(user_id, is_active);
create index if not exists idx_tenant_memberships_tenant_role on public.tenant_memberships(tenant_id, role) where is_active = true;
create index if not exists idx_tenant_settings_key on public.tenant_settings(key);
create index if not exists idx_tenant_role_permissions_role on public.tenant_role_permissions(role);

create index if not exists idx_customers_tenant_id on public.customers(tenant_id);
create unique index if not exists uniq_customers_tenant_phone on public.customers(tenant_id, phone) where tenant_id is not null and phone <> '';

create index if not exists idx_orders_tenant_id on public.orders(tenant_id);
create index if not exists idx_orders_tenant_order_date on public.orders(tenant_id, order_date);
create index if not exists idx_orders_tenant_order_number on public.orders(tenant_id, order_number) where tenant_id is not null and order_number <> '';
create index if not exists idx_orders_tenant_import_duplicate on public.orders(tenant_id, order_date, phone, amount);

create index if not exists idx_line_messages_tenant_id on public.line_messages(tenant_id);

create index if not exists idx_follow_up_rules_tenant_id on public.follow_up_rules(tenant_id);
create unique index if not exists uniq_follow_up_rules_tenant_jars on public.follow_up_rules(tenant_id, jars) where tenant_id is not null;

create index if not exists idx_settings_tenant_id on public.settings(tenant_id);
create unique index if not exists uniq_settings_tenant_key on public.settings(tenant_id, key) where tenant_id is not null;

create index if not exists idx_tags_tenant_id on public.tags(tenant_id);
create unique index if not exists uniq_tags_tenant_name on public.tags(tenant_id, name) where tenant_id is not null;

create index if not exists idx_customer_tags_tenant_id on public.customer_tags(tenant_id);
create index if not exists idx_customer_tags_tenant_customer on public.customer_tags(tenant_id, customer_id);
create unique index if not exists uniq_customer_tags_tenant_customer_tag on public.customer_tags(tenant_id, customer_id, tag_name) where tenant_id is not null;

create index if not exists idx_contact_logs_tenant_id on public.contact_logs(tenant_id);
create index if not exists idx_contact_logs_tenant_customer on public.contact_logs(tenant_id, customer_id);

create index if not exists idx_notification_reads_tenant_id on public.notification_reads(tenant_id);
create index if not exists idx_notification_reads_tenant_user on public.notification_reads(tenant_id, user_id, read_at desc);
create unique index if not exists uniq_notification_reads_tenant_user_notification on public.notification_reads(tenant_id, user_id, notification_id) where tenant_id is not null;

drop trigger if exists tenants_updated_at on public.tenants;
create trigger tenants_updated_at before update on public.tenants
for each row execute function public.set_updated_at();

drop trigger if exists tenant_memberships_updated_at on public.tenant_memberships;
create trigger tenant_memberships_updated_at before update on public.tenant_memberships
for each row execute function public.set_updated_at();

drop trigger if exists tenant_settings_updated_at on public.tenant_settings;
create trigger tenant_settings_updated_at before update on public.tenant_settings
for each row execute function public.set_updated_at();

drop trigger if exists tenant_role_permissions_updated_at on public.tenant_role_permissions;
create trigger tenant_role_permissions_updated_at before update on public.tenant_role_permissions
for each row execute function public.set_updated_at();

alter table public.tenants enable row level security;
alter table public.tenant_memberships enable row level security;
alter table public.tenant_settings enable row level security;
alter table public.tenant_role_permissions enable row level security;

comment on table public.tenants is 'Phase 1 tenant registry. No production backfill is performed by this migration.';
comment on table public.tenant_memberships is 'Phase 1 user-to-tenant membership. users.username remains globally unique.';
comment on table public.tenant_settings is 'Phase 1 tenant-scoped settings and permission configuration primitives.';
comment on table public.tenant_role_permissions is 'Phase 1 tenant-scoped role permission configuration. No login/session enforcement changes are made in Phase 1.';
comment on column public.customers.tenant_id is 'Nullable during Phase 1. Backfill and NOT NULL enforcement require later approval.';
comment on column public.orders.tenant_id is 'Nullable during Phase 1. Backfill and NOT NULL enforcement require later approval.';
comment on column public.line_messages.tenant_id is 'Nullable during Phase 1. Backfill and NOT NULL enforcement require later approval.';
comment on column public.follow_up_rules.tenant_id is 'Nullable during Phase 1. Backfill and NOT NULL enforcement require later approval.';
comment on column public.settings.tenant_id is 'Nullable during Phase 1. Existing global settings remain unchanged until approved backfill.';
comment on column public.tags.tenant_id is 'Nullable during Phase 1. Backfill and NOT NULL enforcement require later approval.';
comment on column public.customer_tags.tenant_id is 'Nullable during Phase 1. Backfill and NOT NULL enforcement require later approval.';
comment on column public.contact_logs.tenant_id is 'Nullable during Phase 1. Backfill and NOT NULL enforcement require later approval.';
comment on column public.notification_reads.tenant_id is 'Nullable during Phase 1. Backfill and primary-key changes require later approval.';
