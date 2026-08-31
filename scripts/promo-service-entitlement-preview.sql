-- Invoked ONLY by the hard-guarded Preview runner, in a rollback-only transaction.
-- All identities, subscriptions and payments below are disposable test fixtures.
create temporary table promo_verification_results (case_name text, evidence jsonb);
create function pg_temp.check_true(ok boolean, label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'PROMO_TEST_FAILED: %', label; end if; end;
$$;

do $$
declare
  v_case record;
  v_id uuid;
  v_input jsonb;
  v_code text;
  v_user text;
  v_key text;
  v_tenant uuid;
  v_sub public.subscriptions%rowtype;
  v_before public.subscriptions%rowtype;
  v_payment record;
  v_validation record;
  v_state jsonb;
  v_grant jsonb;
  v_end timestamptz;
  v_expected timestamptz;
  v_audit integer;
  v_error text;
begin
  perform pg_temp.check_true(current_setting('growup.test_project') = 'enwabsfsmwwcwwirdwok', 'Preview target');
  perform pg_temp.check_true(left(current_setting('growup.test_password_hash'),7)='scrypt$', 'normal password hash implementation');
  perform pg_temp.check_true((select md5(prosrc)='bf91ee8c8a90087181b2761962aa4d77' from pg_proc where proname='growup_signup_bootstrap'), 'signup RPC unchanged');
  perform pg_temp.check_true((select md5(prosrc)='8784c55369e83e8cfeff54d405ba6576' from pg_proc where proname='growup_begin_subscription_checkout'), 'checkout RPC unchanged');
  perform pg_temp.check_true((select md5(prosrc)='d34b958d51ed18aa12bf002f35f80aa3' from pg_proc where proname='growup_record_subscription_checkout_success'), 'verified-payment RPC unchanged');
  perform pg_temp.check_true(not has_function_privilege('anon','public.growup_promo_service_period_end(timestamptz,text,numeric)','EXECUTE'), 'anon cannot call grant helper');
  perform pg_temp.check_true(not has_function_privilege('authenticated','public.growup_apply_promo_service_entitlement()','EXECUTE'), 'customer cannot call entitlement trigger');

  -- Exact Bangkok month arithmetic including end-of-month and leap year.
  perform pg_temp.check_true(public.growup_promo_service_period_end('2027-01-31 10:00+07','months',1)='2027-02-28 10:00+07'::timestamptz,'Jan31 +1 month');
  perform pg_temp.check_true(public.growup_promo_service_period_end('2028-01-31 10:00+07','months',1)='2028-02-29 10:00+07'::timestamptz,'leap-year +1 month');
  perform pg_temp.check_true(public.growup_promo_service_period_end('2027-03-31 10:00+07','months',3)='2027-06-30 10:00+07'::timestamptz,'Mar31 +3 months');

  for v_case in select * from (values
    ('days1','service_days',1::numeric,'starter',49000, '2026-10-01 10:00+07'::timestamptz),
    ('days14','service_days',14,'business',99000,'2026-10-14 10:00+07'::timestamptz),
    ('days30','service_days',30,'starter',49000,'2026-10-30 10:00+07'::timestamptz),
    ('months1','free_months',1,'starter',49000,'2026-10-30 10:00+07'::timestamptz),
    ('months3','free_months',3,'business',99000,'2026-12-30 10:00+07'::timestamptz),
    ('percent10','percent_discount',10,'business',89100,null::timestamptz),
    ('percent100','percent_discount',100,'business',0,null::timestamptz),
    ('fixed500','fixed_amount_discount',500,'business',49000,null::timestamptz)
  ) as c(label,kind,value,plan,amount,expected_end) loop
    v_code := 'QA_' || upper(replace(gen_random_uuid()::text,'-',''));
    v_input := jsonb_build_object('code',v_code,'description','Preview transaction-only service entitlement verification',
      'benefit_type',v_case.kind,'benefit_value',v_case.value,'applicable_plans',jsonb_build_array(v_case.plan),
      'applicable_billing',jsonb_build_array('monthly'),'max_redemptions',1,'max_redemptions_per_tenant',1,'new_customer_only',true);
    v_state := public.growup_platform_admin_save_promotion_code('u_admin',v_input);
    v_id := (v_state->'promotion'->>'id')::uuid;
    perform pg_temp.check_true(v_id is not null, 'create '||v_case.label);
    v_input := v_input || jsonb_build_object('id',v_id,'description','Preview transaction-only edited');
    perform public.growup_platform_admin_save_promotion_code('u_admin',v_input);
    perform public.growup_platform_admin_set_promotion_status('u_admin',v_id,false);
    select * into v_validation from public.growup_validate_promotion_code(v_code,v_case.plan,'monthly');
    perform pg_temp.check_true(not v_validation.valid,'disabled '||v_case.label);
    perform public.growup_platform_admin_set_promotion_status('u_admin',v_id,true);
    select * into v_validation from public.growup_validate_promotion_code(lower(v_code),v_case.plan,'monthly');
    perform pg_temp.check_true(v_validation.valid and v_validation.benefit_type=v_case.kind,'normalized validation '||v_case.label);
    select * into v_validation from public.growup_validate_promotion_code(v_code,'enterprise','monthly');
    perform pg_temp.check_true(not v_validation.valid,'plan restriction');
    select * into v_validation from public.growup_validate_promotion_code(v_code,v_case.plan,'yearly');
    perform pg_temp.check_true(not v_validation.valid,'billing restriction');

    v_user := 'u_promo_qa_' || replace(gen_random_uuid()::text,'-','');
    v_key := 'signup-' || v_user;
    select tenant_id into v_tenant from public.growup_signup_bootstrap(v_key,v_user,v_user,current_setting('growup.test_password_hash'),
      'Disposable Preview','Disposable Preview','{}'::jsonb,v_code,v_case.plan,'monthly');
    select * into v_sub from public.subscriptions where tenant_id=v_tenant;
    perform pg_temp.check_true(v_sub.amount_due_minor=v_case.amount,'discount stored in THB minor units '||v_case.label);
    perform pg_temp.check_true((select count(*)=1 from public.promotion_redemptions where promotion_code_id=v_id),'single atomic redemption');
    -- Same signup retry must return the same tenant and not consume again.
    perform pg_temp.check_true((select tenant_id=v_tenant from public.growup_signup_bootstrap(v_key,v_user,v_user,current_setting('growup.test_password_hash'),
      'Disposable Preview','Disposable Preview','{}'::jsonb,v_code,v_case.plan,'monthly')),'signup idempotency');
    perform pg_temp.check_true((select count(*)=1 from public.promotion_redemptions where promotion_code_id=v_id),'idempotent usage');
    select * into v_validation from public.growup_validate_promotion_code(v_code,v_case.plan,'monthly');
    perform pg_temp.check_true(not v_validation.valid and v_validation.reason='PROMOTION_CODE_EXHAUSTED','total limit');
    select * into v_validation from public.growup_validate_promotion_code(v_code,v_case.plan,'monthly',v_tenant);
    perform pg_temp.check_true(not v_validation.valid and v_validation.reason='PROMOTION_CODE_NEW_CUSTOMERS_ONLY','new customer only');
    perform public.growup_platform_admin_save_promotion_code('u_admin',v_input || jsonb_build_object('new_customer_only',false,'max_redemptions',null));
    select * into v_validation from public.growup_validate_promotion_code(v_code,v_case.plan,'monthly',v_tenant);
    perform pg_temp.check_true(not v_validation.valid and v_validation.reason='PROMOTION_CODE_EXHAUSTED','per-company limit');

    if v_case.kind in ('service_days','free_months') then
      select value into v_grant
      from jsonb_array_elements(coalesce(v_sub.promotion_snapshot->'zero_payment_entitlements','[]'::jsonb))
      where value->>'redemption_id'=(select id::text from public.promotion_redemptions where promotion_code_id=v_id limit 1)
      limit 1;
      perform pg_temp.check_true(v_grant->>'state'='granted' and v_grant->>'source'='promotion_zero_payment','zero-payment service grant created');
      perform pg_temp.check_true(v_grant->>'plan'=v_case.plan and v_grant->>'billing_interval'='monthly','grant plan/billing preserved');
      perform pg_temp.check_true(v_sub.extra_trial_days=0,'no extra trial days');
      perform pg_temp.check_true((select count(*)=0 from public.payments where tenant_id=v_tenant),'free service creates no payment');
      perform pg_temp.check_true((select count(*)=1 from public.platform_admin_audit_log where action='promotion_code.service_entitlement' and target_id=v_id::text),'one zero-payment entitlement audit');
    end if;
    if v_case.plan='starter' then
      perform pg_temp.check_true(v_sub.status='trialing' and v_sub.trial_ends_at-v_sub.trial_started_at=interval '30 days','Trial remains exactly30 days');
      perform pg_temp.check_true(v_sub.current_period_ends_at=v_sub.trial_ends_at,'Promo does not extend trial service period');
      if v_case.kind in ('service_days','free_months') then
        perform pg_temp.check_true((v_grant->>'starts_at')::timestamptz=v_sub.trial_ends_at,'Starter grant starts after exact 30-day Trial');
        perform pg_temp.check_true((v_grant->>'ends_at')::timestamptz=public.growup_promo_service_period_end(
          v_sub.trial_ends_at,case v_case.kind when 'service_days' then 'days' else 'months' end,v_case.value),'Starter grant end uses Bangkok calendar arithmetic');
      else
        -- Move ONLY this transaction-local disposable trial to an expired window.
        update public.subscriptions set trial_started_at='2026-07-01 10:00+07',trial_ends_at='2026-07-31 10:00+07',
          current_period_started_at='2026-07-01 10:00+07',current_period_ends_at='2026-07-31 10:00+07'
          where id=v_sub.id;
      end if;
    else
      perform pg_temp.check_true(v_sub.status='pending_payment' and v_sub.current_period_ends_at is null,'paid plan remains pending');
      if v_case.kind in ('service_days','free_months') then
        perform pg_temp.check_true((v_grant->>'starts_at')::timestamptz<=now() and (v_grant->>'starts_at')::timestamptz>now()-interval '5 minutes','Business free grant starts immediately');
      end if;
    end if;
    select * into v_before from public.subscriptions where id=v_sub.id;

    if v_case.kind in ('service_days','free_months') then
      perform pg_temp.check_true((select count(*)=0 from public.payments where tenant_id=v_tenant),'zero-payment path remains payment-free');
      perform pg_temp.check_true((select count(*)=1 from public.promotion_redemptions where promotion_code_id=v_id),'zero-payment redemption remains exactly once');
    elsif v_case.amount=0 then
      perform public.growup_activate_zero_amount_subscription_payment(v_tenant,v_user,'zero-'||v_user);
      select * into v_sub from public.subscriptions where tenant_id=v_tenant;
      perform pg_temp.check_true(v_sub.status='active','existing authoritative 100% zero-charge activation');
    else
      select * into v_payment from public.growup_begin_subscription_checkout(v_tenant,v_user,v_case.plan,'monthly',
        case when v_case.plan='starter' then 'subscription_renewal' else 'subscription_activation' end,'pay-'||v_user,'preview_fixture');
      perform pg_temp.check_true(v_payment.amount_minor=v_case.amount,'checkout amount unchanged');
      perform pg_temp.check_true((select status<>'active' from public.subscriptions where id=v_sub.id),'checkout cannot activate');
      -- Fixed billing dates on a test payment, no external provider/network action.
      update public.payments set billing_period_started_at='2026-08-31 10:00+07',billing_period_ends_at='2026-09-30 10:00+07'
        where id=v_payment.payment_id;
      begin
        perform public.growup_record_subscription_checkout_success('preview_fixture','bad-'||v_user,v_payment.payment_id,'ref-'||v_user,v_case.amount+1,'THB','{}');
        raise exception 'TEST_EXPECTED_REJECTION';
      exception when others then
        get stacked diagnostics v_error=message_text;
        perform pg_temp.check_true(v_error='SUBSCRIPTION_CHECKOUT_EVENT_MISMATCH','wrong payment amount denied');
      end;
      perform pg_temp.check_true((select status<>'active' from public.subscriptions where id=v_sub.id),'invalid payment cannot activate');
      perform public.growup_record_subscription_checkout_success('preview_fixture','paid-'||v_user,v_payment.payment_id,'ref-'||v_user,v_case.amount,'THB','{}');
      select * into v_sub from public.subscriptions where id=v_sub.id;
      v_expected := coalesce(v_case.expected_end,'2026-09-30 10:00+07'::timestamptz);
      perform pg_temp.check_true(v_sub.status='active' and v_sub.current_period_ends_at=v_expected,'exact entitled end '||v_case.label);
      perform pg_temp.check_true(v_sub.next_renewal_at=v_expected and v_sub.payment_due_at=v_expected,'same authoritative lifecycle end');
      perform pg_temp.check_true(v_sub.trial_ends_at is not distinct from v_before.trial_ends_at,'payment does not rewrite trial');
      -- Identical event and a different retry event must both remain idempotent.
      perform public.growup_record_subscription_checkout_success('preview_fixture','paid-'||v_user,v_payment.payment_id,'ref-'||v_user,v_case.amount,'THB','{}');
      perform public.growup_record_subscription_checkout_success('preview_fixture','retry-'||v_user,v_payment.payment_id,'ref-'||v_user,v_case.amount,'THB','{}');
      perform pg_temp.check_true((select current_period_ends_at=v_expected from public.subscriptions where id=v_sub.id),'no duplicate grant');
      select * into v_payment from public.growup_begin_subscription_checkout(v_tenant,v_user,v_case.plan,'monthly','subscription_renewal','renew-'||v_user,'preview_fixture');
      perform pg_temp.check_true(v_payment.billing_period_started_at=v_expected,'renewal starts after bonus, not before');
      perform public.growup_record_subscription_checkout_success('preview_fixture','renewed-'||v_user,v_payment.payment_id,'renewref-'||v_user,v_payment.amount_minor,'THB','{}');
      perform pg_temp.check_true((select current_period_ends_at=v_payment.billing_period_ends_at from public.subscriptions where id=v_sub.id),'renewal must not regrant bonus');
    end if;
    select count(distinct action) into v_audit from public.platform_admin_audit_log
      where target_id=v_id::text and action in('promotion_code.create','promotion_code.update','promotion_code.disable','promotion_code.reenable','promotion_code.redeem');
    perform pg_temp.check_true(v_audit=5,'CRUD and redemption audit');
    insert into promo_verification_results values(v_case.label,jsonb_build_object('passed',true,'kind',v_case.kind,'value',v_case.value,
      'plan',v_case.plan,'amount_minor',v_case.amount,'paid_base_end','2026-09-30T10:00:00+07:00','entitled_end',v_case.expected_end));
  end loop;

  -- Normal signup still receives30 days, and the old extra_trial_days type stays blocked.
  v_user := 'u_promo_qa_'||replace(gen_random_uuid()::text,'-','');
  select tenant_id into v_tenant from public.growup_signup_bootstrap('plain-'||v_user,v_user,v_user,current_setting('growup.test_password_hash'),
    'Disposable Preview','Disposable Preview','{}','','starter','monthly');
  perform pg_temp.check_true((select trial_ends_at-trial_started_at=interval '30 days'
    and not(promotion_snapshot ? 'service_entitlement') and not(promotion_snapshot ? 'zero_payment_entitlements')
    from public.subscriptions where tenant_id=v_tenant),'ordinary trial unchanged');
  -- Paid upgrades still require verified payment; a Starter-only bonus cannot
  -- be converted into Enterprise service or activate it during checkout.
  v_code := 'QA_'||upper(replace(gen_random_uuid()::text,'-',''));
  v_state := public.growup_platform_admin_save_promotion_code('u_admin',jsonb_build_object('code',v_code,
    'benefit_type','service_days','benefit_value',14,'applicable_plans',jsonb_build_array('starter'),
    'applicable_billing',jsonb_build_array('monthly')));
  v_user := 'u_promo_qa_'||replace(gen_random_uuid()::text,'-','');
  select tenant_id into v_tenant from public.growup_signup_bootstrap('up-'||v_user,v_user,v_user,current_setting('growup.test_password_hash'),
    'Disposable Preview','Disposable Preview','{}',v_code,'starter','monthly');
  select * into v_sub from public.subscriptions where tenant_id=v_tenant;
  select * into v_payment from public.growup_begin_subscription_checkout(v_tenant,v_user,'enterprise','monthly','subscription_upgrade','upgrade-'||v_user,'preview_fixture');
  perform pg_temp.check_true((select plan='starter' and status='trialing' and trial_ends_at-trial_started_at=interval '30 days' from public.subscriptions where id=v_sub.id),'upgrade checkout preserves trial and plan');
  perform public.growup_record_subscription_checkout_success('preview_fixture','up-paid-'||v_user,v_payment.payment_id,'up-ref-'||v_user,v_payment.amount_minor,'THB','{}');
  perform pg_temp.check_true((select plan='enterprise' and status='active' and current_period_ends_at=v_payment.billing_period_ends_at
    and jsonb_array_length(coalesce(promotion_snapshot->'zero_payment_entitlements','[]'::jsonb))=1
    and promotion_snapshot#>>'{zero_payment_entitlements,0,plan}'='starter'
    from public.subscriptions where id=v_sub.id),'verified upgrade preserves base Enterprise and does not reinterpret Starter grant');
  begin
    insert into public.subscriptions(tenant_id,plan,billing_interval,status,base_amount_minor,amount_due_minor,promotion_benefit_type,trial_started_at,trial_ends_at)
    values(v_tenant,'starter','monthly','trialing',49000,49000,'extra_trial_days',now(),now()+interval '44 days');
    raise exception 'TEST_EXPECTED_REJECTION';
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.check_true(v_error='PROMOTION_CODE_INVALID','legacy trial extension still rejected by original trigger');
  end;
  -- RPC validates the original numeric input before numeric(12,2) can round it.
  for v_case in select * from (values ('service_days',0::numeric),('service_days',0.01),('service_days',1.5),
    ('service_days',-1),('free_months',0),('free_months',0.5),('free_months',1.5),('percent_discount',101),
    ('fixed_amount_discount',0),('free_months','NaN'::numeric)) c(kind,value) loop
    begin
      perform public.growup_platform_admin_save_promotion_code('u_admin',jsonb_build_object('code','QA_INVALID',
        'benefit_type',v_case.kind,'benefit_value',v_case.value,'applicable_plans',jsonb_build_array('starter'),
        'applicable_billing',jsonb_build_array('monthly')));
      raise exception 'TEST_EXPECTED_REJECTION';
    exception when others then
      get stacked diagnostics v_error=message_text;
      perform pg_temp.check_true(v_error='INVALID_PROMOTION_CODE','invalid numeric amount rejected before storage');
    end;
  end loop;
  begin
    perform public.growup_platform_admin_save_promotion_code(v_user,jsonb_build_object('code','QA_DENIED'));
    raise exception 'TEST_EXPECTED_REJECTION';
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.check_true(v_error='PLATFORM_ADMIN_SUPER_ADMIN_REQUIRED','non-platform Owner denied');
  end;
  perform pg_temp.check_true(jsonb_array_length(public.growup_platform_admin_promo_list('u_admin',1,0)->'items')=1,'Promo pagination');
  perform pg_temp.check_true(jsonb_array_length(public.growup_platform_admin_promo_audit('u_admin',1,0)->'items')=1,'audit pagination');
  insert into promo_verification_results values('guards',jsonb_build_object('passed',true,'trial_cap_days',30,'calendar_timezone','Asia/Bangkok','customer_rpc_execute',false));
end;
$$;

select jsonb_agg(jsonb_build_object('case',case_name,'result',evidence)) as verification from promo_verification_results;
