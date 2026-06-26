-- Add production order fields without deleting existing data.

alter table public.orders
  add column if not exists source_channel text default '',
  add column if not exists social_name text default '',
  add column if not exists free_gift text default '',
  add column if not exists vip_card_status text default '';

alter table public.orders
  alter column source set default '';
