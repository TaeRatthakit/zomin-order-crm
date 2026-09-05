create temporary table zero_promo_results(case_name text, evidence jsonb);
do $$
declare c record; customer jsonb; t uuid; u text; code text; promo jsonb; quote jsonb; result jsonb; again jsonb;
  before_sub jsonb; after_sub jsonb; g jsonb; promo_id uuid; key text; signup_user text; signup_tenant uuid; sub public.subscriptions%rowtype;
  plan text; e text; other jsonb;
begin
  for c in select * from (values ('service_days',14),('free_months',1)) x(kind,value) loop
    foreach plan in array array['starter','business'] loop
      customer:=pg_temp.customer(); t:=(customer->>'tenant')::uuid; u:=customer->>'user';
      code:='QA_ZERO_'||upper(replace(gen_random_uuid()::text,'-','')); key:=md5(code)||md5(u);
      promo:=public.growup_platform_admin_save_promotion_code('u_admin',jsonb_build_object('code',code,'benefit_type',c.kind,'benefit_value',c.value,
        'applicable_plans',jsonb_build_array(plan),'applicable_billing',jsonb_build_array('monthly'),'max_redemptions',1,'max_redemptions_per_tenant',1));
      promo_id:=(promo->'promotion'->>'id')::uuid;
      select to_jsonb(s)-'promotion_snapshot'-'updated_at' into before_sub from public.subscriptions s where tenant_id=t;
      quote:=public.growup_quote_checkout_promotion(t,u,code,plan,'monthly');
      perform pg_temp.assert_true(quote->>'mode'='free_service' and (quote->>'amount_minor')::integer=0,'zero quote');
      result:=public.growup_redeem_zero_payment_promo(t,u,code,plan,'monthly',key,quote->>'definition_version');
      g:=result->'grant';
      perform pg_temp.assert_true(g->>'plan'=plan and g->>'unit'=case c.kind when 'service_days' then 'days' else 'months' end,'correct target/units');
      perform pg_temp.assert_true((g->>'ends_at')::timestamptz=public.growup_promo_service_period_end(now(),g->>'unit',c.value),'exact Bangkok expiry');
      again:=public.growup_redeem_zero_payment_promo(t,u,code,plan,'monthly',key,quote->>'definition_version');
      perform pg_temp.assert_true(again->'grant'=g and (again->>'reused')::boolean,'retry same grant');
      again:=public.growup_redeem_zero_payment_promo(t,u,code,plan,'monthly',md5(key)||md5('refresh'),quote->>'definition_version');
      perform pg_temp.assert_true(again->'grant'=g,'browser refresh cannot extend with new key');
      select to_jsonb(s)-'promotion_snapshot'-'updated_at' into after_sub from public.subscriptions s where tenant_id=t;
      perform pg_temp.assert_true(before_sub=after_sub,'ALL base subscription fields preserved');
      perform pg_temp.assert_true((select count(*)=0 from public.payments where tenant_id=t),'NO payment/PaymentIntent row');
      perform pg_temp.assert_true((select count(*)=0 from public.promotion_payment_reservations where tenant_id=t),'NO payment reservation for free service');
      perform pg_temp.assert_true((select count(*)=1 from public.promotion_redemptions where promotion_code_id=promo_id),'exactly one use');
      perform pg_temp.assert_true((select count(*)=1 from public.platform_admin_audit_log where target_id=promo_id::text and action='promotion_code.redeem'),'exactly one redemption audit');
      perform pg_temp.assert_true((select count(*)=1 from public.platform_admin_audit_log where target_id=promo_id::text and action='promotion_code.service_entitlement'),'exactly one grant audit');
      other:=pg_temp.customer();
      begin
        perform public.growup_quote_checkout_promotion((other->>'tenant')::uuid,other->>'user',code,plan,'monthly');
        raise exception 'EXPECTED_REJECTION';
      exception when others then get stacked diagnostics e=message_text;
        perform pg_temp.assert_true(e='PROMOTION_CODE_EXHAUSTED','exhausted after free grant');
      end;
      insert into zero_promo_results values(c.kind||'/'||plan,jsonb_build_object('passed',true,'start',g->>'starts_at','end',g->>'ends_at','base_unchanged',true,'payments',0,'uses',1));
    end loop;
    foreach plan in array array['starter','business'] loop
      code:='QA_ZERO_SIGNUP_'||upper(replace(gen_random_uuid()::text,'-',''));
      promo:=public.growup_platform_admin_save_promotion_code('u_admin',jsonb_build_object('code',code,'benefit_type',c.kind,'benefit_value',c.value,
        'applicable_plans',jsonb_build_array(plan),'applicable_billing',jsonb_build_array('monthly'),'new_customer_only',true,'max_redemptions',1));
      signup_user:='u_zero_signup_'||replace(gen_random_uuid()::text,'-','');
      select tenant_id into signup_tenant from public.growup_signup_bootstrap('signup-'||signup_user,signup_user,signup_user,current_setting('growup.test_password_hash'),
        'Disposable Preview','Preview Zero Service Signup','{}',code,plan,'monthly');
      select * into sub from public.subscriptions where tenant_id=signup_tenant;
      g:=sub.promotion_snapshot->'zero_payment_entitlements'->0;
      perform pg_temp.assert_true(g->>'source'='promotion_zero_payment','Signup same entitlement model');
      perform pg_temp.assert_true(sub.extra_trial_days=0 and not(sub.promotion_snapshot ? 'service_entitlement'),'no legacy paid-bonus/extra Trial');
      perform pg_temp.assert_true(sub.status='pending_payment' and sub.trial_started_at is null and sub.trial_ends_at is null,
        'signup is paid-first with no automatic trial');
      perform pg_temp.assert_true((g->>'starts_at')::timestamptz<=now() and (g->>'starts_at')::timestamptz>now()-interval '5 minutes',
        'free access starts immediately');
      perform pg_temp.assert_true((select count(*)=0 from public.payments where tenant_id=signup_tenant),'Signup no fake payment');
      insert into zero_promo_results values('signup/'||c.kind||'/'||plan,jsonb_build_object('passed',true,'start',g->>'starts_at','end',g->>'ends_at','payments',0));
    end loop;
  end loop;
  perform pg_temp.assert_true(public.growup_promo_service_period_end('2027-01-31 10:00+07','months',1)='2027-02-28 10:00+07'::timestamptz,'calendar month not 30 days');
  perform pg_temp.assert_true(not has_function_privilege('authenticated','public.growup_redeem_zero_payment_promo(uuid,text,text,text,text,text,text)','EXECUTE'),'direct user RPC denied');
end; $$;

-- Invalid/authorization/immutable-quote cases for the zero-payment path.
do $$
declare bad text; customer jsonb; t uuid; u text; code text; promo jsonb; promo_id uuid;
  quote jsonb; e text; invalid_count integer;
begin
  foreach bad in array array['disabled','expired','future','wrong_plan','new_customer'] loop
    customer:=pg_temp.customer(); t:=(customer->>'tenant')::uuid; u:=customer->>'user';
    code:='QA_ZERO_INVALID_'||upper(replace(gen_random_uuid()::text,'-',''));
    promo:=public.growup_platform_admin_save_promotion_code('u_admin',jsonb_build_object('code',code,
      'benefit_type','service_days','benefit_value',14,
      'applicable_plans',jsonb_build_array(case bad when 'wrong_plan' then 'enterprise' else 'starter' end),
      'applicable_billing',jsonb_build_array('monthly'),'active',bad<>'disabled',
      'new_customer_only',bad='new_customer',
      'starts_at',case bad when 'future' then now()+interval '1 day' else null end,
      'ends_at',case bad when 'expired' then now()-interval '1 day' else null end));
    promo_id:=(promo->'promotion'->>'id')::uuid;
    begin
      perform public.growup_quote_checkout_promotion(t,u,code,'starter','monthly');
      raise exception 'EXPECTED_REJECTION';
    exception when others then get stacked diagnostics e=message_text;
      perform pg_temp.assert_true(e=case when bad in ('expired','future') then 'PROMOTION_CODE_EXPIRED'
        when bad='new_customer' then 'PROMOTION_CODE_NEW_CUSTOMERS_ONLY' else 'PROMOTION_CODE_INVALID' end,'zero invalid/'||bad||'/'||e);
    end;
    perform pg_temp.assert_true((select count(*)=0 from public.promotion_redemptions where promotion_code_id=promo_id),'invalid zero consumes no quota');
  end loop;

  customer:=pg_temp.customer(); t:=(customer->>'tenant')::uuid; u:=customer->>'user';
  update public.tenant_memberships set role='Admin' where tenant_id=t and user_id=u;
  begin
    perform public.growup_quote_checkout_promotion(t,u,'ANYCODE','starter','monthly');
    raise exception 'EXPECTED_REJECTION';
  exception when others then get stacked diagnostics e=message_text;
    perform pg_temp.assert_true(e='SUBSCRIPTION_CHECKOUT_OWNER_REQUIRED','Admin cannot quote/redeem free service');
  end;

  customer:=pg_temp.customer(); t:=(customer->>'tenant')::uuid; u:=customer->>'user';
  code:='QA_ZERO_CHANGED_'||upper(replace(gen_random_uuid()::text,'-',''));
  promo:=public.growup_platform_admin_save_promotion_code('u_admin',jsonb_build_object('code',code,'benefit_type','free_months','benefit_value',1,
    'applicable_plans',jsonb_build_array('starter'),'applicable_billing',jsonb_build_array('monthly'),'max_redemptions',2));
  promo_id:=(promo->'promotion'->>'id')::uuid;
  quote:=public.growup_quote_checkout_promotion(t,u,code,'starter','monthly');
  update public.promotion_codes set benefit_value=2 where id=promo_id;
  begin
    perform public.growup_redeem_zero_payment_promo(t,u,code,'starter','monthly',md5(code)||md5(u),quote->>'definition_version');
    raise exception 'EXPECTED_REJECTION';
  exception when others then get stacked diagnostics e=message_text;
    perform pg_temp.assert_true(e='PROMOTION_QUOTE_CHANGED','changed authoritative definition rejects stale quote');
  end;
  select count(*) into invalid_count from public.promotion_redemptions where promotion_code_id=promo_id;
  perform pg_temp.assert_true(invalid_count=0,'stale quote consumes no quota');
end; $$;
select jsonb_build_object('monetary',(select jsonb_agg(to_jsonb(r)) from checkout_promo_results r),
  'zero_payment',(select jsonb_agg(to_jsonb(r)) from zero_promo_results r)) as results;
