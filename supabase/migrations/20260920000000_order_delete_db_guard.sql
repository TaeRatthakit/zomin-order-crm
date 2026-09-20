-- Defense-in-depth for order integrity.
-- Every physical order delete must have a durable audit row inserted by the
-- same database transaction. Existing rows are not updated or deleted.

create or replace function public.require_same_transaction_order_delete_audit()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1
      from public.order_deletion_audit audit
     where audit.tenant_id = old.tenant_id
       and audit.order_id = old.id
       and audit.action = 'order_delete'
       and audit.xmin::text = txid_current()::text
  ) then
    raise exception 'ORDER_DELETE_AUDIT_REQUIRED';
  end if;
  return old;
end;
$$;

revoke all on function public.require_same_transaction_order_delete_audit()
  from public, anon, authenticated;

do $$
begin
  if not exists (
    select 1
      from pg_trigger
     where tgrelid = 'public.orders'::regclass
       and tgname = 'orders_require_same_transaction_delete_audit'
       and not tgisinternal
  ) then
    create trigger orders_require_same_transaction_delete_audit
      before delete on public.orders
      for each row
      execute function public.require_same_transaction_order_delete_audit();
  end if;
end;
$$;

comment on function public.require_same_transaction_order_delete_audit() is
  'Blocks order deletion unless the same transaction first writes the tenant-scoped order deletion audit row.';
