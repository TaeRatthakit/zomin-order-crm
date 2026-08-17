-- Provide non-partial unique arbiters for signup bootstrap ON CONFLICT clauses.
-- Legacy schemas only had tenant-scoped partial indexes, which cannot arbitrate
-- ON CONFLICT (tenant_id, key/jars) inside growup_signup_bootstrap.

create unique index if not exists uniq_settings_tenant_key_upsert
on public.settings (tenant_id, key);

create unique index if not exists uniq_follow_up_rules_tenant_jars_upsert
on public.follow_up_rules (tenant_id, jars);
