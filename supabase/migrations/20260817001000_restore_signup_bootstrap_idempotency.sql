-- Restore the signup idempotency ledger required by growup_signup_bootstrap.
-- Some legacy Production schemas reached Phase 7 without this additive table.

create table if not exists public.signup_bootstraps (
  idempotency_key text primary key,
  username text not null,
  user_id text not null references public.users(id) on delete restrict,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  status text not null default 'completed' check (status in ('completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (length(trim(idempotency_key)) between 8 and 120),
  check (length(trim(username)) between 3 and 120)
);

create index if not exists idx_signup_bootstraps_user
on public.signup_bootstraps (user_id);

create index if not exists idx_signup_bootstraps_tenant
on public.signup_bootstraps (tenant_id);

drop trigger if exists signup_bootstraps_updated_at on public.signup_bootstraps;
create trigger signup_bootstraps_updated_at before update on public.signup_bootstraps
for each row execute function public.set_updated_at();

alter table public.signup_bootstraps enable row level security;

comment on table public.signup_bootstraps is 'Server-side public signup idempotency ledger used only by SECURITY DEFINER signup RPCs.';
