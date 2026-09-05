"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { effectivePromoSubscription, checkoutPromoEnabled } = require("../lib/checkout-promo");
const { subscriptionAccess } = require("../lib/subscription-lifecycle");

const root = path.resolve(__dirname, "..");
const migration = fs.readFileSync(path.join(root, "supabase/migrations/20260907000000_paid_signup_free_access_promo.sql"), "utf8");
const entitlementMigration = fs.readFileSync(path.join(root, "supabase/migrations/20260901010000_zero_payment_promo_entitlements.sql"), "utf8");
const guardMigration = fs.readFileSync(path.join(root, "supabase/migrations/20260908000000_allow_explicit_free_access_promo.sql"), "utf8");
const repairMigration = fs.readFileSync(path.join(root, "supabase/migrations/20260909000000_repair_paid_signup_function.sql"), "utf8");
const trialGuardMigration = fs.readFileSync(path.join(root, "supabase/migrations/20260910000000_allow_signup_free_access_entitlement.sql"), "utf8");
const finiteGuardMigration = fs.readFileSync(path.join(root, "supabase/migrations/20260911000000_reject_nonfinite_promo_values.sql"), "utf8");
const publicFiles = ["public/app.js", "public/landing.html", "public/login.html", "public/signup.html"]
  .map(file => fs.readFileSync(path.join(root, file), "utf8"));

const now = Date.parse("2026-09-07T00:00:00.000Z");
const tenantId = "11111111-1111-4111-8111-111111111111";
const subscriptionId = "22222222-2222-4222-8222-222222222222";

function baseSubscription(amountDueMinor = 49000) {
  return {
    id: subscriptionId,
    tenantId,
    plan: "starter",
    billingInterval: "monthly",
    status: "pending_payment",
    amountDueMinor,
    trialStartedAt: "",
    trialEndsAt: "",
    currentPeriodStartedAt: "",
    currentPeriodEndsAt: ""
  };
}

function grant(value, requestKey = `request-${value}`) {
  const startsAt = new Date(now).toISOString();
  const endsAt = new Date(now + value * 86400000).toISOString();
  return {
    version: 1,
    source: "promotion_zero_payment",
    state: "granted",
    tenant_id: tenantId,
    subscription_id: subscriptionId,
    plan: "starter",
    billing_interval: "monthly",
    code: `FREE${value}`,
    redemption_id: `redemption-${value}`,
    request_key: requestKey,
    unit: "days",
    value,
    starts_at: startsAt,
    ends_at: endsAt
  };
}

function effectiveFor(value) {
  const base = baseSubscription();
  const effective = effectivePromoSubscription(base, { zero_payment_entitlements: [grant(value)] }, now + 1000);
  return { base, effective, access: subscriptionAccess(effective, new Date(now + 1000)) };
}

// A: ordinary signup creates a paid-required subscription and no access.
assert(migration.includes("'pending_payment'"), "normal signup must remain pending payment");
assert(migration.includes("trial_started_at, trial_ends_at,") && migration.includes("null, null, null, null, null, v_payment_due_at"), "new signup must not write trial dates");
assert.equal(subscriptionAccess(baseSubscription(), new Date(now + 1000)).allowed, false, "normal signup must require payment");

// B: a discount is still a payment flow and cannot become free activation.
const discounted = baseSubscription(79200);
assert.equal(subscriptionAccess(discounted, new Date(now + 1000)).allowed, false, "discount signup must still require payment");
assert(migration.includes("PROMOTION_CODE_PAYMENT_REQUIRED"), "zero-amount discount protection missing");
assert(migration.includes("v_mode = 'payment' and v_amount <= 0"), "discount quote must reject zero payment");
assert(guardMigration.includes("'service_days', 'free_months'"), "database guard must allow explicit free-access types");
assert(guardMigration.includes("new.benefit_value >= 100"), "database guard must reject zero-charge discounts");
assert(guardMigration.includes("PROMOTION_CODE_NOT_ALLOWED"), "database guard must reject legacy/invalid types");
assert(repairMigration.includes("PAID_SIGNUP_FUNCTION_SHAPE_UNEXPECTED") && repairMigration.includes("null, null, null, null, null, v_payment_due_at"), "applied signup RPC repair must be fail-closed");
assert(trialGuardMigration.includes("new.promotion_benefit_type in ('service_days', 'free_months')"), "initial signup guard must allow explicit free access");
assert(trialGuardMigration.includes("new.amount_due_minor <= 0"), "initial signup guard must keep zero-charge payment protection");
assert(finiteGuardMigration.includes("'NaN', 'Infinity', '-Infinity'"), "Promo guard must reject non-finite values");

// C/D: explicit free-access Promo grants work for the configured duration.
for (const days of [5, 15]) {
  const result = effectiveFor(days);
  assert.equal(result.effective.status, "active", `FREE${days} must expose active effective access`);
  assert.equal(result.access.allowed, true, `FREE${days} must allow access before expiry`);
  assert.equal(result.effective.promoEntitlement.value, days, `FREE${days} value must be preserved`);
  assert.equal(Date.parse(result.effective.currentPeriodEndsAt), now + days * 86400000, `FREE${days} must expire exactly after configured days`);
}

// E: expiry is exact and falls back to pending payment.
const five = effectiveFor(5);
const exactExpiry = Date.parse(five.effective.currentPeriodEndsAt);
const afterExpiry = effectivePromoSubscription(five.base, { zero_payment_entitlements: [grant(5)] }, exactExpiry);
assert.equal(afterExpiry.status, "pending_payment", "expired free access must reveal the paid-required base subscription");
assert.equal(subscriptionAccess(afterExpiry, new Date(exactExpiry)).allowed, false, "expired free access must block the app exactly at ends_at");

// F: an invalid code cannot create an entitlement.
const invalidSnapshot = { zero_payment_entitlements: [] };
const invalidEffective = effectivePromoSubscription(baseSubscription(), invalidSnapshot, now + 1000);
assert.equal(invalidEffective.promoEntitlement, undefined, "invalid Promo must not create an entitlement");
assert.equal(subscriptionAccess(invalidEffective, new Date(now + 1000)).allowed, false, "invalid Promo must not bypass payment");

// G: redemption request keys are unique and retries reuse the same grant.
assert(entitlementMigration.includes("add column entitlement_request_key text unique"), "redemption idempotency key must be unique");
assert(entitlementMigration.includes("value->>'request_key'=p_request_key"), "duplicate redemption must reuse the original grant");
const redemptionResults = new Map();
const first = grant(15, "stable-request-key");
redemptionResults.set(first.request_key, first);
const retry = redemptionResults.get("stable-request-key");
assert.strictEqual(retry, first, "duplicate redemption must not create a second grant");

// H: historical trial rows remain readable, but new public copy does not imply one.
const historicalTrial = {
  plan: "starter",
  billingInterval: "monthly",
  status: "trialing",
  trialStartedAt: "2026-08-01T00:00:00.000Z",
  trialEndsAt: "2026-09-30T00:00:00.000Z"
};
assert.equal(subscriptionAccess(historicalTrial, new Date(now)).allowed, true, "historical trial access compatibility must remain");
assert.equal(checkoutPromoEnabled({ VERCEL_ENV: "preview", DATABASE_PROVIDER: "supabase", SUPABASE_URL: "https://enwabsfsmwwcwwirdwok.supabase.co", CHECKOUT_PROMO_ENABLED: "true" }), true, "Preview promo gate must be explicit");
assert.equal(checkoutPromoEnabled({ VERCEL_ENV: "production", DATABASE_PROVIDER: "supabase", SUPABASE_URL: "https://enwabsfsmwwcwwirdwok.supabase.co", CHECKOUT_PROMO_ENABLED: "true" }), false, "Preview Supabase must never enable production promo consumption");

for (const contents of publicFiles) {
  for (const forbidden of ["เริ่มใช้ฟรี 30 วัน", "ทดลองใช้ฟรี 30 วัน", "ทดลองฟรี 30 วัน"]) {
    assert(!contents.includes(forbidden), `public UI still contains removed automatic-trial copy: ${forbidden}`);
  }
}
assert(publicFiles[0].includes("สิทธิ์ใช้งานฟรี"), "valid free-access UI copy is missing");

console.log("Signup free-access Promo Preview A-H checks passed.");
