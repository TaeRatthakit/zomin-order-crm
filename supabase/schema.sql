-- Zomin Order CRM V3 production schema for Supabase/Postgres.
-- Run this once in Supabase SQL Editor before migrating data.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.users (
  id text primary key,
  username text not null unique,
  password_hash text not null,
  name text not null,
  role text not null check (role in ('Admin', 'Staff')),
  phone text default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.customers (
  id text primary key,
  name text not null,
  phone text not null unique,
  latest_address text default '',
  note text default '',
  assigned_to text references public.users(id) on delete set null,
  first_purchase_date date,
  last_purchase_date date,
  purchase_count integer not null default 0,
  total_quantity integer not null default 0,
  total_amount numeric(12,2) not null default 0,
  status text default 'NORMAL',
  vip_level text default 'NORMAL',
  customer_score numeric(18,2) not null default 0,
  follow_up_date date,
  last_contact_date date,
  last_contact_note text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.orders (
  id text primary key,
  customer_id text not null references public.customers(id) on delete cascade,
  order_number text default '',
  customer_name text default '',
  phone text default '',
  address text default '',
  items text not null default 'Zomin',
  quantity integer not null default 1,
  amount numeric(12,2) not null default 0,
  order_date date not null,
  order_time time,
  source text not null default '',
  source_channel text default '',
  social_name text default '',
  free_gift text default '',
  vip_card_status text default '',
  note text default '',
  raw_text text default '',
  created_by text references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.line_messages (
  id text primary key,
  raw_text text default '',
  raw_event jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.follow_up_rules (
  id text primary key,
  jars integer not null unique,
  days integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.settings (
  id text primary key,
  key text not null unique,
  value jsonb not null default 'null'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tags (
  id text primary key,
  name text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.customer_tags (
  id text primary key,
  customer_id text not null references public.customers(id) on delete cascade,
  tag_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (customer_id, tag_name)
);

create table if not exists public.contact_logs (
  id text primary key,
  customer_id text not null references public.customers(id) on delete cascade,
  contact_date date not null,
  contacted_by text default '',
  result text default '',
  note text default '',
  next_follow_up_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_customers_phone on public.customers(phone);
create index if not exists idx_customers_vip_level on public.customers(vip_level);
create index if not exists idx_customers_follow_up_date on public.customers(follow_up_date);
create index if not exists idx_orders_customer_id on public.orders(customer_id);
create index if not exists idx_orders_order_date on public.orders(order_date);
create index if not exists idx_orders_order_number on public.orders(order_number) where order_number <> '';
create index if not exists idx_orders_import_duplicate on public.orders(order_date, phone, amount);
create index if not exists idx_customer_tags_customer_id on public.customer_tags(customer_id);
create index if not exists idx_contact_logs_customer_id on public.contact_logs(customer_id);

drop trigger if exists users_updated_at on public.users;
create trigger users_updated_at before update on public.users
for each row execute function public.set_updated_at();

drop trigger if exists customers_updated_at on public.customers;
create trigger customers_updated_at before update on public.customers
for each row execute function public.set_updated_at();

drop trigger if exists orders_updated_at on public.orders;
create trigger orders_updated_at before update on public.orders
for each row execute function public.set_updated_at();

drop trigger if exists line_messages_updated_at on public.line_messages;
create trigger line_messages_updated_at before update on public.line_messages
for each row execute function public.set_updated_at();

drop trigger if exists follow_up_rules_updated_at on public.follow_up_rules;
create trigger follow_up_rules_updated_at before update on public.follow_up_rules
for each row execute function public.set_updated_at();

drop trigger if exists settings_updated_at on public.settings;
create trigger settings_updated_at before update on public.settings
for each row execute function public.set_updated_at();

drop trigger if exists tags_updated_at on public.tags;
create trigger tags_updated_at before update on public.tags
for each row execute function public.set_updated_at();

drop trigger if exists customer_tags_updated_at on public.customer_tags;
create trigger customer_tags_updated_at before update on public.customer_tags
for each row execute function public.set_updated_at();

drop trigger if exists contact_logs_updated_at on public.contact_logs;
create trigger contact_logs_updated_at before update on public.contact_logs
for each row execute function public.set_updated_at();

alter table public.users enable row level security;
alter table public.customers enable row level security;
alter table public.orders enable row level security;
alter table public.line_messages enable row level security;
alter table public.follow_up_rules enable row level security;
alter table public.settings enable row level security;
alter table public.tags enable row level security;
alter table public.customer_tags enable row level security;
alter table public.contact_logs enable row level security;
