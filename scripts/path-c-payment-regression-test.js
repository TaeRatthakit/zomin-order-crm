"use strict";
// Verification-only: reuse the reviewed mock transport, real handler and real
// Supabase adapter from the exact candidate. No network or Production writes.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = process.env.TASK5_TEST_SOURCE_ROOT || path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'scripts/payment-state-machine-test.js'), 'utf8');
const marker = 'if (!process.env.TASK5_TEST_SERVE) (async () => {';
if (!source.includes(marker)) throw new Error('Reviewed harness changed');
const tests = String.raw`
(async () => {
  const pristine = structuredClone(db);
  const results = [];
  let injectGetFailure = false;
  const transport = global.fetch;
  global.fetch = async (input, options = {}) => {
    const u = new URL(String(input));
    const method = String(options.method || 'GET').toUpperCase();
    if (u.hostname === 'api.stripe.com' && process.env.VERCEL_ENV === 'production' && method !== 'GET')
      throw new Error('LIVE_MUTATION_FORBIDDEN_BY_VERIFIER');
    if (injectGetFailure && u.hostname === 'api.stripe.com' && method === 'GET')
      return jsonResponse({error:{message:'transient failure',code:'api_connection_error'}},500);
    return transport(input, options);
  };
  async function call(c, target = 'enterprise') {
    return request(target === 'enterprise' ? '/api/billing/upgrade' : '/api/billing/checkout', {
      method:'POST',headers:{cookie:c},body:JSON.stringify({targetPlan:target,billingInterval:'monthly',confirmReplacement:true})});
  }
  async function fixture(name, alter, expected, target = 'enterprise') {
    for (const key of Object.keys(db)) db[key] = structuredClone(pristine[key]);
    stripeIntents.clear(); stripeCreateRequests.length=0; stripeCancelRequests.length=0;
    stripeRetrieveRequests.length=0; injectGetFailure=false; process.env.VERCEL_ENV='preview';
    process.env.SUPABASE_URL='https://subscription-upgrade-test.supabase.co';
    const c = await login('failure@example.com');
    const p = await checkout(c,'business');
    const a = db.subscription_upgrade_attempts.find(x=>x.payment_id===p.id);
    const intent = stripeIntents.get(p.provider_payment_reference);
    await alter({c,p,a,intent});
    const subscriptionBefore = JSON.stringify(db.subscriptions);
    const createdBefore = stripeCreateRequests.length;
    const cancelBefore = stripeCancelRequests.length;
    const requestCookie = process.env.VERCEL_ENV === 'production' ? await login('failure@example.com') : c;
    const response = await call(requestCookie,target);
    const row = {name,status:response.status,code:response.json().code||null,
      created:stripeCreateRequests.length-createdBefore,canceled:stripeCancelRequests.length-cancelBefore,
      paymentStatus:p.status,attemptStatus:a.status,
      thaiError:response.text.includes('รายการเดิมยังตรวจสอบเพื่อเริ่มรายการใหม่ไม่ได้')};
    results.push(row); console.log('PATH_C_CASE',JSON.stringify(row));
    assert.equal(response.status,expected.status,name);
    if (expected.created != null) assert.equal(row.created,expected.created,name+' create');
    if (expected.canceled != null) assert.equal(row.canceled,expected.canceled,name+' cancel');
    if (expected.code) assert.equal(row.code,expected.code,name+' code');
    assert.equal(JSON.stringify(db.subscriptions),subscriptionBefore,name+' subscription changed without verified success');
    if (expected.resume) assert.equal(response.json().payment.id,p.id,name+' resumed different payment');
    process.env.VERCEL_ENV='preview'; injectGetFailure=false;
  }
  async function terminal({p,a,intent},status,stale) {
    const raw={id:'evt_path_c_'+status,type:status==='failed'?'payment_intent.payment_failed':'payment_intent.canceled',livemode:false,
      data:{object:{...intent,status:status==='failed'?'requires_payment_method':'canceled',next_action:undefined}}};
    assert.equal((await postWebhook(JSON.stringify(raw))).status,200);
    if(stale) a.status='pending';
  }
  await fixture('failed payment + stale pending attempt',x=>terminal(x,'failed',true),{status:200,created:1,canceled:0});
  await fixture('cancelled payment + stale pending attempt',x=>terminal(x,'cancelled',true),{status:200,created:1,canceled:0});
  await fixture('terminal payment + closed attempt',x=>terminal(x,'failed',false),{status:200,created:1,canceled:0});
  await fixture('missing Stripe object / uncertain local',({intent})=>stripeIntents.delete(intent.id),{status:502,created:0,canceled:0});
  await fixture('Stripe GET transient failure',()=>{injectGetFailure=true;},{status:500,created:0,canceled:0});
  await fixture('active same-context pending resume',()=>{},{status:200,created:0,canceled:0,resume:true},'business');
  await fixture('processing provider outcome',({intent})=>{intent.status='processing';},{status:409,created:0,canceled:0});
  await fixture('succeeded provider outcome',({intent})=>{intent.status='succeeded';intent.amount_received=intent.amount;},{status:409,created:0,canceled:0});
  await fixture('package mismatch TEST explicit confirmed',()=>{},{status:200,created:1,canceled:1});
  await fixture('billing-period metadata mismatch',({intent})=>{intent.metadata.growup_billing_period_ends_at='2027-01-01T00:00:00.000Z';},{status:409,created:0,canceled:0});
  await fixture('Stripe amount mismatch',({intent})=>{intent.amount+=100;},{status:409,created:0,canceled:0});
  await fixture('Stripe currency mismatch',({intent})=>{intent.currency='usd';},{status:409,created:0,canceled:0});
  await fixture('multiple candidate ambiguity',({p,a,intent})=>{
    const other=structuredClone(p);other.id=crypto.randomUUID();other.provider_payment_reference='pi_pathc_ambiguous';
    other.idempotency_key+='-second'; db.payments.push(other);
    const oa=structuredClone(a);oa.id=crypto.randomUUID();oa.payment_id=other.id;oa.provider_payment_reference=other.provider_payment_reference;
    oa.idempotency_key=other.idempotency_key;db.subscription_upgrade_attempts.push(oa);
    stripeIntents.set(other.provider_payment_reference,{...structuredClone(intent),id:other.provider_payment_reference,
      metadata:{...intent.metadata,growup_payment_id:other.id}});
  },{status:409,created:0,canceled:0});
  await fixture('cross-tenant attempt linkage',({a})=>{a.payment_id='foreign_payment';
    db.payments.push({id:'foreign_payment',tenant_id:ids.starter,status:'pending',plan:'business',amount_minor:99000,currency:'THB',provider:'stripe_promptpay'});
  },{status:409,created:0,canceled:0});
  await fixture('Owner incident active Business -> Enterprise LIVE',({intent})=>{
    process.env.STRIPE_LIVE_SECRET_KEY='sk_live_mock_only';process.env.VERCEL_ENV='production';intent.livemode=true;
    // Host assertion only: all fetches remain intercepted by the fixture.
    process.env.SUPABASE_URL='https://mjnpzdmrqweugdnvlqwq.supabase.co';
  },{status:409,created:0,canceled:0,code:'REPLACEMENT_PAYMENT_NOT_SAFE'});
  console.log('PATH_C_MATRIX_PASS',JSON.stringify(results));
})().catch(e=>{console.error(e);process.exitCode=1;});
`;
const runner = new Module(path.join(root,'scripts/path-c-verification-only.js'), module);
runner.filename=path.join(root,'scripts/path-c-verification-only.js');
runner.paths=Module._nodeModulePaths(path.dirname(runner.filename));
runner._compile(source.slice(0,source.indexOf(marker))+tests, runner.filename);
