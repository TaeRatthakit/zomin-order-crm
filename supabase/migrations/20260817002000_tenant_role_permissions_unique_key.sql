-- Ensure signup bootstrap can safely upsert tenant role permissions on legacy schemas.

create unique index if not exists uniq_tenant_role_permissions_tenant_role
on public.tenant_role_permissions (tenant_id, role);
