"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { checkoutPromoEnabled, checkoutPromoError, publicCheckoutPromotion, signCheckoutQuote,
  verifyCheckoutQuote, effectivePromoSubscription } = require("../lib/checkout-promo");
const enabled = { VERCEL_ENV:"preview",CHECKOUT_PROMO_ENABLED:"true",DATABASE_PROVIDER:"supabase",SUPABASE_URL:"https://enwabsfsmwwcwwirdwok.supabase.co" };
assert.equal(checkoutPromoEnabled(enabled),true);
for (const patch of [{VERCEL_ENV:"production"},{VERCEL_ENV:"development"},{CHECKOUT_PROMO_ENABLED:"false"},
  {SUPABASE_URL:"https://mjnpzdmrqweugdnvlqwq.supabase.co"},{SUPABASE_URL:"invalid"},{DATABASE_PROVIDER:"json"}]) {
  assert.equal(checkoutPromoEnabled({...enabled,...patch}),false,"fail-closed environment boundary");
}
assert.match(checkoutPromoError(new Error("PROMOTION_CODE_EXHAUSTED")).error,/จอง/);
assert.equal(checkoutPromoError(new Error("unrelated")),null);
const snapshot = {code:"TEST10",benefit_type:"percent_discount",benefit_description:"ลด 10%",base_amount_minor:99000,discount_amount_minor:9900,reservation_id:"reservation-test",promotion_code_id:"promo-test",private_value:"not_public"};
assert.deepEqual(publicCheckoutPromotion({checkoutMetadata:{promotion:snapshot}}),{
  code:"TEST10",benefitType:"percent_discount",benefitDescription:"ลด 10%",baseAmountMinor:99000,discountAmountMinor:9900
});
Object.assign(process.env,enabled,{NODE_ENV:"test",SUPABASE_SERVICE_ROLE_KEY:"test-only",STRIPE_TEST_SECRET_KEY:"sk_test_mock"});
process.env.SESSION_SECRET="test-only-checkout-promo-session-secret-32-bytes";
const signed=signCheckoutQuote({code:"FREE14",plan:"business",billing:"monthly",mode:"free_service"},{id:"owner-test",tenantId:"tenant-test"});
const verified=verifyCheckoutQuote(signed,{id:"owner-test",tenantId:"tenant-test"});
assert.equal(verified.code,"FREE14");
assert.match(verified.requestKey,/^[a-f0-9]{64}$/);
assert.throws(()=>verifyCheckoutQuote(`${signed}x`,{id:"owner-test",tenantId:"tenant-test"}),/PROMOTION_QUOTE_CHANGED/);
assert.throws(()=>verifyCheckoutQuote(signed,{id:"other-owner",tenantId:"tenant-test"}),/PROMOTION_QUOTE_CHANGED/);
const base={id:"subscription-test",tenantId:"tenant-test",plan:"starter",status:"expired",billingInterval:"monthly",
  amountDueMinor:49000,currentPeriodStartedAt:"2026-07-01T00:00:00.000Z",currentPeriodEndsAt:"2026-08-01T00:00:00.000Z"};
const grant={version:1,source:"promotion_zero_payment",state:"granted",tenant_id:"tenant-test",subscription_id:"subscription-test",
  plan:"business",billing_interval:"monthly",code:"FREE14",unit:"days",value:14,redemption_id:"redemption-test",
  starts_at:"2026-09-01T00:00:00.000Z",ends_at:"2026-09-15T00:00:00.000Z"};
const effective=effectivePromoSubscription(base,{zero_payment_entitlements:[grant]},Date.parse("2026-09-02T00:00:00.000Z"));
assert.equal(effective.plan,"business");
assert.equal(effective.status,"active");
assert.equal(effective.amountDueMinor,0);
assert.equal(effectivePromoSubscription(base,{zero_payment_entitlements:[grant]},Date.parse(grant.ends_at)),base,"expiry restores untouched base view");
assert.equal(effectivePromoSubscription(base,{zero_payment_entitlements:[{...grant,tenant_id:"other"}]},Date.parse("2026-09-02T00:00:00.000Z")),base,"cross-tenant grant ignored");
const requests=[];
let missingRpc=false;
let cancelState="requires_action";
global.fetch=async(url,options={})=>{
  const address=new URL(url); requests.push({url:address.pathname,body:options.body});
  if(address.hostname==="enwabsfsmwwcwwirdwok.supabase.co" && address.pathname.startsWith("/rest/v1/rpc/")) {
    if(missingRpc) return new Response(JSON.stringify({code:"PGRST202",message:"function public.growup_begin_subscription_checkout missing"}),{status:404});
    return new Response(JSON.stringify({payment_id:"payment-test",tenant_id:"tenant-test",subscription_id:"subscription-test",target_plan:"business",
      operation:"subscription_upgrade",provider:"stripe_promptpay",status:"pending",currency:"THB",amount_minor:89100,
      billing_interval:"monthly",checkout_metadata:{promotion:snapshot}}),{status:200});
  }
  if(address.hostname==="api.stripe.com" && address.pathname==="/v1/payment_intents") {
    const body=new URLSearchParams(options.body);
    assert.equal(body.get("amount"),"89100");
    assert.equal(body.get("metadata[growup_promo_reservation_id]"),"reservation-test");
    return new Response(JSON.stringify({id:"pi_mock_promo",status:"requires_action",amount:89100,currency:"thb",metadata:{}}),{status:200});
  }
  if(address.hostname==="api.stripe.com" && address.pathname==="/v1/payment_intents/pi_cancel_test") {
    return new Response(JSON.stringify({id:"pi_cancel_test",livemode:false,status:cancelState,amount:89100,currency:"thb",
      metadata:{growup_payment_id:"payment-cancel",growup_tenant_id:"tenant-test",growup_subscription_id:"subscription-test",growup_promo_reservation_id:"reservation-cancel"}}),{status:200});
  }
  if(address.hostname==="api.stripe.com" && address.pathname==="/v1/payment_intents/pi_cancel_test/cancel") {
    cancelState="canceled";
    return new Response(JSON.stringify({id:"pi_cancel_test",livemode:false,status:cancelState,amount:89100,currency:"thb",
      metadata:{growup_payment_id:"payment-cancel",growup_tenant_id:"tenant-test",growup_subscription_id:"subscription-test",growup_promo_reservation_id:"reservation-cancel"}}),{status:200});
  }
  throw new Error("Unexpected test network request denied");
};
(async()=>{
  const db=require("../lib/db/supabase-adapter");
  const input={tenantId:"tenant-test",userId:"user-test",targetPlan:"business",billingInterval:"monthly",intent:"subscription_upgrade",idempotencyKey:"same-test-key",provider:"stripe_promptpay",promotionCode:" TEST10 ",amountMinor:1,discount:99999};
  const payment=await db.beginSubscriptionCheckout(input);
  assert.equal(payment.amountMinor,89100,"amount comes from authoritative RPC only");
  assert.equal(requests[0].url,"/rest/v1/rpc/growup_begin_subscription_promo_checkout");
  const payload=JSON.parse(requests[0].body);
  assert.equal(payload.p_promotion_code,"TEST10");
  assert.equal(payload.p_tenant_id,"tenant-test");
  assert(!("amountMinor" in payload) && !("discount" in payload));
  const {createPromptPayPaymentIntent,cancelPromoTestPaymentIntent}=require("../lib/stripe-promptpay");
  await createPromptPayPaymentIntent({payment});
  const cancelPayment={id:"payment-cancel",tenantId:"tenant-test",subscriptionId:"subscription-test",amountMinor:89100,currency:"THB",
    checkoutMetadata:{promotion:{reservation_id:"reservation-cancel",abandoned_by_user_id:"owner-test",abandoned_at:"2026-09-01T00:00:00Z"}}};
  assert.equal(await cancelPromoTestPaymentIntent(cancelPayment,"pi_cancel_test","abandoned"),"canceled");
  assert.equal(await cancelPromoTestPaymentIntent(cancelPayment,"pi_cancel_test","abandoned"),"canceled","repeat never cancels twice");
  assert.equal(requests.filter(item=>item.url.endsWith("/cancel")).length,1,"Stripe cancel exactly once");
  missingRpc=true;
  const before=requests.length;
  await assert.rejects(db.beginSubscriptionCheckout(input));
  assert.equal(requests.length,before+1,"missing Promo RPC never falls back");
  missingRpc=false;
  process.env.VERCEL_ENV="production";
  await assert.rejects(cancelPromoTestPaymentIntent(cancelPayment,"pi_cancel_test","abandoned"),/PROMOTION_CHECKOUT_NOT_ALLOWED/);
  await assert.rejects(db.beginSubscriptionCheckout(input),/PROMOTION_CHECKOUT_NOT_ALLOWED/);
  await db.beginSubscriptionCheckout({...input,promotionCode:""});
  assert.equal(requests.at(-1).url,"/rest/v1/rpc/growup_begin_subscription_checkout","Production keeps existing RPC");
  assert(!("p_promotion_code" in JSON.parse(requests.at(-1).body)));
  const sql=fs.readFileSync(path.join(__dirname,"../supabase/migrations/20260901000000_checkout_promo_reservations.sql"),"utf8");
  assert(!/create or replace function public\.(growup_signup_bootstrap|growup_record_subscription_checkout_success|growup_begin_subscription_checkout)\(/i.test(sql));
  assert(!/delete from|truncate |drop table|alter table public\.(orders|tenant_memberships|users)/i.test(sql));
  assert.match(sql,/promotion_redemptions_capacity before insert/);
  assert.match(sql,/payment_id uuid not null unique/);
  assert.match(sql,/last_provider_status' is distinct from 'succeeded'/);
  assert(!/growup_apply_checkout_promo_entitlement|checkout_service_entitlements/.test(sql),"obsolete paid service bonus path removed");
  const serverSource=fs.readFileSync(path.join(__dirname,"../server.js"),"utf8");
  assert.match(serverSource,/CHECKOUT_PROMO_API_PATHS\.has\(requestPathname\)\s*&&\s*!getCurrentUser\(req\)\?\.id/,
    "Promo API must deny unauthenticated requests before tenant-owned reads");
  console.log("Checkout Promo environment, server price, adapter idempotency contract, metadata, no-fallback and isolation tests passed.");
})().catch(error=>{console.error(error.message);process.exitCode=1;});
