begin;

do $$
declare
  v_tenant_a uuid := 'ca000000-0000-4000-8000-000000000001';
  v_tenant_b uuid := 'ca000000-0000-4000-8000-000000000002';
begin
  if exists (select 1 from public.tenants where id in (v_tenant_a, v_tenant_b))
     or exists (select 1 from public.users where id in ('preview-delete-user-a', 'preview-delete-user-b'))
     or exists (select 1 from public.orders where id in ('preview-delete-order-target', 'preview-delete-order-remains')) then
    raise exception 'PREVIEW_DELETE_FIXTURE_ID_COLLISION';
  end if;
end;
$$;

insert into public.tenants (id, name, status, metadata)
values
  ('ca000000-0000-4000-8000-000000000001', 'TEST delete intent tenant A', 'active', '{"marker":"preview-delete-intent-20260923"}'::jsonb),
  ('ca000000-0000-4000-8000-000000000002', 'TEST delete intent tenant B', 'active', '{"marker":"preview-delete-intent-20260923"}'::jsonb);

insert into public.users (id, username, password_hash, name, role, phone, is_active)
values
  ('preview-delete-user-a', 'preview-delete-user-a-20260923', 'TEST_NOT_LOGINABLE', 'TEST User A', 'Owner', '', true),
  ('preview-delete-user-b', 'preview-delete-user-b-20260923', 'TEST_NOT_LOGINABLE', 'TEST User B', 'Owner', '', true);

insert into public.tenant_memberships (tenant_id, user_id, role, is_active)
values
  ('ca000000-0000-4000-8000-000000000001', 'preview-delete-user-a', 'Owner', true),
  ('ca000000-0000-4000-8000-000000000002', 'preview-delete-user-b', 'Owner', true);

insert into public.customers (
  id, tenant_id, name, phone, latest_address, purchase_count,
  total_quantity, total_amount, first_purchase_date, last_purchase_date,
  status, vip_level, customer_score
) values (
  'preview-delete-customer-b',
  'ca000000-0000-4000-8000-000000000002',
  'TEST Customer B',
  '0999990923',
  'TEST ADDRESS',
  2,
  3,
  300,
  '2026-09-21',
  '2026-09-22',
  'NORMAL',
  'NORMAL',
  0
);

insert into public.orders (
  id, tenant_id, customer_id, order_number, customer_name, phone, address,
  items, quantity, amount, order_date, source, source_channel, raw_text, created_by
) values
  (
    'preview-delete-order-remains',
    'ca000000-0000-4000-8000-000000000002',
    'preview-delete-customer-b',
    'TEST-REMAINS',
    'TEST Customer B',
    '0999990923',
    'TEST ADDRESS',
    'TEST Product',
    1,
    100,
    '2026-09-21',
    'TEST',
    'PREVIEW',
    'preview-delete-intent-20260923',
    'preview-delete-user-b'
  ),
  (
    'preview-delete-order-target',
    'ca000000-0000-4000-8000-000000000002',
    'preview-delete-customer-b',
    'TEST-TARGET',
    'TEST Customer B',
    '0999990923',
    'TEST ADDRESS',
    'TEST Product',
    2,
    200,
    '2026-09-22',
    'TEST',
    'PREVIEW',
    'preview-delete-intent-20260923',
    'preview-delete-user-b'
  );

insert into public.settings (id, tenant_id, key, value)
values (
  'preview-delete-products-setting',
  'ca000000-0000-4000-8000-000000000002',
  'products',
  '[{"id":"preview-delete-product","name":"TEST Product","stockQuantity":7}]'::jsonb
);

do $$
begin
  begin
    delete from public.orders where id = 'preview-delete-order-target';
    raise exception 'RAW_DELETE_UNEXPECTEDLY_SUCCEEDED';
  exception when others then
    if sqlerrm not like '%ORDER_DELETE_EXPLICIT_USER_INTENT_REQUIRED%' then raise; end if;
  end;
  if not exists (select 1 from public.orders where id = 'preview-delete-order-target') then
    raise exception 'RAW_DELETE_CHANGED_ORDER';
  end if;
end;
$$;

do $$
begin
  begin
    perform public.delete_order_with_audit(
      'preview-delete-order-target',
      'ca000000-0000-4000-8000-000000000002',
      'preview-delete-user-b',
      'Owner',
      '{}'::jsonb
    );
    raise exception 'LEGACY_DELETE_UNEXPECTEDLY_SUCCEEDED';
  exception when others then
    if sqlerrm not like '%ORDER_DELETE_EXPLICIT_USER_INTENT_REQUIRED%' then raise; end if;
  end;
end;
$$;

do $$
declare
  v_result jsonb;
begin
  begin
    perform public.create_order_delete_intent(
      'preview-delete-order-target',
      'ca000000-0000-4000-8000-000000000002',
      'preview-delete-user-a',
      'Owner',
      repeat('a', 64),
      repeat('1', 64),
      '{}'::jsonb
    );
    raise exception 'CROSS_TENANT_ACTOR_UNEXPECTEDLY_SUCCEEDED';
  exception when others then
    if sqlerrm not like '%ORDER_DELETE_INTENT_ACTOR_NOT_IN_TENANT%' then raise; end if;
  end;

  v_result := public.create_order_delete_intent(
    'preview-delete-order-target',
    'ca000000-0000-4000-8000-000000000001',
    'preview-delete-user-a',
    'Owner',
    repeat('a', 64),
    repeat('2', 64),
    '{}'::jsonb
  );
  if coalesce((v_result->>'ok')::boolean, true) or v_result->>'reason' <> 'not_found' then
    raise exception 'CROSS_TENANT_ORDER_LOOKUP_NOT_CLOSED';
  end if;
end;
$$;

do $$
begin
  begin
    delete from public.customers where id = 'preview-delete-customer-b';
    raise exception 'CUSTOMER_CASCADE_UNEXPECTEDLY_SUCCEEDED';
  exception when foreign_key_violation then null;
  end;
  if (select count(*) from public.orders where customer_id = 'preview-delete-customer-b') <> 2 then
    raise exception 'CUSTOMER_DELETE_CHANGED_ORDERS';
  end if;
end;
$$;

insert into public.settings (id, tenant_id, key, value)
values (
  'preview-delete-import-job-setting',
  'ca000000-0000-4000-8000-000000000002',
  'import_job_preview-delete-job',
  '{"type":"orders","importedOrderIds":["preview-delete-order-target"]}'::jsonb
);

do $$
begin
  begin
    perform public.cleanup_import_job_with_audit(
      'preview-delete-job',
      'ca000000-0000-4000-8000-000000000002',
      'preview-delete-user-b',
      'Owner',
      '{}'::jsonb
    );
    raise exception 'IMPORT_CLEANUP_UNEXPECTEDLY_DELETED_ORDER';
  exception when others then
    if sqlerrm not like '%IMPORT_CLEANUP_ORDER_DELETE_FORBIDDEN%' then raise; end if;
  end;
end;
$$;

do $$
declare
  v_result jsonb;
  v_intent uuid;
begin
  v_result := public.create_order_delete_intent(
    'preview-delete-order-target',
    'ca000000-0000-4000-8000-000000000002',
    'preview-delete-user-b',
    'Owner',
    repeat('b', 64),
    repeat('3', 64),
    '{}'::jsonb
  );
  v_intent := (v_result->>'intent_id')::uuid;

  begin
    perform public.delete_order_with_confirmed_intent(
      'preview-delete-order-remains',
      'ca000000-0000-4000-8000-000000000002',
      'preview-delete-user-b',
      'Owner',
      repeat('b', 64),
      v_intent,
      repeat('3', 64),
      '{}'::jsonb,
      null,
      '{"applied":false}'::jsonb,
      '{}'::jsonb
    );
    raise exception 'WRONG_ORDER_INTENT_UNEXPECTEDLY_SUCCEEDED';
  exception when others then
    if sqlerrm not like '%ORDER_DELETE_INTENT_INVALID_OR_EXPIRED%' then raise; end if;
  end;

  begin
    perform public.delete_order_with_confirmed_intent(
      'preview-delete-order-target',
      'ca000000-0000-4000-8000-000000000002',
      'preview-delete-user-b',
      'Owner',
      repeat('c', 64),
      v_intent,
      repeat('3', 64),
      '{}'::jsonb,
      null,
      '{"applied":false}'::jsonb,
      '{}'::jsonb
    );
    raise exception 'WRONG_SESSION_INTENT_UNEXPECTEDLY_SUCCEEDED';
  exception when others then
    if sqlerrm not like '%ORDER_DELETE_INTENT_INVALID_OR_EXPIRED%' then raise; end if;
  end;

  begin
    perform public.delete_order_with_confirmed_intent(
      'preview-delete-order-target',
      'ca000000-0000-4000-8000-000000000002',
      'preview-delete-user-a',
      'Owner',
      repeat('b', 64),
      v_intent,
      repeat('3', 64),
      '{}'::jsonb,
      null,
      '{"applied":false}'::jsonb,
      '{}'::jsonb
    );
    raise exception 'WRONG_USER_INTENT_UNEXPECTEDLY_SUCCEEDED';
  exception when others then
    if sqlerrm not like '%ORDER_DELETE_INTENT_ACTOR_NOT_IN_TENANT%' then raise; end if;
  end;
end;
$$;

do $$
declare
  v_result jsonb;
  v_intent uuid;
begin
  v_result := public.create_order_delete_intent(
    'preview-delete-order-target',
    'ca000000-0000-4000-8000-000000000002',
    'preview-delete-user-b',
    'Owner',
    repeat('d', 64),
    repeat('4', 64),
    '{}'::jsonb
  );
  v_intent := (v_result->>'intent_id')::uuid;
  update public.order_delete_intents
  set created_at = clock_timestamp() - interval '3 minutes',
      expires_at = clock_timestamp() - interval '1 second'
  where id = v_intent;
  begin
    perform public.delete_order_with_confirmed_intent(
      'preview-delete-order-target',
      'ca000000-0000-4000-8000-000000000002',
      'preview-delete-user-b',
      'Owner',
      repeat('d', 64),
      v_intent,
      repeat('4', 64),
      '{}'::jsonb,
      null,
      '{"applied":false}'::jsonb,
      '{}'::jsonb
    );
    raise exception 'EXPIRED_INTENT_UNEXPECTEDLY_SUCCEEDED';
  exception when others then
    if sqlerrm not like '%ORDER_DELETE_INTENT_INVALID_OR_EXPIRED%' then raise; end if;
  end;
end;
$$;

do $$
declare
  v_result jsonb;
  v_intent uuid;
  v_audit_count integer;
begin
  v_result := public.create_order_delete_intent(
    'preview-delete-order-target',
    'ca000000-0000-4000-8000-000000000002',
    'preview-delete-user-b',
    'Owner',
    repeat('e', 64),
    repeat('5', 64),
    '{"marker":"preview-delete-intent-20260923"}'::jsonb
  );
  v_intent := (v_result->>'intent_id')::uuid;

  v_result := public.delete_order_with_confirmed_intent(
    'preview-delete-order-target',
    'ca000000-0000-4000-8000-000000000002',
    'preview-delete-user-b',
    'Owner',
    repeat('e', 64),
    v_intent,
    repeat('5', 64),
    jsonb_build_object(
      'id', 'preview-delete-customer-b',
      'name', 'TEST Customer B',
      'phone', '0999990923',
      'latest_address', 'TEST ADDRESS',
      'purchase_count', 1,
      'total_quantity', 1,
      'total_amount', 100,
      'first_purchase_date', '2026-09-21',
      'last_purchase_date', '2026-09-21',
      'status', 'NORMAL',
      'vip_level', 'NORMAL',
      'customer_score', 0
    ),
    '[{"id":"preview-delete-product","name":"TEST Product","stockQuantity":9}]'::jsonb,
    '{"applied":true,"product_id":"preview-delete-product","product_name":"TEST Product","quantity":2,"stock_before":7,"stock_after":9}'::jsonb,
    '{"marker":"preview-delete-intent-20260923"}'::jsonb
  );
  if not coalesce((v_result->>'ok')::boolean, false) then raise exception 'CONFIRMED_DELETE_FAILED'; end if;
  if exists (select 1 from public.orders where id = 'preview-delete-order-target') then raise exception 'CONFIRMED_DELETE_ORDER_REMAINS'; end if;
  if not exists (select 1 from public.orders where id = 'preview-delete-order-remains') then raise exception 'CONFIRMED_DELETE_WRONG_ORDER_REMOVED'; end if;
  if not exists (
    select 1 from public.customers
    where id = 'preview-delete-customer-b' and tenant_id = 'ca000000-0000-4000-8000-000000000002'
      and purchase_count = 1 and total_quantity = 1 and total_amount = 100
      and first_purchase_date = '2026-09-21' and last_purchase_date = '2026-09-21'
  ) then raise exception 'CONFIRMED_DELETE_CUSTOMER_AGGREGATE_WRONG'; end if;
  if (select value->0->>'stockQuantity' from public.settings where id = 'preview-delete-products-setting') <> '9' then
    raise exception 'CONFIRMED_DELETE_INVENTORY_WRONG';
  end if;
  if not exists (
    select 1 from public.order_deletion_audit
    where order_id = 'preview-delete-order-target'
      and tenant_id = 'ca000000-0000-4000-8000-000000000002'
      and actor_user_id = 'preview-delete-user-b'
      and delete_intent_id = v_intent
      and deletion_proof = 'EXPLICIT_USER_CONFIRMED_DELETE'
      and order_snapshot->>'id' = 'preview-delete-order-target'
      and inventory_effect->>'stock_before' = '7'
      and inventory_effect->>'stock_after' = '9'
  ) then raise exception 'CONFIRMED_DELETE_AUDIT_INCOMPLETE'; end if;
  if not exists (
    select 1 from public.order_delete_intents
    where id = v_intent and consumed_at is not null and consumed_transaction_id = txid_current()
  ) then raise exception 'CONFIRMED_DELETE_INTENT_NOT_CONSUMED'; end if;

  select count(*) into v_audit_count from public.order_deletion_audit where order_id = 'preview-delete-order-target';
  begin
    perform public.delete_order_with_confirmed_intent(
      'preview-delete-order-target',
      'ca000000-0000-4000-8000-000000000002',
      'preview-delete-user-b',
      'Owner',
      repeat('e', 64),
      v_intent,
      repeat('5', 64),
      '{}'::jsonb,
      null,
      '{"applied":false}'::jsonb,
      '{}'::jsonb
    );
    raise exception 'REPLAY_UNEXPECTEDLY_SUCCEEDED';
  exception when others then
    if sqlerrm not like '%ORDER_DELETE_INTENT_INVALID_OR_EXPIRED%' then raise; end if;
  end;
  if (select count(*) from public.order_deletion_audit where order_id = 'preview-delete-order-target') <> v_audit_count then
    raise exception 'REPLAY_CREATED_DUPLICATE_AUDIT';
  end if;
  if (select value->0->>'stockQuantity' from public.settings where id = 'preview-delete-products-setting') <> '9' then
    raise exception 'REPLAY_CHANGED_INVENTORY';
  end if;
end;
$$;

-- A legacy July order must not be rejected because the application-side
-- customer projection is stale or normalized differently from the database.
insert into public.orders (
  id, tenant_id, customer_id, order_number, customer_name, phone, address,
  items, quantity, amount, order_date, source, source_channel, raw_text, created_by
) values (
  'preview-delete-order-july-legacy',
  'ca000000-0000-4000-8000-000000000002',
  'preview-delete-customer-b',
  'legacy/07-31',
  'TEST Customer B',
  '0999990923',
  'TEST ADDRESS',
  'TEST Product',
  1,
  100,
  '2026-07-31',
  'Import',
  'Legacy Import',
  'preview-delete-intent-20260923',
  'preview-delete-user-b'
);

do $$
declare
  v_result jsonb;
  v_intent uuid;
begin
  v_result := public.create_order_delete_intent(
    'preview-delete-order-july-legacy',
    'ca000000-0000-4000-8000-000000000002',
    'preview-delete-user-b',
    'Owner',
    repeat('f', 64),
    repeat('6', 64),
    '{"marker":"preview-delete-intent-20260923"}'::jsonb
  );
  v_intent := (v_result->>'intent_id')::uuid;

  v_result := public.delete_order_with_confirmed_intent(
    'preview-delete-order-july-legacy',
    'ca000000-0000-4000-8000-000000000002',
    'preview-delete-user-b',
    'Owner',
    repeat('f', 64),
    v_intent,
    repeat('6', 64),
    '{"id":"wrong-customer","purchase_count":999,"total_quantity":999,"total_amount":999}'::jsonb,
    null,
    '{"applied":false}'::jsonb,
    '{"marker":"preview-delete-intent-20260923"}'::jsonb
  );
  if not coalesce((v_result->>'ok')::boolean, false) then raise exception 'LEGACY_JULY_DELETE_FAILED'; end if;
  if exists (select 1 from public.orders where id = 'preview-delete-order-july-legacy') then
    raise exception 'LEGACY_JULY_ORDER_REMAINS';
  end if;
  if not exists (
    select 1 from public.customers
    where id = 'preview-delete-customer-b'
      and tenant_id = 'ca000000-0000-4000-8000-000000000002'
      and purchase_count = 1 and total_quantity = 1 and total_amount = 100
  ) then raise exception 'LEGACY_JULY_CUSTOMER_AGGREGATE_WRONG'; end if;
end;
$$;

rollback;

select
  (select count(*) from public.tenants where id in ('ca000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000002')) as fixture_tenants_remaining,
  (select count(*) from public.users where id in ('preview-delete-user-a', 'preview-delete-user-b')) as fixture_users_remaining,
  (select count(*) from public.customers where id = 'preview-delete-customer-b') as fixture_customers_remaining,
  (select count(*) from public.orders where id in ('preview-delete-order-target', 'preview-delete-order-remains', 'preview-delete-order-july-legacy')) as fixture_orders_remaining,
  (select count(*) from public.settings where id in ('preview-delete-products-setting', 'preview-delete-import-job-setting')) as fixture_settings_remaining,
  (select count(*) from public.order_deletion_audit where order_id = 'preview-delete-order-target') as fixture_audits_remaining,
  (select count(*) from public.order_delete_intents where order_id = 'preview-delete-order-target') as fixture_intents_remaining;
