"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { subscriptionAccess } = require("../lib/subscription-lifecycle");
const { normalizePromoInput } = require("../lib/platform-admin");
const sql = fs.readFileSync(path.join(__dirname,"../supabase/migrations/20260831000000_promo_service_entitlement.sql"),"utf8");
const promo = normalizePromoInput({code:"SERVICE14",type:"free_days",value:14,plans:["starter"],noExpiry:true});
assert.equal(promo.benefit_type,"service_days");
assert.equal(promo.benefit_value,14);
for (const name of ["growup_signup_bootstrap", "growup_enforce_initial_trial_window", "growup_begin_subscription_checkout", "growup_record_subscription_checkout_success"]) {
  assert(!sql.includes(`create or replace function public.${name}(`), `${name} must remain unchanged`);
}
assert(!/\b(?:update|delete from)\s+public\.(?:orders|payments|users|tenants|subscriptions)\b/i.test(sql),"migration must not backfill or mutate existing data");
assert(!/create table/i.test(sql),"reuse authoritative subscription snapshot, not a parallel system");
for (const token of ["old.promotion_snapshot", "pending_verified_payment", "p.status = 'paid'", "p.paid_at is not null", "last_provider_status", "p.tenant_id = new.tenant_id", "v_grant->>'plan'", "Asia/Bangkok", "promotion_code.service_entitlement"]) assert(sql.includes(token),`missing security contract ${token}`);
const trial = {status:"trialing",plan:"starter",trialEndsAt:"2026-07-31T03:00:00Z",currentPeriodEndsAt:"2026-07-31T03:00:00Z"};
assert.equal(subscriptionAccess(trial,new Date("2026-08-01T03:00:00Z")).allowed,false,"pending bonus must not extend trial");
const paid = {status:"active",plan:"starter",trialEndsAt:trial.trialEndsAt,currentPeriodEndsAt:"2026-10-14T03:00:00Z"};
assert.equal(subscriptionAccess(paid,new Date("2026-10-13T03:00:00Z")).allowed,true,"existing access helper reads entitled period");
assert.equal(subscriptionAccess(paid,new Date("2026-10-14T03:00:00Z")).allowed,false,"bonus expires at exact end");
assert.equal(subscriptionAccess({...paid,status:"pending_payment"},new Date("2026-10-01T03:00:00Z")).allowed,false,"future date cannot bypass payment");
assert.equal(subscriptionAccess({...paid,status:"cancelled"},new Date("2026-10-01T03:00:00Z")).allowed,false,"bonus cannot bypass cancellation");
console.log("Promo service entitlement, trial-cap and access-boundary checks passed.");
