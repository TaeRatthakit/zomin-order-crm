-- Additive audit ledger for the one-shot, tenant-scoped historical LINE recovery.
-- It does not rewrite existing business data.
create table if not exists public.line_order_recovery_audit (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  line_event_id text not null,
  line_message_id text not null,
  original_order_id text not null,
  status text not null check (status in ('claimed', 'recovered', 'skipped', 'failed')),
  source_snapshot jsonb not null,
  result jsonb not null default '{}'::jsonb,
  claimed_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, line_event_id)
);

create index if not exists line_order_recovery_audit_tenant_status_idx
  on public.line_order_recovery_audit (tenant_id, status, claimed_at desc);

alter table public.line_order_recovery_audit enable row level security;
revoke all on table public.line_order_recovery_audit from anon, authenticated;
grant all on table public.line_order_recovery_audit to service_role;
