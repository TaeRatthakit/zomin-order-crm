"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  PRICE_CATALOG_MINOR,
  subscriptionAccess,
  authoritativePriceMinor,
  subscriptionCheckoutIntent
} = require("../lib/subscription-lifecycle");

const root = path.resolve(__dirname, "..");
const migration = fs.readFileSync(path.join(root, "supabase/migrations/20260827010000_subscription_lifecycle.sql"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const app = fs.readFileSync(path.join(root, "public/app.js"), "utf8");

const at = value => new Date(value);
const beforeEnd = at("2026-09-26T23:59:59.999Z");
const exactEnd = at("2026-09-27T00:00:00.000Z");
const trial = {
  plan: "starter",
  billingInterval: "monthly",
  status: "trialing",
  trialStartedAt: "2026-08-28T00:00:00.000Z",
  trialEndsAt: "2026-09-27T00:00:00.000Z"
};

assert.equal(at(trial.trialEndsAt) - at(trial.trialStartedAt), 30 * 86400000, "Starter trial must be exactly 30 days");
assert.equal(subscriptionAccess(trial, beforeEnd).allowed, true, "trial must work immediately before expiry");
assert.equal(subscriptionAccess(trial, exactEnd).allowed, false, "trial must expire exactly at trial_ends_at");
assert.equal(subscriptionAccess(trial, exactEnd).reason, "expired", "expired trial must expose the effective reason");

const activeMonthly = {
  plan: "business",
  billingInterval: "monthly",
  status: "active",
  currentPeriodStartedAt: "2026-08-27T00:00:00.000Z",
  currentPeriodEndsAt: "2026-09-27T00:00:00.000Z"
};
assert.equal(subscriptionAccess(activeMonthly, beforeEnd).allowed, true, "paid access must work before period end");
assert.equal(subscriptionAccess(activeMonthly, exactEnd).allowed, false, "paid access must expire exactly at period end");
assert.equal(subscriptionAccess({ ...activeMonthly, status: "pending_payment" }, beforeEnd).allowed, false, "pending payment must never grant entitlement");
assert.equal(subscriptionAccess({ ...activeMonthly, status: "cancelled" }, beforeEnd).allowed, false, "cancelled subscription must not grant entitlement");

const warning7 = subscriptionAccess({ ...activeMonthly, currentPeriodEndsAt: "2026-09-04T00:00:00.000Z" }, at("2026-08-28T00:00:00.000Z"));
const warning3 = subscriptionAccess({ ...activeMonthly, currentPeriodEndsAt: "2026-08-31T00:00:00.000Z" }, at("2026-08-28T00:00:00.000Z"));
const warning1 = subscriptionAccess({ ...activeMonthly, currentPeriodEndsAt: "2026-08-29T00:00:00.000Z" }, at("2026-08-28T00:00:00.000Z"));
assert.equal(warning7.warningMilestone, 7);
assert.equal(warning3.warningMilestone, 3);
assert.equal(warning1.warningMilestone, 1);

assert.deepEqual(PRICE_CATALOG_MINOR, {
  starter: { monthly: 49000, yearly: 490000 },
  business: { monthly: 99000, yearly: 990000 },
  enterprise: { monthly: 199000, yearly: 1990000 }
});
assert.equal(authoritativePriceMinor("starter", "monthly"), 49000);
assert.equal(authoritativePriceMinor("business", "yearly"), 990000);
assert.equal(authoritativePriceMinor("enterprise", "monthly"), 199000);
assert.equal(subscriptionCheckoutIntent(activeMonthly, "business", "monthly"), "subscription_renewal");
assert.equal(subscriptionCheckoutIntent(activeMonthly, "enterprise", "yearly"), "subscription_upgrade");
assert.equal(subscriptionCheckoutIntent(activeMonthly, "starter", "monthly"), "", "downgrade must remain unsupported");

for (const token of [
  "new.trial_ends_at := new.trial_started_at + interval '30 days'",
  "new.extra_trial_days := 0",
  "growup_begin_subscription_checkout",
  "growup_record_subscription_checkout_success",
  "lower(trim(tm.role)) = 'owner'",
  "p.status in ('pending', 'processing')",
  "SUBSCRIPTION_CHECKOUT_IN_PROGRESS",
  "public.growup_subscription_base_amount_minor(v_target_plan, v_interval)",
  "v_subscription.current_period_ends_at > v_now then v_subscription.current_period_ends_at",
  "public.growup_payment_period_end(v_started_at, v_interval)",
  "v_payment.status = 'paid'",
  "status = 'ignored'",
  "v_attempt.status not in ('pending', 'processing')",
  "v_payment.amount_minor <> p_amount_minor",
  "v_payment.currency <> v_currency",
  "v_payment.plan <> v_subscription.plan",
  "trial_started_at",
  "trial_ends_at"
]) assert(migration.includes(token), `lifecycle migration missing contract token: ${token}`);

assert(!migration.includes("delete from public.payments"), "migration must preserve payment history");
assert(!migration.includes("delete from public.subscriptions"), "migration must preserve subscription history");
assert(!migration.includes("drop table"), "migration must not drop lifecycle tables");
assert(!migration.match(/set\s+trial_started_at\s*=\s*null/i), "activation must preserve historical trial start");
assert(!migration.match(/set[\s\S]{0,120}trial_ends_at\s*=\s*null/i), "activation must preserve historical trial end");

for (const token of [
  "SUBSCRIPTION_PAYMENT_REQUIRED",
  "subscriptionBlockedResponse",
  "isSubscriptionAccessExempt",
  "recordSubscriptionCheckoutSuccess(input)",
  "payment.operation || \"\""
]) assert(server.includes(token), `server lifecycle contract missing ${token}`);

for (const token of [
  "แพ็กเกจของคุณหมดอายุแล้ว",
  "ข้อมูลธุรกิจทั้งหมดของคุณยังถูกเก็บไว้อย่างปลอดภัย",
  "กรุณาติดต่อ Owner เพื่อดำเนินการต่ออายุแพ็กเกจ",
  "ทดลองใช้ฟรีสิ้นสุดแล้ว",
  "ใช้งาน ${plan.name} ต่อ",
  "data-pricing-billing=\"monthly\"",
  "data-pricing-billing=\"yearly\"",
  "formatDate(dateOnly)",
  "subscription_activation",
  "subscription_renewal",
  "latestPayment.verifiedSuccess === true"
]) assert(app.includes(token), `subscription UI contract missing ${token}`);

// Re-login, payment retry, and navigation are not trial-authority operations.
for (const forbiddenPattern of [
  /function restoreSession[\s\S]{0,1200}trialEndsAt\s*=/,
  /function hydrateSubscriptionCheckout[\s\S]{0,1200}trialEndsAt\s*=/,
  /beginSubscriptionCheckoutForUi[\s\S]{0,600}trialEndsAt\s*=/
]) assert(!forbiddenPattern.test(app), "client flow must not reset trial timestamps");

console.log("Subscription lifecycle contract checks passed.");
