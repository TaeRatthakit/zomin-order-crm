# Multi-tenant Phase 1 Backfill Plan

Phase 1 only defines the additive schema and validation primitives. It must not run against Production until a later approved migration phase.

## Planned default tenant

- Generate a new opaque UUID for the default tenant at migration time.
- Derive the tenant name from current business settings when available, preferring `settings.businessName`.
- Use `Growup Pilot` only if business settings do not contain a usable name.
- Create one active tenant row with status `active`.

## Planned memberships

- Keep `users` as the global identity table.
- Keep `users.username` globally unique.
- Do not duplicate users per tenant.
- Create one `tenant_memberships` row per existing user for the default tenant.
- Store the existing Owner/Admin/Staff role on the membership.
- Preserve inactive users as inactive memberships.
- Require manual review if the production data has no active Owner before enforcement.

## Planned tenant-scoped data backfill

- Backfill the generated default tenant id into nullable `tenant_id` columns for current tenant-owned data.
- Tenant-owned tables are `customers`, `orders`, `line_messages`, `follow_up_rules`, `settings`, `tags`, `customer_tags`, `contact_logs`, and `notification_reads`.
- Copy current tenant-owned settings into `tenant_settings`, including permission settings such as `staffCanExport`.
- Seed `tenant_role_permissions` for Owner/Admin/Staff from the approved permission model in a later phase.
- Keep global settings readable until the application is switched to tenant-aware settings in a later approved phase.

## Preflight validation

Before any production data mutation, run validation for:

- duplicate global usernames;
- duplicate keys that would conflict inside the default tenant, including customer phone, tag name, follow-up rule jars, and notification read key;
- orphan records, including orders, customer tags, contact logs, and assigned users;
- active import jobs or singleton import settings;
- incomplete tenant backfills after the data update dry run.

## Rollback strategy

- Phase 1 rollback drops only Phase 1 indexes, nullable `tenant_id` columns, triggers, and tenant tables.
- Because Phase 1 does not backfill or enforce tenant authorization, rollback does not need to transform existing production data.
- Later phases must add separate rollback steps before they enforce tenant-aware reads, writes, or constraints.
