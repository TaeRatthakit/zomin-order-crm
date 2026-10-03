"use strict";

process.env.SUPABASE_URL = "https://failed-attempt-test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";
const assert = require("node:assert/strict");
const adapter = require("../lib/db/supabase-adapter");
const now = "2026-10-02T07:10:06.575Z";
const payment = { id: "payment", tenant_id: "qa", subscription_id: "subscription", status: "pending",
  provider: "stripe_promptpay", provider_payment_reference: "pi_test", amount_minor: 99000, currency: "THB", plan: "business", paid_at: null };
const attempt = { id: "attempt", payment_id: payment.id, tenant_id: "qa", subscription_id: "subscription", status: "pending",
  provider: payment.provider, provider_payment_reference: null, amount_minor: 99000, currency: "THB", target_plan: "business",
  current_plan: "business", updated_at: now, paid_at: null };
const subscription = { id: "subscription", tenant_id: "qa", plan: "business", current_period_ends_at: "2026-10-03T00:00:00Z" };
const events = [];
const rawEvent = { id: "evt_failed", type: "payment_intent.payment_failed", livemode: false,
  data: { object: { id: "pi_test", status: "requires_payment_method", amount: 99000, currency: "thb",
    metadata: { growup_payment_id: "payment", growup_tenant_id: "qa" } } } };
const input = { provider: payment.provider, providerEventId: rawEvent.id, paymentId: payment.id, tenantId: "qa",
  providerPaymentReference: "pi_test", amountMinor: 99000, currency: "THB", status: "failed", rawEvent };
let patches = 0;
global.fetch = async (inputUrl, options = {}) => {
  const url = new URL(inputUrl);
  const name = url.pathname.split("/").at(-1);
  let rows = { payments: [payment], subscription_upgrade_attempts: [attempt], subscriptions: [subscription], payment_provider_events: events }[name];
  if (name === "growup_record_provider_payment_status") {
    const payload = JSON.parse(options.body);
    if (!events.some(event => event.provider_event_id === payload.p_provider_event_id)) {
      payment.status = payload.p_status;
      payment.failed_at = now;
      events.push({ provider: payment.provider, provider_event_id: rawEvent.id, payment_id: payment.id,
        status: "processed", event_type: "payment_failed", processed_at: now, raw_event: rawEvent });
    }
    return Response.json([{ payment_id: payment.id, status: payment.status }]);
  }
  assert.ok(rows, `unexpected request ${url.pathname}`);
  for (const [key, value] of url.searchParams) {
    if (value.startsWith("eq.")) rows = rows.filter(row => String(row[key]) === value.slice(3));
    if (value === "is.null") rows = rows.filter(row => row[key] == null);
    if (value.startsWith("in.(")) rows = rows.filter(row => value.slice(4, -1).split(",").includes(row[key]));
  }
  if (options.method === "PATCH") {
    for (const row of rows) Object.assign(row, JSON.parse(options.body));
    patches += rows.length;
  }
  return Response.json(rows);
};

(async () => {
  const before = JSON.stringify(subscription);
  await adapter.recordProviderPaymentStatus(input);
  await adapter.reconcileFailedSubscriptionUpgradeAttempt(input);
  assert.equal(payment.status, "failed");
  assert.equal(attempt.status, "failed");
  assert.equal(JSON.stringify(subscription), before);
  assert.equal(patches, 1);
  await adapter.recordProviderPaymentStatus(input);
  await adapter.reconcileFailedSubscriptionUpgradeAttempt(input);
  assert.equal(events.length, 1);
  assert.equal(patches, 1);
  assert.deepEqual(await adapter.readPendingSubscriptionUpgrades("qa"), []);
  // Historical generic RPC event + pending attempt, exactly the Preview QA case.
  attempt.status = "pending";
  await adapter.reconcileFailedSubscriptionUpgradeAttempt(input);
  assert.equal(attempt.status, "failed");
  for (const state of ["paid", "processing", "unknown"]) {
    payment.status = state;
    attempt.status = "pending";
    await assert.rejects(adapter.recordProviderPaymentStatus(input), /UNSAFE/);
    assert.equal(await adapter.reconcileFailedSubscriptionUpgradeAttempt(input), null);
    assert.equal(attempt.status, "pending");
  }
  payment.status = "failed";
  attempt.tenant_id = "other-tenant";
  await assert.rejects(adapter.recordProviderPaymentStatus(input), /UNSAFE/);
  assert.equal(await adapter.reconcileFailedSubscriptionUpgradeAttempt(input), null);
  attempt.tenant_id = "qa";
  for (const state of ["paid", "processing"]) {
    attempt.status = state;
    await assert.rejects(adapter.recordProviderPaymentStatus(input), /UNSAFE/);
    assert.equal(await adapter.reconcileFailedSubscriptionUpgradeAttempt(input), null);
  }
  attempt.status = "pending";
  events.push({ payment_id: payment.id, status: "processed", event_type: "subscription_checkout_payment_succeeded" });
  await assert.rejects(adapter.recordProviderPaymentStatus(input), /UNSAFE/);
  assert.equal(await adapter.reconcileFailedSubscriptionUpgradeAttempt(input), null);
  events.pop();
  subscription.plan = "enterprise";
  await assert.rejects(adapter.recordProviderPaymentStatus(input), /UNSAFE/);
  assert.equal(await adapter.reconcileFailedSubscriptionUpgradeAttempt(input), null);
  subscription.plan = "business";
  rawEvent.data.object.status = "requires_action";
  await assert.rejects(adapter.recordProviderPaymentStatus(input), /UNSAFE/);
  assert.equal(await adapter.reconcileFailedSubscriptionUpgradeAttempt(input), null);
  console.log("Failed-payment linked-attempt regression PASS: terminal failure, original audit, duplicate replay, renewal unblocked, unsafe/success/activation/tenant guards.");
})().catch(error => { console.error(error); process.exitCode = 1; });
