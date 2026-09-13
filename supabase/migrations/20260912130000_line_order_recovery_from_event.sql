-- Build an exact historical order payload from one authoritative structured
-- LINE success-ACK event, then delegate all writes to the atomic recovery RPC.
-- Service-role only. The function never scans or recovers events implicitly.
create or replace function public.recover_historical_line_order_from_event(
  p_tenant_id uuid,
  p_line_event_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_raw_text text;
  v_raw_event jsonb;
  v_line_message_id text;
  v_order_id text;
  v_order_number text;
  v_date_text text;
  v_order_date date;
  v_day integer;
  v_month integer;
  v_year integer;
  v_items text;
  v_name text;
  v_phone text;
  v_alternate_phone text;
  v_address text;
  v_quantity integer;
  v_amount numeric;
  v_source_channel text;
  v_origin_source text;
  v_social_name text;
  v_free_gift text;
  v_vip_card_status text;
  v_note text;
  v_now timestamptz := clock_timestamp();
  v_order_time time;
  v_products_before jsonb;
  v_products_after jsonb;
  v_products_updated_at timestamptz;
  v_product jsonb;
  v_product_id text;
  v_package jsonb;
  v_package_count integer := 0;
  v_inventory_quantity integer;
  v_stock numeric;
  v_customer_id text;
  v_customer_count integer;
  v_customer_updated_at timestamptz;
  v_customer_note text := '';
  v_customer_assigned_to text;
  v_last_contact_date date;
  v_last_contact_note text := '';
  v_purchase_count integer;
  v_total_quantity integer;
  v_total_amount numeric;
  v_first_purchase_date date;
  v_last_purchase_date date;
  v_latest_name text;
  v_latest_address text;
  v_latest_quantity integer;
  v_follow_days integer := 15;
  v_follow_up_date date;
  v_overdue_days integer;
  v_vip_threshold numeric := 5000;
  v_vvip_threshold numeric := 10000;
  v_super_vip_threshold numeric := 20000;
  v_vip_level text := 'NORMAL';
  v_status text := 'NEW';
  v_customer_score numeric := 0;
  v_active_days integer;
  v_product_cost numeric := 0;
  v_package_expense numeric := 0;
  v_global_expense numeric := 0;
  v_profit numeric := 0;
  v_duplicate_fingerprint text;
  v_order_raw_text text;
  v_customer_payload jsonb;
  v_order_payload jsonb;
  v_source_snapshot jsonb;
  v_result jsonb;
begin
  if p_tenant_id is null or nullif(btrim(p_line_event_id), '') is null then
    raise exception 'RECOVERY_IDENTIFIERS_REQUIRED';
  end if;

  select raw_text, raw_event
    into v_raw_text, v_raw_event
    from public.line_messages
   where tenant_id = p_tenant_id
     and id = p_line_event_id
   for update;
  if not found then
    raise exception 'RECOVERY_SOURCE_EVENT_NOT_FOUND';
  end if;

  v_line_message_id := nullif(btrim(v_raw_event#>>'{message,id}'), '');
  v_order_id := nullif(btrim(v_raw_event->'__debug'->>'internal_order_id'), '');
  if lower(coalesce(v_raw_event->'__debug'->>'processing_status', '')) <> 'replied'
    or nullif(btrim(coalesce(v_raw_event->'__debug'->>'failure_category', '')), '') is not null
    or coalesce(v_raw_event->'__debug'->>'reply_text', '') not like '✅ นำเข้าออเดอร์เรียบร้อยแล้ว%'
    or v_line_message_id is null
    or v_order_id is null then
    raise exception 'RECOVERY_SOURCE_ACK_NOT_AUTHORITATIVE';
  end if;

  v_items := nullif(btrim(substring(v_raw_text from '(?im)^\s*สินค้า\s*[:：]\s*([^\r\n]*)')), '');
  v_order_number := nullif(regexp_replace(btrim(substring(v_raw_text from '(?im)^\s*เลขออเดอร์\s*[:：]\s*([^\r\n]*)')), '\s+', ' ', 'g'), '');
  v_date_text := nullif(btrim(substring(v_raw_text from '(?im)^\s*วันที่ซื้อ\s*[:：]\s*([^\r\n]*)')), '');
  v_name := nullif(regexp_replace(btrim(substring(v_raw_text from '(?im)^\s*ชื่อลูกค้า\s*[:：]\s*([^\r\n]*)')), '\s+', ' ', 'g'), '');
  v_phone := regexp_replace(coalesce(substring(v_raw_text from '(?im)^\s*เบอร์โทร\s*[:：]\s*([^\r\n]*)'), ''), '[^0-9]', '', 'g');
  v_alternate_phone := regexp_replace(coalesce(substring(v_raw_text from '(?im)^\s*เบอร์โทรสำรอง\s*[:：]\s*([^\r\n]*)'), ''), '[^0-9]', '', 'g');
  v_address := nullif(regexp_replace(btrim(substring(v_raw_text from '(?im)^\s*ที่อยู่จัดส่ง\s*[:：]\s*([^\r\n]*)')), '\s+', ' ', 'g'), '');
  v_quantity := nullif(regexp_replace(coalesce(substring(v_raw_text from '(?im)^\s*(?:จำนวน|จำนวนกระปุก)\s*[:：]\s*([^\r\n]*)'), ''), '[^0-9.]', '', 'g'), '')::numeric::integer;
  v_amount := nullif(regexp_replace(coalesce(substring(v_raw_text from '(?im)^\s*ยอดซื้อ\s*[:：]\s*([^\r\n]*)'), ''), '[^0-9.]', '', 'g'), '')::numeric;
  v_source_channel := coalesce(nullif(regexp_replace(btrim(substring(v_raw_text from '(?im)^\s*ช่องทางการสั่งซื้อ\s*[:：]\s*([^\r\n]*)')), '\s+', ' ', 'g'), ''), 'LINE');
  v_social_name := coalesce(nullif(regexp_replace(btrim(substring(v_raw_text from '(?im)^\s*Facebook / LINE ลูกค้า\s*[:：]\s*([^\r\n]*)')), '\s+', ' ', 'g'), ''), '');
  v_origin_source := coalesce(nullif(regexp_replace(btrim(substring(v_raw_text from '(?im)^\s*(?:ช่องทางการขาย|ลูกค้ามาจาก)\s*[:：]\s*([^\r\n]*)')), '\s+', ' ', 'g'), ''), '');
  v_free_gift := coalesce(nullif(regexp_replace(btrim(substring(v_raw_text from '(?im)^\s*ของแถมที่ลูกค้าได้\s*[:：]\s*([^\r\n]*)')), '\s+', ' ', 'g'), ''), '');
  v_vip_card_status := coalesce(nullif(regexp_replace(btrim(substring(v_raw_text from '(?im)^\s*สถานะบัตร VIP\s*[:：]\s*([^\r\n]*)')), '\s+', ' ', 'g'), ''), 'ยังไม่ได้ส่งบัตร');
  v_note := coalesce(nullif(regexp_replace(btrim(substring(v_raw_text from '(?im)^\s*หมายเหตุ\s*[:：]\s*([^\r\n]*)')), '\s+', ' ', 'g'), ''), '');

  if v_items is null or v_order_number is null or v_date_text is null or v_name is null
    or length(v_phone) < 9 or v_address is null or v_quantity <= 0 or v_amount < 0
    or v_date_text !~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{2,4}$' then
    raise exception 'RECOVERY_PAYLOAD_INCOMPLETE';
  end if;

  v_day := split_part(v_date_text, '/', 1)::integer;
  v_month := split_part(v_date_text, '/', 2)::integer;
  v_year := split_part(v_date_text, '/', 3)::integer;
  if v_year < 100 then
    v_year := case when v_year >= 50 then v_year + 1957 else v_year + 2000 end;
  elsif v_year > 2400 then
    v_year := v_year - 543;
  end if;
  v_order_date := make_date(v_year, v_month, v_day);
  v_order_time := (v_now at time zone 'Asia/Bangkok')::time;

  select value, updated_at
    into v_products_before, v_products_updated_at
    from public.settings
   where tenant_id = p_tenant_id and key = 'products'
   for update;
  if not found or jsonb_typeof(v_products_before) <> 'array' then
    raise exception 'RECOVERY_PRODUCT_NOT_FOUND';
  end if;

  select product
    into v_product
    from jsonb_array_elements(v_products_before) product
   where coalesce((product->>'archived')::boolean, false) = false
     and lower(btrim(product->>'name')) = lower(btrim(v_items))
   limit 1;
  if v_product is null then
    select product
      into v_product
      from jsonb_array_elements(v_products_before) product
     where coalesce((product->>'archived')::boolean, false) = false
       and lower(btrim(v_items)) like '%' || lower(btrim(product->>'name')) || '%'
     order by length(product->>'name') desc
     limit 1;
  end if;
  if v_product is null then raise exception 'RECOVERY_PRODUCT_NOT_FOUND'; end if;
  v_product_id := v_product->>'id';

  select count(*), min(package::text)::jsonb
    into v_package_count, v_package
    from jsonb_array_elements(coalesce(v_product->'salesPackages', '[]'::jsonb)) package
   where coalesce((package->>'enabled')::boolean, true)
     and coalesce((package->>'salePrice')::numeric, 0) = v_amount
     and coalesce((package->>'totalQuantityShipped')::numeric, 0) = v_quantity;
  if v_package_count > 1 then raise exception 'RECOVERY_PACKAGE_AMBIGUOUS'; end if;
  v_inventory_quantity := case when v_package_count = 1
    then (v_package->>'totalQuantityShipped')::integer else v_quantity end;
  v_stock := coalesce((v_product->>'stockQuantity')::numeric, 0);
  if v_stock < v_inventory_quantity then raise exception 'RECOVERY_INSUFFICIENT_STOCK'; end if;

  select jsonb_agg(
    case when product->>'id' = v_product_id
      then jsonb_set(product, '{stockQuantity}', to_jsonb(v_stock - v_inventory_quantity), true)
      else product end
    order by ordinal
  )
    into v_products_after
    from jsonb_array_elements(v_products_before) with ordinality rows(product, ordinal);

  select count(*), min(id), min(updated_at), min(note), min(assigned_to),
         min(last_contact_date), min(last_contact_note)
    into v_customer_count, v_customer_id, v_customer_updated_at, v_customer_note,
         v_customer_assigned_to, v_last_contact_date, v_last_contact_note
    from public.customers
   where tenant_id = p_tenant_id
     and regexp_replace(phone, '[^0-9]', '', 'g') = v_phone;
  if v_customer_count > 1 then raise exception 'RECOVERY_CUSTOMER_AMBIGUOUS'; end if;
  if v_customer_count = 0 then
    v_customer_id := 'c_' || substr(md5(p_tenant_id::text || ':' || v_phone), 1, 12);
    v_customer_updated_at := null;
    v_customer_note := '';
    v_customer_assigned_to := null;
    v_last_contact_date := null;
    v_last_contact_note := '';
    if exists (select 1 from public.customers where id = v_customer_id) then
      raise exception 'RECOVERY_CUSTOMER_ID_CONFLICT';
    end if;
  end if;

  with all_orders as (
    select order_date, order_time, id, customer_name, address, quantity, amount
      from public.orders
     where tenant_id = p_tenant_id and customer_id = v_customer_id
    union all
    select v_order_date, v_order_time, v_order_id, v_name, v_address, v_quantity, v_amount
  )
  select count(*), sum(quantity)::integer, sum(amount), min(order_date), max(order_date)
    into v_purchase_count, v_total_quantity, v_total_amount, v_first_purchase_date, v_last_purchase_date
    from all_orders;

  with all_orders as (
    select order_date, order_time, id, customer_name, address, quantity
      from public.orders
     where tenant_id = p_tenant_id and customer_id = v_customer_id
    union all
    select v_order_date, v_order_time, v_order_id, v_name, v_address, v_quantity
  )
  select customer_name, address, quantity
    into v_latest_name, v_latest_address, v_latest_quantity
    from all_orders
   order by order_date desc, order_time desc nulls last, id desc
   limit 1;

  select coalesce((value#>>'{}')::integer, 15)
    into v_follow_days
    from public.settings
   where tenant_id = p_tenant_id and key = 'followUpDaysPerUnit';
  v_follow_days := greatest(coalesce(v_follow_days, 15), 1);
  v_follow_up_date := v_last_purchase_date + greatest(v_follow_days, v_latest_quantity * v_follow_days);
  v_overdue_days := ((now() at time zone 'Asia/Bangkok')::date - v_follow_up_date);

  select coalesce((value->>'vip')::numeric, 5000),
         coalesce((value->>'vvip')::numeric, 10000),
         coalesce((value->>'superVip')::numeric, 20000)
    into v_vip_threshold, v_vvip_threshold, v_super_vip_threshold
    from public.settings
   where tenant_id = p_tenant_id and key = 'vipThresholds';
  v_vip_level := case
    when v_total_amount >= coalesce(v_super_vip_threshold, 20000) then 'SUPER VIP'
    when v_total_amount >= coalesce(v_vvip_threshold, 10000) then 'VVIP'
    when v_total_amount >= coalesce(v_vip_threshold, 5000) then 'VIP'
    else 'NORMAL' end;
  v_status := case when v_purchase_count <= 1 then 'NEW' else 'NORMAL' end;
  if v_vip_level <> 'NORMAL' then v_status := v_vip_level; end if;
  if v_overdue_days > 90 then v_status := 'LOST';
  elsif v_overdue_days > 30 then v_status := 'AT RISK'; end if;
  v_active_days := greatest(30, v_last_purchase_date - v_first_purchase_date + 1);
  if v_purchase_count > 0 and v_total_amount > 0 then
    v_customer_score := round(v_total_amount * v_purchase_count * v_purchase_count * 30 / v_active_days);
  end if;

  select coalesce(sum(
    case when coalesce((cost->>'enabled')::boolean, true)
      and lower(btrim(cost->>'name')) = lower(btrim(v_product->>'name'))
      then coalesce((cost->>'costPerJar')::numeric, 0) * v_inventory_quantity else 0 end
  ), 0)
    into v_product_cost
    from public.settings s
    cross join lateral jsonb_array_elements(coalesce(s.value, '[]'::jsonb)) cost
   where s.tenant_id = p_tenant_id and s.key = 'productCosts';
  if v_package_count = 1 then
    select coalesce(sum(coalesce((expense->>'amount')::numeric, 0)), 0)
      into v_package_expense
      from jsonb_array_elements(coalesce(v_package->'expenses', '[]'::jsonb)) expense
     where coalesce((expense->>'enabled')::boolean, true);
  end if;
  select coalesce(sum(case
    when not coalesce((cost->>'enabled')::boolean, true) then 0
    when cost->>'type' = 'percent_sales' then v_amount * coalesce((cost->>'amount')::numeric, 0) / 100
    when cost->>'type' = 'per_item' then v_quantity * coalesce((cost->>'amount')::numeric, 0)
    else coalesce((cost->>'amount')::numeric, 0) end), 0)
    into v_global_expense
    from public.settings s
    cross join lateral jsonb_array_elements(coalesce(s.value, '[]'::jsonb)) cost
   where s.tenant_id = p_tenant_id and s.key = 'additionalCosts';
  v_profit := round(v_amount - v_product_cost - v_package_expense - v_global_expense, 6);

  v_origin_source := case
    when lower(v_origin_source) like '%facebook%' or v_origin_source like '%เฟส%' or v_origin_source like '%เพจ%' then 'facebook'
    when lower(v_origin_source) like '%line%' or v_origin_source like '%ไลน์%' then 'line'
    when v_origin_source like '%โทร%' then 'phone'
    when lower(v_origin_source) = 'crm' then 'crm'
    else lower(regexp_replace(v_origin_source, '[^a-zA-Z0-9ก-๙]+', '_', 'g')) end;
  v_duplicate_fingerprint := format(
    '{"customer_name":%s,"phone_number":%s,"shipping_address":%s,"quantity":%s,"total_amount":%s}',
    to_json(lower(regexp_replace(v_name, '\s+', ' ', 'g')))::text,
    to_json(v_phone)::text,
    to_json(lower(regexp_replace(v_address, '\s+', ' ', 'g')))::text,
    v_quantity,
    v_amount
  );

  v_order_raw_text := jsonb_build_object(
    'primary', v_raw_text,
    '__orderNumber', v_order_number,
    '__alternatePhone', v_alternate_phone,
    '__originSource', v_origin_source,
    '__originSourceOther', '',
    '__lineMessageId', v_line_message_id,
    '__importJobId', '',
    '__duplicateFingerprint', v_duplicate_fingerprint,
    '__productId', v_product_id,
    '__packageId', coalesce(v_package->>'id', ''),
    '__packageName', coalesce(v_package->>'name', ''),
    '__paidQuantity', coalesce((v_package->>'paidQuantity')::numeric, 0),
    '__freeQuantity', coalesce((v_package->>'freeQuantity')::numeric, 0),
    '__totalQuantityShipped', case when v_package_count = 1 then v_inventory_quantity else 0 end,
    '__packageExpenses', case when v_package_count = 1 then coalesce(v_package->'expenses', '[]'::jsonb) else '[]'::jsonb end,
    '__revenueSnapshot', v_amount,
    '__productCostSnapshot', v_product_cost,
    '__packageExpenseSnapshot', v_package_expense,
    '__globalExpenseSnapshot', v_global_expense,
    '__profitBeforeAdsSnapshot', v_profit,
    '__profitAfterAdsSnapshot', v_profit,
    '__profitSnapshotVersion', 1,
    '__profitSnapshotCreatedAt', v_now::text,
    '__profitSnapshotUpdatedAt', v_now::text,
    '__profitSnapshotSource', 'created'
  )::text;

  v_customer_payload := jsonb_build_object(
    'id', v_customer_id,
    'name', v_latest_name,
    'phone', v_phone,
    'latest_address', v_latest_address,
    'note', coalesce(v_customer_note, ''),
    'assigned_to', v_customer_assigned_to,
    'first_purchase_date', v_first_purchase_date,
    'last_purchase_date', v_last_purchase_date,
    'purchase_count', v_purchase_count,
    'total_quantity', v_total_quantity,
    'total_amount', v_total_amount,
    'status', v_status,
    'vip_level', v_vip_level,
    'customer_score', v_customer_score,
    'follow_up_date', v_follow_up_date,
    'last_contact_date', v_last_contact_date,
    'last_contact_note', coalesce(v_last_contact_note, '')
  );
  v_order_payload := jsonb_build_object(
    'id', v_order_id,
    'customer_id', v_customer_id,
    'order_number', v_order_number,
    'customer_name', v_name,
    'phone', v_phone,
    'address', v_address,
    'items', v_product->>'name',
    'quantity', v_quantity,
    'amount', v_amount,
    'order_date', v_order_date,
    'order_time', v_order_time,
    'source', 'LINE',
    'source_channel', v_source_channel,
    'social_name', v_social_name,
    'free_gift', v_free_gift,
    'vip_card_status', v_vip_card_status,
    'note', v_note,
    'raw_text', v_order_raw_text,
    'created_by', null
  );
  v_source_snapshot := jsonb_build_object(
    'line_event_id', p_line_event_id,
    'line_message_id', v_line_message_id,
    'original_order_id', v_order_id,
    'raw_text', v_raw_text,
    'parsed_order', v_order_payload
  );

  select public.recover_historical_line_order(
    p_tenant_id, p_line_event_id, v_line_message_id, v_order_id,
    v_customer_payload, v_order_payload,
    v_products_before, v_products_after, v_products_updated_at,
    v_customer_updated_at, v_source_snapshot
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.recover_historical_line_order_from_event(uuid, text)
  from public, anon, authenticated;
grant execute on function public.recover_historical_line_order_from_event(uuid, text)
  to service_role;
