create temporary table checkout_promo_results(case_name text, passed boolean);
create function pg_temp.assert_true(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'CHECKOUT_PROMO_TEST_FAILED: %',label; end if; end; $$;
create function pg_temp.customer() returns jsonb language plpgsql as $$
declare u text := 'u_checkout_qa_'||replace(gen_random_uuid()::text,'-',''); t uuid;
begin
  select tenant_id into t from public.growup_signup_bootstrap('signup-'||u,u,u,current_setting('growup.test_password_hash'),
    'Disposable Preview','Preview Checkout Promo Test','{}','','starter','monthly');
  -- Transaction-only expired trial fixture, never an existing customer.
  update public.subscriptions set trial_started_at=now()-interval '60 days',trial_ends_at=now()-interval '30 days',
    current_period_started_at=now()-interval '60 days',current_period_ends_at=now()-interval '30 days' where tenant_id=t;
  return jsonb_build_object('user',u,'tenant',t);
end; $$;

do $$
#variable_conflict use_column
declare
  c record; customer jsonb; other_customer jsonb; p jsonb; retry jsonb; promo jsonb;
  t uuid; u text; code text; v_promo_id uuid; pid uuid; sub public.subscriptions%rowtype;
  plan text; intent text; base integer; amount integer; before_end timestamptz; expected_end timestamptz;
  e text; terminal text; bad text; signup_user text;
begin
  perform pg_temp.assert_true((select md5(prosrc)='8784c55369e83e8cfeff54d405ba6576' from pg_proc where proname='growup_begin_subscription_checkout'),'existing checkout unchanged');
  perform pg_temp.assert_true((select md5(prosrc)='d34b958d51ed18aa12bf002f35f80aa3' from pg_proc where proname='growup_record_subscription_checkout_success'),'payment authority unchanged');
  perform pg_temp.assert_true(not has_function_privilege('authenticated','public.growup_begin_subscription_promo_checkout(uuid,text,text,text,text,text,text,text)','EXECUTE'),'customer direct RPC denied');
  perform pg_temp.assert_true(not has_table_privilege('anon','public.promotion_payment_reservations','SELECT'),'anon reservation access denied');
  perform pg_temp.assert_true((select relrowsecurity from pg_class where oid='public.promotion_payment_reservations'::regclass),'reservation RLS');

  for c in select * from (values
    ('percent_discount',10::numeric),('fixed_amount_discount',100)
  ) x(kind,value) loop
    foreach intent in array array['subscription_renewal','subscription_upgrade'] loop
      customer := pg_temp.customer(); t := (customer->>'tenant')::uuid; u := customer->>'user';
      plan := case intent when 'subscription_renewal' then 'starter' else 'business' end;
      base := public.growup_subscription_base_amount_minor(plan,'monthly');
      amount := case c.kind when 'percent_discount' then base*9/10 when 'fixed_amount_discount' then base-10000 else base end;
      code := 'QA_CHECKOUT_'||upper(replace(gen_random_uuid()::text,'-',''));
      promo := public.growup_platform_admin_save_promotion_code('u_admin',jsonb_build_object('code',code,
        'description','Preview rollback-only checkout verification','benefit_type',c.kind,'benefit_value',c.value,
        'applicable_plans',jsonb_build_array(plan),'applicable_billing',jsonb_build_array('monthly'),
        'max_redemptions',1,'max_redemptions_per_tenant',1));
      v_promo_id := (promo->'promotion'->>'id')::uuid;
      p := public.growup_begin_subscription_promo_checkout(t,u,plan,'monthly',intent,'checkout-'||u,'stripe_promptpay',lower(code));
      pid := (p->>'payment_id')::uuid;
      perform pg_temp.assert_true((p->>'amount_minor')::integer=amount,'server price '||c.kind||intent);
      perform pg_temp.assert_true((select count(*)=0 from public.promotion_redemptions where promotion_code_id=v_promo_id),'pending never redeemed');
      perform pg_temp.assert_true((select status<>'active' and plan='starter' from public.subscriptions where tenant_id=t),'no early activation/upgrade');
      perform pg_temp.assert_true((select count(*)=1 from public.promotion_payment_reservations where promotion_code_id=v_promo_id and state='reserved'),'one reservation');
      retry := public.growup_begin_subscription_promo_checkout(t,u,plan,'monthly',intent,'retry-'||u,'stripe_promptpay',code);
      perform pg_temp.assert_true(retry->>'payment_id'=p->>'payment_id','logical retry same payment');
      perform pg_temp.assert_true((select count(*)=1 from public.promotion_payment_reservations where promotion_code_id=v_promo_id),'retry no double reserve');
      begin
        perform public.growup_begin_subscription_promo_checkout(t,u,plan,'monthly',intent,'different-'||u,'stripe_promptpay','DIFFERENT');
        raise exception 'EXPECTED_REJECTION';
      exception when others then get stacked diagnostics e=message_text;
        perform pg_temp.assert_true(e='PROMOTION_CHECKOUT_CONFLICT','immutable code on pending payment');
      end;
      other_customer := pg_temp.customer();
      begin
        perform public.growup_begin_subscription_promo_checkout((other_customer->>'tenant')::uuid,other_customer->>'user',plan,'monthly',intent,'occupied-'||u,'stripe_promptpay',code);
        raise exception 'EXPECTED_REJECTION';
      exception when others then get stacked diagnostics e=message_text;
        perform pg_temp.assert_true(e='PROMOTION_CODE_EXHAUSTED','reservation counts toward limit');
      end;
      signup_user := 'u_signup_race_'||replace(gen_random_uuid()::text,'-','');
      begin
        perform public.growup_signup_bootstrap('signup-'||signup_user,signup_user,signup_user,current_setting('growup.test_password_hash'),
          'Disposable Preview','Preview Reservation Conflict','{}',code,plan,'monthly');
        raise exception 'EXPECTED_REJECTION';
      exception when others then get stacked diagnostics e=message_text;
        perform pg_temp.assert_true(e='PROMOTION_CODE_EXHAUSTED','Signup respects reserved capacity');
      end;
      select billing_period_ends_at into before_end from public.payments where id=pid;
      begin
        perform public.growup_record_subscription_checkout_success('stripe_promptpay','bad-'||u,pid,'pi_qa_'||u,amount+1,'THB','{}');
        raise exception 'EXPECTED_REJECTION';
      exception when others then get stacked diagnostics e=message_text;
        perform pg_temp.assert_true(e='SUBSCRIPTION_CHECKOUT_EVENT_MISMATCH','wrong payment amount denied');
      end;
      perform pg_temp.assert_true((select state='reserved' from public.promotion_payment_reservations where payment_id=pid),'bad webhook cannot redeem');
      perform public.growup_record_subscription_checkout_success('stripe_promptpay','paid-'||u,pid,'pi_qa_'||u,amount,'THB','{}');
      perform public.growup_record_subscription_checkout_success('stripe_promptpay','paid-'||u,pid,'pi_qa_'||u,amount,'THB','{}');
      perform public.growup_record_subscription_checkout_success('stripe_promptpay','paid-repeat-'||u,pid,'pi_qa_'||u,amount,'THB','{}');
      expected_end := case c.kind when 'service_days' then public.growup_promo_service_period_end(before_end,'days',14)
        when 'free_months' then public.growup_promo_service_period_end(before_end,'months',1) else before_end end;
      select * into sub from public.subscriptions where tenant_id=t;
      perform pg_temp.assert_true(sub.status='active' and sub.plan=plan and sub.current_period_ends_at=expected_end,'paid entitlement '||c.kind||intent);
      perform pg_temp.assert_true(sub.trial_ends_at-sub.trial_started_at=interval '30 days','Trial unchanged');
      perform pg_temp.assert_true((select count(*)=1 from public.promotion_redemptions where payment_id=pid),'exactly one redemption');
      perform pg_temp.assert_true((select count(*)=1 from public.platform_admin_audit_log where target_id=v_promo_id::text and action='promotion_code.redeem'),'exactly one audit');
      update public.subscriptions set updated_at=now() where id=sub.id;
      perform pg_temp.assert_true((select current_period_ends_at=expected_end from public.subscriptions where id=sub.id),'unrelated update cannot regrant');
      insert into checkout_promo_results values(c.kind||'/'||intent,true);
    end loop;
  end loop;

  foreach terminal in array array['failed','cancelled','expired'] loop
    customer := pg_temp.customer(); t := (customer->>'tenant')::uuid; u := customer->>'user';
    code := 'QA_RELEASE_'||upper(replace(gen_random_uuid()::text,'-',''));
    promo := public.growup_platform_admin_save_promotion_code('u_admin',jsonb_build_object('code',code,'benefit_type','percent_discount',
      'benefit_value',10,'applicable_plans',jsonb_build_array('starter'),'applicable_billing',jsonb_build_array('monthly'),'max_redemptions',1));
    v_promo_id := (promo->'promotion'->>'id')::uuid;
    p := public.growup_begin_subscription_promo_checkout(t,u,'starter','monthly','subscription_renewal','checkout-'||u,'stripe_promptpay',code);
    pid := (p->>'payment_id')::uuid;
    perform public.growup_set_payment_provider_reference(pid,t,'stripe_promptpay','pi_qa_'||u,'pending','{}');
    if terminal <> 'cancelled' then
      begin
        perform public.growup_record_provider_payment_status('stripe_promptpay','unconfirmed-'||u,pid,'pi_qa_'||u,(p->>'amount_minor')::integer,'THB',terminal,'{}');
        raise exception 'EXPECTED_REJECTION';
      exception when others then get stacked diagnostics e=message_text;
        perform pg_temp.assert_true(e='PROMOTION_PAYMENT_TERMINAL_UNCONFIRMED','cannot release before Stripe cancellation');
      end;
    end if;
    perform public.growup_release_canceled_promo_payment(pid,t,'pi_qa_'||u,(p->>'amount_minor')::integer,'THB','cancel-'||u);
    perform public.growup_release_canceled_promo_payment(pid,t,'pi_qa_'||u,(p->>'amount_minor')::integer,'THB','cancel-retry-'||u);
    perform pg_temp.assert_true((select state='released' from public.promotion_payment_reservations where payment_id=pid),'release '||terminal);
    perform pg_temp.assert_true((select count(*)=0 from public.promotion_redemptions where promotion_code_id=v_promo_id),'failed not redeemed');
    perform pg_temp.assert_true((select status<>'active' from public.subscriptions where tenant_id=t),'failure cannot activate');
    retry := public.growup_begin_subscription_promo_checkout(t,u,'starter','monthly','subscription_renewal','retry-'||u,'stripe_promptpay',code);
    perform pg_temp.assert_true(retry->>'payment_id'<>p->>'payment_id','terminal retry creates new reservation');
    insert into checkout_promo_results values('release/'||terminal,true);
  end loop;

  foreach bad in array array['disabled','expired','future','wrong_plan','new_customer','zero','minimum','per_tenant'] loop
    customer := pg_temp.customer(); t := (customer->>'tenant')::uuid; u := customer->>'user';
    code := 'QA_INVALID_'||upper(replace(gen_random_uuid()::text,'-',''));
    promo := public.growup_platform_admin_save_promotion_code('u_admin',jsonb_build_object('code',code,'benefit_type','percent_discount',
      'benefit_value',case bad when 'zero' then 100 when 'minimum' then 99 else 10 end,'applicable_plans',jsonb_build_array(case bad when 'wrong_plan' then 'enterprise' else 'starter' end),
      'applicable_billing',jsonb_build_array('monthly'),'active',bad<>'disabled','new_customer_only',bad='new_customer',
      'starts_at',case bad when 'future' then now()+interval '1 day' else null end,
      'ends_at',case bad when 'expired' then now()-interval '1 day' else null end,'max_redemptions_per_tenant',1));
    v_promo_id := (promo->'promotion'->>'id')::uuid;
    if bad='per_tenant' then
      insert into public.promotion_redemptions(promotion_code_id,tenant_id,selected_plan,selected_billing,benefit_type,benefit_value,benefit_description)
      values(v_promo_id,t,'starter','monthly','percent_discount',10,'Disposable Preview previous redemption');
    end if;
    begin
      perform public.growup_begin_subscription_promo_checkout(t,u,'starter','monthly','subscription_renewal','invalid-'||u,'stripe_promptpay',code);
      raise exception 'EXPECTED_REJECTION';
    exception when others then get stacked diagnostics e=message_text;
      perform pg_temp.assert_true(e=case bad when 'expired' then 'PROMOTION_CODE_EXPIRED' when 'future' then 'PROMOTION_CODE_EXPIRED'
        when 'new_customer' then 'PROMOTION_CODE_NEW_CUSTOMERS_ONLY' when 'zero' then 'PROMOTION_CHECKOUT_POSITIVE_PAYMENT_REQUIRED'
        when 'minimum' then 'PROMOTION_CHECKOUT_STRIPE_MINIMUM' when 'per_tenant' then 'PROMOTION_CODE_EXHAUSTED' else 'PROMOTION_CODE_INVALID' end,'invalid/'||bad||'/'||e);
    end;
    perform pg_temp.assert_true((select count(*)=0 from public.payments where tenant_id=t),'invalid checkout rolled back');
    insert into checkout_promo_results values('invalid/'||bad,true);
  end loop;
end; $$;
select jsonb_agg(to_jsonb(r) order by case_name) as checkout_promo_results from checkout_promo_results r;
