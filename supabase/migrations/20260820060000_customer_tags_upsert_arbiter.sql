-- Provide the non-partial arbiter required by the tenant-scoped customer_tags upsert.
-- This migration is additive and intentionally does not rewrite or delete data.

begin;

do $$
begin
  if exists (
    select 1
    from public.customer_tags
    group by tenant_id, customer_id, tag_name
    having count(*) > 1
  ) then
    raise exception 'BLOCKED / CUSTOMER_TAGS DUPLICATES REQUIRE DATA PLAN';
  end if;
end $$;

create unique index if not exists uniq_customer_tags_tenant_customer_tag_upsert
  on public.customer_tags (tenant_id, customer_id, tag_name);

commit;
