"use strict";
const assert = require("node:assert/strict");
const { readOnlyCheckoutResume } = require("../lib/checkout-resume");

function fixture(liveMode = true) {
  const payment = {
    id: "payment_one", tenantId: "tenant_one", subscriptionId: "subscription_one",
    provider: "stripe_promptpay", providerPaymentReference: "pi_existing",
    idempotencyKey: "one_confirm", status: "pending", operation: "subscription_upgrade",
    plan: "enterprise", targetPlan: "enterprise", currency: "THB", amountMinor: 199000,
    billingInterval: "monthly", billingPeriodStartedAt: "2026-10-10T00:00:00.000Z",
    billingPeriodEndsAt: "2026-11-10T00:00:00.000Z", checkoutMetadata: {}
  };
  const attempt = {
    id: "attempt_one", paymentId: payment.id, tenantId: payment.tenantId,
    subscriptionId: payment.subscriptionId, currentPlan: "starter", targetPlan: "enterprise",
    billingInterval: "monthly", currency: "THB", amountMinor: 199000,
    status: "pending", idempotencyKey: payment.idempotencyKey, providerPaymentReference: ""
  };
  const expected = {
    resumeExistingOnly: true, paymentId: payment.id, targetPlan: payment.plan,
    operation: payment.operation, billingInterval: payment.billingInterval,
    amountMinor: payment.amountMinor, currency: payment.currency, promotionCode: "",
    billingPeriodStartedAt: payment.billingPeriodStartedAt, billingPeriodEndsAt: payment.billingPeriodEndsAt
  };
  const evidence = {
    id: "pi_existing", livemode: liveMode, amount_received: 0,
    metadata: {
      growup_payment_id: payment.id, growup_tenant_id: payment.tenantId,
      growup_subscription_id: payment.subscriptionId, growup_plan: payment.plan,
      growup_billing_interval: payment.billingInterval, growup_operation: payment.operation,
      growup_billing_period_started_at: payment.billingPeriodStartedAt,
      growup_billing_period_ends_at: payment.billingPeriodEndsAt
    }
  };
  const promptpay = {
    paymentIntentId: "pi_existing", status: "requires_action", localStatus: "pending",
    amountMinor: 199000, currency: "THB", clientSecret: "must_not_serialize",
    qrImageUrl: "https://stripe.example/existing.png"
  };
  Object.defineProperty(promptpay, "providerEvidence", { value: evidence });
  const db = { payments: [payment], subscriptions: [{ id: payment.subscriptionId, plan: "starter" }] };
  let lookups = 0;
  return {
    payment, attempt, expected, promptpay, evidence, db, lookups: () => lookups,
    options: {
      db, expected, user: { tenantId: payment.tenantId, role: "Owner" },
      subscription: { id: payment.subscriptionId, tenantId: payment.tenantId, plan: "starter" },
      readAttempts: async () => [attempt],
      retrieve: async reference => { assert.equal(reference, "pi_existing"); lookups++; return promptpay; },
      liveMode
    }
  };
}

async function runCheckoutResumeFixtures() {
  let cases = 0;
  for (const mode of [true, false]) {
    const f = fixture(mode);
    const before = JSON.stringify({ db: f.db, attempt: f.attempt, evidence: f.evidence });
    for (let reload = 0; reload < 3; reload++) {
      const result = await readOnlyCheckoutResume(f.options);
      assert.equal(result.state, "active");
      assert.equal(result.promptpay.paymentIntentId, "pi_existing");
      assert.equal(Object.hasOwn(result.promptpay, "clientSecret"), false);
      assert.equal(Object.hasOwn(result.promptpay, "providerEvidence"), false);
    }
    assert.equal(f.lookups(), 3);
    assert.equal(JSON.stringify({ db: f.db, attempt: f.attempt, evidence: f.evidence }), before);
    assert.equal(f.db.payments.length, 1);
    cases++;
  }
  const invalid = [
    ["package", f => { f.expected.targetPlan = "business"; }],
    ["amount", f => { f.expected.amountMinor = 99000; }],
    ["currency", f => { f.expected.currency = "USD"; }],
    ["promo", f => { f.expected.promotionCode = "DIFFERENT"; }],
    ["interval", f => { f.expected.billingInterval = "yearly"; }],
    ["period", f => { f.expected.billingPeriodEndsAt = "2027-11-10T00:00:00.000Z"; }],
    ["tenant", f => { f.payment.tenantId = "other"; }],
    ["subscription", f => { f.payment.subscriptionId = "other"; }],
    ["missing link", f => { f.options.readAttempts = async () => []; }],
    ["attempt tenant", f => { f.attempt.tenantId = "other"; }],
    ["duplicate attempt", f => { f.options.readAttempts = async () => [f.attempt, { ...f.attempt, id: "duplicate" }]; }],
    ["idempotency", f => { f.attempt.idempotencyKey = "different"; }],
    ["reference", f => { f.attempt.providerPaymentReference = "pi_other"; }],
    ["ambiguous", f => { f.db.payments.push({ ...f.payment, id: "other" }); }],
    ["Stripe tenant", f => { f.evidence.metadata.growup_tenant_id = "other"; }],
    ["Stripe plan", f => { f.evidence.metadata.growup_plan = "business"; }],
    ["Stripe period", f => { f.evidence.metadata.growup_billing_period_started_at = "different"; }],
    ["Stripe amount", f => { f.promptpay.amountMinor = 99000; }],
    ["Stripe currency", f => { f.promptpay.currency = "USD"; }],
    ["missing metadata", f => { delete f.evidence.metadata.growup_payment_id; }],
    ["Stripe promo", f => { f.evidence.metadata.growup_promo_reservation_id = "unverified"; }],
    ["mode", f => { f.evidence.livemode = false; }],
    ["uncertain", f => { f.promptpay.status = "requires_confirmation"; }],
    ["missing QR", f => { f.promptpay.qrImageUrl = ""; }],
    ["staff", f => { f.options.user.role = "Staff"; }]
  ];
  for (const [name, mutate] of invalid) {
    const f = fixture(); mutate(f);
    await assert.rejects(readOnlyCheckoutResume(f.options), /CHECKOUT_RESUME_CONTEXT_UNVERIFIED/, name);
    cases++;
  }
  const failure = fixture();
  failure.options.retrieve = async () => { throw new Error("Stripe lookup unavailable"); };
  await assert.rejects(readOnlyCheckoutResume(failure.options), /Stripe lookup unavailable/);
  assert.equal(failure.payment.status, "pending"); cases++;
  for (const [status, local] of [["canceled", "cancelled"], ["requires_payment_method", "failed"], ["requires_action", "expired"]]) {
    const f = fixture(); f.promptpay.status = status; f.promptpay.localStatus = local;
    assert.equal((await readOnlyCheckoutResume(f.options)).state, "terminal");
    assert.equal(f.payment.status, "pending"); cases++;
  }
  for (const status of ["failed", "cancelled", "expired", "refunded"]) {
    const f = fixture(); f.payment.status = status;
    assert.equal((await readOnlyCheckoutResume(f.options)).state, "terminal");
    assert.equal(f.lookups(), 0); cases++;
  }
  const succeeded = fixture();
  succeeded.promptpay.status = "succeeded"; succeeded.promptpay.localStatus = "paid";
  succeeded.evidence.amount_received = 199000;
  assert.equal((await readOnlyCheckoutResume(succeeded.options)).state, "awaiting_webhook");
  assert.equal(succeeded.payment.status, "pending");
  assert.equal(succeeded.options.subscription.plan, "starter"); cases++;
  const processing = fixture();
  processing.promptpay.status = "processing"; processing.promptpay.localStatus = "processing";
  assert.equal((await readOnlyCheckoutResume(processing.options)).state, "active"); cases++;
  console.log(`Read-only checkout resume fixtures passed: ${cases}; no create/cancel/write dependencies.`);
}
module.exports = { runCheckoutResumeFixtures };
if (require.main === module) runCheckoutResumeFixtures().catch(error => { console.error(error); process.exitCode = 1; });
