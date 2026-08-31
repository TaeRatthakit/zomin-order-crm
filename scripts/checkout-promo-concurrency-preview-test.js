"use strict";

// Explicit opt-in, hard-pinned Preview concurrency proof. No Stripe/LINE call.
// Disposable tenants are marked Preview/test and users are deactivated afterward.
const { spawn } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const assert = require("assert/strict");
const { hashPassword, verifyPassword } = require("../lib/auth");

const root = path.resolve(__dirname, "..");
const project = "enwabsfsmwwcwwirdwok";
if (process.argv[2] !== "--verify-preview") throw new Error("Explicit --verify-preview required");

const password = crypto.randomBytes(32).toString("base64url");
const passwordHash = hashPassword(password);
assert(verifyPassword(password, passwordHash));
const nonce = crypto.randomUUID().replaceAll("-", "");
const users = [0, 1].map(index => `u_checkout_concurrency_${nonce}_${index}`);
const monetaryCode = `QA_CHECKOUT_${nonce.toUpperCase()}`;
const freeCode = `QA_FREE_${nonce.toUpperCase()}`;

function query(sql, stage = "query") {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["--no-install", "supabase", "db", "query", "--linked", "--project-ref", project, "--file", "/dev/stdin"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.resume();
    child.on("error", () => reject(new Error(`Preview CLI failed at ${stage}`)));
    child.on("close", status => {
      if (status !== 0) return reject(new Error(`Preview query failed at ${stage} (sensitive diagnostics suppressed)`));
      try { resolve(JSON.parse(output.slice(output.indexOf("{"))).rows); }
      catch { reject(new Error(`Preview returned an unexpected response at ${stage}`)); }
    });
    child.stdin.end(sql);
  });
}

function concurrentCheckoutSql(tenantId, userId, code, index) {
  return `begin; set local statement_timeout='30s';
    create temporary table outcome(result jsonb);
    do $$ declare r jsonb; e text; begin
      r:=public.growup_begin_subscription_promo_checkout('${tenantId}'::uuid,'${userId}','business','monthly',
        'subscription_upgrade','checkout-${nonce}-${index}','stripe_promptpay','${code}');
      insert into outcome values(jsonb_build_object('accepted',true,'payment_id',r->>'payment_id'));
    exception when others then
      get stacked diagnostics e=message_text;
      if e<>'PROMOTION_CODE_EXHAUSTED' then raise; end if;
      insert into outcome values(jsonb_build_object('accepted',false,'reason',e));
    end; $$;
    commit; select result from outcome;`;
}

function concurrentRedeemSql(tenantId, userId, code, index) {
  return `begin; set local statement_timeout='30s';
    create temporary table outcome(result jsonb);
    do $$ declare q jsonb; r jsonb; e text; begin
      q:=public.growup_quote_checkout_promotion('${tenantId}'::uuid,'${userId}','${code}','starter','monthly');
      r:=public.growup_redeem_zero_payment_promo('${tenantId}'::uuid,'${userId}','${code}','starter','monthly',
        md5('zero-${nonce}-${index}')||md5('grant-${nonce}-${index}'),q->>'definition_version');
      insert into outcome values(jsonb_build_object('accepted',true,'redemption_id',r#>>'{grant,redemption_id}'));
    exception when others then
      get stacked diagnostics e=message_text;
      if e<>'PROMOTION_CODE_EXHAUSTED' then raise; end if;
      insert into outcome values(jsonb_build_object('accepted',false,'reason',e));
    end; $$;
    commit; select result from outcome;`;
}

(async () => {
  const setupRows = await query(`begin;
    create temporary table setup_result(result jsonb);
    do $$ declare t0 uuid; t1 uuid; p0 uuid; p1 uuid; begin
      select tenant_id into t0 from public.growup_signup_bootstrap('setup-${nonce}-0','${users[0]}','${users[0]}','${passwordHash}',
        'Disposable Preview','Preview Promo Checkout Concurrency','{}','','starter','monthly');
      select tenant_id into t1 from public.growup_signup_bootstrap('setup-${nonce}-1','${users[1]}','${users[1]}','${passwordHash}',
        'Disposable Preview','Preview Promo Checkout Concurrency','{}','','starter','monthly');
      update public.tenants set metadata=metadata||jsonb_build_object('is_test',true,'environment','preview','verification','checkout_promo_concurrency')
        where id in(t0,t1);
      update public.subscriptions set status='active',current_period_started_at=now()-interval '1 day',
        current_period_ends_at=now()+interval '29 days',next_renewal_at=now()+interval '29 days',payment_due_at=now()+interval '29 days'
        where tenant_id in(t0,t1);
      p0:=(public.growup_platform_admin_save_promotion_code('u_admin',jsonb_build_object(
        'code','${monetaryCode}','description','[TEST DISPOSABLE VERIFIED CHECKOUT CONCURRENCY]',
        'benefit_type','percent_discount','benefit_value',10,'applicable_plans',jsonb_build_array('business'),
        'applicable_billing',jsonb_build_array('monthly'),'max_redemptions',1,'max_redemptions_per_tenant',1))->'promotion'->>'id')::uuid;
      p1:=(public.growup_platform_admin_save_promotion_code('u_admin',jsonb_build_object(
        'code','${freeCode}','description','[TEST DISPOSABLE VERIFIED ZERO CONCURRENCY]',
        'benefit_type','service_days','benefit_value',7,'applicable_plans',jsonb_build_array('starter'),
        'applicable_billing',jsonb_build_array('monthly'),'max_redemptions',1,'max_redemptions_per_tenant',1))->'promotion'->>'id')::uuid;
      insert into setup_result values(jsonb_build_object('tenant_ids',jsonb_build_array(t0,t1),'promo_ids',jsonb_build_array(p0,p1)));
    end; $$;
    commit; select result from setup_result;`, "setup");
  const tenantIds = setupRows[0].result.tenant_ids;
  const promoIds = setupRows[0].result.promo_ids;
  assert.equal(tenantIds.length, 2);

  let checkoutOutcomes;
  let zeroOutcomes;
  try {
    checkoutOutcomes = (await Promise.all(tenantIds.map((tenantId, index) =>
      query(concurrentCheckoutSql(tenantId, users[index], monetaryCode, index), `checkout-${index}`)
    ))).map(rows => rows[0].result);
    assert.equal(checkoutOutcomes.filter(row => row.accepted).length, 1, "exactly one concurrent checkout may reserve total limit 1");
    assert.equal(checkoutOutcomes.filter(row => row.reason === "PROMOTION_CODE_EXHAUSTED").length, 1);

    zeroOutcomes = (await Promise.all(tenantIds.map((tenantId, index) =>
      query(concurrentRedeemSql(tenantId, users[index], freeCode, index), `zero-${index}`)
    ))).map(rows => rows[0].result);
    assert.equal(zeroOutcomes.filter(row => row.accepted).length, 1, "exactly one concurrent zero-payment redemption may consume total limit 1");
    assert.equal(zeroOutcomes.filter(row => row.reason === "PROMOTION_CODE_EXHAUSTED").length, 1);
  } finally {
    await query(`begin;
      update public.payments set provider_metadata=coalesce(provider_metadata,'{}'::jsonb)||jsonb_build_object('last_provider_status','cancelled'),
        status='cancelled' where tenant_id in('${tenantIds[0]}'::uuid,'${tenantIds[1]}'::uuid) and status='pending'
        and checkout_metadata#>>'{promotion,code}'='${monetaryCode}' and provider_payment_reference is null;
      select public.growup_platform_admin_set_promotion_status('u_admin','${promoIds[0]}'::uuid,false);
      select public.growup_platform_admin_set_promotion_status('u_admin','${promoIds[1]}'::uuid,false);
      update public.users set is_active=false where id in('${users[0]}','${users[1]}');
      commit;`, "cleanup");
  }

  const verify = await query(`select jsonb_build_object(
    'monetary_reserved',(select count(*) from public.promotion_payment_reservations where promotion_code_id='${promoIds[0]}'::uuid),
    'monetary_released',(select count(*) from public.promotion_payment_reservations where promotion_code_id='${promoIds[0]}'::uuid and state='released'),
    'monetary_redemptions',(select count(*) from public.promotion_redemptions where promotion_code_id='${promoIds[0]}'::uuid),
    'zero_redemptions',(select count(*) from public.promotion_redemptions where promotion_code_id='${promoIds[1]}'::uuid),
    'zero_audits',(select count(*) from public.platform_admin_audit_log where target_id='${promoIds[1]}' and action='promotion_code.service_entitlement'),
    'promos_disabled',(select count(*) from public.promotion_codes where id in('${promoIds[0]}'::uuid,'${promoIds[1]}'::uuid) and active=false),
    'users_inactive',(select count(*) from public.users where id in('${users[0]}','${users[1]}') and is_active=false)
  ) as evidence;`, "verify");
  const evidence = verify[0].evidence;
  assert.equal(Number(evidence.monetary_reserved), 1);
  assert.equal(Number(evidence.monetary_released), 1);
  assert.equal(Number(evidence.monetary_redemptions), 0);
  assert.equal(Number(evidence.zero_redemptions), 1);
  assert.equal(Number(evidence.zero_audits), 1);
  assert.equal(Number(evidence.promos_disabled), 2);
  assert.equal(Number(evidence.users_inactive), 2);
  console.log(JSON.stringify({ project, checkoutOutcomes, zeroOutcomes, evidence, passed: true }, null, 2));
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
