-- Persistent, per-user read state for the notification drawer.
-- Safe to run more than once in an existing Supabase project.

create table if not exists public.notification_reads (
  user_id text not null references public.users(id) on delete cascade,
  notification_id text not null,
  read_at timestamptz not null default now(),
  primary key (user_id, notification_id)
);

create index if not exists idx_notification_reads_user
  on public.notification_reads (user_id, read_at desc);

alter table public.notification_reads enable row level security;
