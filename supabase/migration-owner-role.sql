-- Add Owner as the highest user role and promote the main admin account.
-- Safe to run more than once.

alter table public.users
  drop constraint if exists users_role_check;

alter table public.users
  add constraint users_role_check
  check (role in ('Owner', 'Admin', 'Staff'));

update public.users
set role = 'Owner',
    is_active = true
where username = 'admin'
   or id = 'u_admin';
