"use strict";
// Opt-in real concurrent redemption test in the approved Preview ONLY.
// Leaves exactly one inactive, explicitly marked disposable tenant/user and a
// disabled hidden test Promo, preserving its audit/atomicity evidence.
// Free service is a separate zero-payment grant; the Trial stays exactly 30 days.
const { spawn } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const assert = require("assert/strict");
const { hashPassword, verifyPassword } = require("../lib/auth");
const root = path.resolve(__dirname,"..");
const project = "enwabsfsmwwcwwirdwok";
if (process.argv[2] !== "--verify-preview") throw new Error("Explicit --verify-preview required");
const password = crypto.randomBytes(32).toString("base64url");
const hash = hashPassword(password);
assert(verifyPassword(password,hash));
const nonce = crypto.randomUUID().replaceAll("-","");
const code = `QA_ATOMIC_${nonce.toUpperCase()}`;
function query(sql) {
  return new Promise((resolve,reject) => {
    const child = spawn("npx",["--no-install","supabase","db","query","--linked","--project-ref",project,"--file","/dev/stdin"],{cwd:root,stdio:["pipe","pipe","pipe"]});
    let output="";
    child.stdout.on("data",chunk=>{output+=chunk;});
    child.stderr.resume(); // CLI messages/SQL errors may contain parameters; never log them.
    child.on("error",()=>reject(new Error("Preview CLI failed")));
    child.on("close",status=>{
      if(status!==0) return reject(new Error("Preview query failed (sensitive diagnostics suppressed)"));
      try { resolve(JSON.parse(output.slice(output.indexOf("{"))).rows); }
      catch { reject(new Error("Preview returned an unexpected response")); }
    });
    child.stdin.end(sql);
  });
}
(async()=>{
  const setup = await query(`select public.growup_platform_admin_save_promotion_code('u_admin',jsonb_build_object(
    'code','${code}','description','[TEST DISPOSABLE VERIFIED SERVICE ENTITLEMENT ATOMIC]',
    'benefit_type','service_days','benefit_value',14,'applicable_plans',jsonb_build_array('starter'),
    'applicable_billing',jsonb_build_array('monthly'),'max_redemptions',1,'max_redemptions_per_tenant',1)) as result;`);
  const id=setup[0].result.promotion.id;
  assert.match(id,/^[0-9a-f-]{36}$/);
  let results;
  try {
    results=await Promise.all([0,1].map(index=>{
      const user=`u_promo_atomic_${nonce}_${index}`;
      return query(`begin; set local statement_timeout='30s';
        create temporary table outcome(result jsonb);
        do $$ declare t uuid; e text; begin
          select tenant_id into t from public.growup_signup_bootstrap('atomic-${user}','${user}','${user}','${hash}',
            'Disposable Preview','Preview Promo Atomic Test','{}','${code}','starter','monthly');
          update public.tenants set metadata=metadata||jsonb_build_object('is_test',true,'environment','preview','verification','promo_service_atomic') where id=t;
          update public.users set is_active=false where id='${user}';
          insert into outcome values(jsonb_build_object('accepted',true,'tenant_id',t,'user_id','${user}'));
        exception when others then
          get stacked diagnostics e=message_text;
          if e <> 'PROMOTION_CODE_EXHAUSTED' then raise; end if;
          insert into outcome values(jsonb_build_object('accepted',false,'reason',e));
        end; $$;
        commit; select result from outcome;`);
    }));
  } finally {
    await query(`select public.growup_platform_admin_set_promotion_status('u_admin','${id}'::uuid,false);`);
  }
  const outcomes=results.map(rows=>rows[0].result);
  assert.equal(outcomes.filter(row=>row.accepted).length,1,"exactly one concurrent signup may consume limit1");
  assert.equal(outcomes.filter(row=>row.reason==="PROMOTION_CODE_EXHAUSTED").length,1);
  const counts=await query(`select (select count(*) from public.promotion_redemptions where promotion_code_id='${id}'::uuid) as uses,
    (select count(*) from public.subscriptions where promotion_code_id='${id}'::uuid and trial_ends_at-trial_started_at=interval '30 days'
      and promotion_snapshot#>>'{zero_payment_entitlements,0,state}'='granted'
      and (promotion_snapshot#>>'{zero_payment_entitlements,0,starts_at}')::timestamptz=trial_ends_at) as capped_trial_zero_grant,
    (select active=false from public.promotion_codes where id='${id}'::uuid) as test_code_disabled;`);
  assert.equal(Number(counts[0].uses),1);
  assert.equal(Number(counts[0].capped_trial_zero_grant),1);
  assert.equal(counts[0].test_code_disabled,true);
  console.log(JSON.stringify({project,code,promoId:id,outcomes,counts:counts[0],passed:true},null,2));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
