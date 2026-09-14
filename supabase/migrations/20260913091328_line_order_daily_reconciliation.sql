-- Additive, server-only audit ledger for daily LINE/order reconciliation.
-- No existing business rows are updated or deleted by this migration.

create index if not exists line_messages_reconciliation_created_tenant_idx
  on public.line_messages (created_at, tenant_id);

create table if not exists public.line_order_reconciliation_jobs (
  id uuid primary key,
  business_date date not null,
  trigger text not null check (trigger in ('scheduled', 'manual', 'backfill', 'preview_e2e')),
  mode text not null check (mode in ('dry_run', 'apply')),
  status text not null check (status in ('running', 'passed', 'attention_required', 'failed')),
  started_at timestamptz not null,
  completed_at timestamptz,
  tenant_run_count integer not null default 0 check (tenant_run_count >= 0),
  real_success_ack_count integer not null default 0 check (real_success_ack_count >= 0),
  exact_match_count integer not null default 0 check (exact_match_count >= 0),
  initial_missing_count integer not null default 0 check (initial_missing_count >= 0),
  recovered_count integer not null default 0 check (recovered_count >= 0),
  duplicate_count integer not null default 0 check (duplicate_count >= 0),
  wrong_tenant_count integer not null default 0 check (wrong_tenant_count >= 0),
  intentional_delete_count integer not null default 0 check (intentional_delete_count >= 0),
  unresolved_count integer not null default 0 check (unresolved_count >= 0),
  duplicate_retry_count integer not null default 0 check (duplicate_retry_count >= 0),
  error_category text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists line_order_reconciliation_jobs_date_idx
  on public.line_order_reconciliation_jobs (business_date desc, started_at desc);

create index if not exists line_order_reconciliation_jobs_status_idx
  on public.line_order_reconciliation_jobs (status, started_at desc);

create table if not exists public.line_order_reconciliation_runs (
  id uuid primary key,
  job_id uuid not null references public.line_order_reconciliation_jobs(id) on delete restrict,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  business_date date not null,
  trigger text not null check (trigger in ('scheduled', 'manual', 'backfill', 'preview_e2e')),
  mode text not null check (mode in ('dry_run', 'apply')),
  status text not null check (status in ('running', 'passed', 'attention_required', 'failed')),
  started_at timestamptz not null,
  completed_at timestamptz,
  real_success_ack_count integer not null default 0 check (real_success_ack_count >= 0),
  exact_match_count integer not null default 0 check (exact_match_count >= 0),
  initial_missing_count integer not null default 0 check (initial_missing_count >= 0),
  recovered_count integer not null default 0 check (recovered_count >= 0),
  duplicate_count integer not null default 0 check (duplicate_count >= 0),
  wrong_tenant_count integer not null default 0 check (wrong_tenant_count >= 0),
  intentional_delete_count integer not null default 0 check (intentional_delete_count >= 0),
  unresolved_count integer not null default 0 check (unresolved_count >= 0),
  duplicate_retry_count integer not null default 0 check (duplicate_retry_count >= 0),
  error_category text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists line_order_reconciliation_runs_tenant_date_idx
  on public.line_order_reconciliation_runs (tenant_id, business_date desc, started_at desc);

create index if not exists line_order_reconciliation_runs_job_idx
  on public.line_order_reconciliation_runs (job_id, tenant_id);

create index if not exists line_order_reconciliation_runs_status_idx
  on public.line_order_reconciliation_runs (status, started_at desc);

create table if not exists public.line_order_reconciliation_items (
  id uuid primary key,
  run_id uuid not null references public.line_order_reconciliation_runs(id) on delete restrict,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  business_date date not null,
  line_event_id text not null,
  line_message_id_hash text not null,
  internal_order_id_hash text not null default '',
  order_number text not null default '',
  source_fingerprint text not null default '',
  classification text not null check (classification in (
    'PRESENT_EXACT',
    'RECOVERED',
    'INTENTIONAL_AUDITED_DELETE',
    'MISSING_UNRESOLVED',
    'DUPLICATE',
    'WRONG_TENANT',
    'SYNTHETIC_TEST'
  )),
  reason text not null default '',
  matched_order_id_hash text not null default '',
  recovery_audit_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (run_id, line_event_id)
);

create index if not exists line_order_reconciliation_items_tenant_date_idx
  on public.line_order_reconciliation_items (tenant_id, business_date desc, classification);

create index if not exists line_order_reconciliation_items_run_idx
  on public.line_order_reconciliation_items (run_id, classification);

alter table public.line_order_reconciliation_jobs enable row level security;
alter table public.line_order_reconciliation_runs enable row level security;
alter table public.line_order_reconciliation_items enable row level security;

revoke all on table public.line_order_reconciliation_jobs from public, anon, authenticated;
revoke all on table public.line_order_reconciliation_runs from public, anon, authenticated;
revoke all on table public.line_order_reconciliation_items from public, anon, authenticated;
grant select, insert, update on table public.line_order_reconciliation_jobs to service_role;
grant select, insert, update on table public.line_order_reconciliation_runs to service_role;
grant select, insert on table public.line_order_reconciliation_items to service_role;

comment on table public.line_order_reconciliation_jobs is
  'Server-only non-PII ledger proving each scheduled or manually requested reconciliation invocation, including zero-activity days.';
comment on table public.line_order_reconciliation_runs is
  'Server-only non-PII summary ledger for daily LINE success-ACK reconciliation runs.';
comment on table public.line_order_reconciliation_items is
  'Server-only item classifications using safe identifiers and hashes; no customer phone or address is stored.';
