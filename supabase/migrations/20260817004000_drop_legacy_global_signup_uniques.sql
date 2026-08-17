-- Allow tenant-scoped signup defaults to coexist with legacy global rows.
-- Older schemas made settings.key and follow_up_rules.jars globally unique;
-- multi-tenant writes now rely on tenant-scoped unique arbiters instead.

alter table public.settings
  drop constraint if exists settings_key_key;

alter table public.follow_up_rules
  drop constraint if exists follow_up_rules_jars_key;
