"use strict";

// Read/verify only. No create, cancel, repair, redemption or success RPCs.
const { PRICE_CATALOG_MINOR } = require("./subscription-lifecycle");

function resumeError() {
  const error = new Error("CHECKOUT_RESUME_CONTEXT_UNVERIFIED");
  error.code = "CHECKOUT_RESUME_CONTEXT_UNVERIFIED";
  return error;
}

async function readOnlyCheckoutResume({ db, user, subscription, expected, readAttempts, retrieve, liveMode }) {
  const tenantId = String(user?.tenantId || "");
  if (!tenantId || user?.role !== "Owner" || !subscription?.id || subscription.tenantId !== tenantId) throw resumeError();
  const payment = (db.payments || []).find(row => row.id === expected.paymentId && row.tenantId === tenantId);
  if (!payment || payment.subscriptionId !== subscription.id || payment.provider !== "stripe_promptpay") throw resumeError();
  const metadata = payment.checkoutMetadata || {};
  const operation = String(payment.operation || metadata.operation || "");
  const plan = payment.targetPlan || payment.plan;
  const amount = Number(payment.amountMinor);
  const reference = String(payment.providerPaymentReference || "");
  const start = payment.billingPeriodStartedAt;
  const end = payment.billingPeriodEndsAt;
  // Promo checkouts keep their existing explicit-confirmation flow. Without an
  // independently verified reservation snapshot, automatic resume fails closed.
  if (metadata.promotion || expected.promotionCode || payment.promotion
    || !["subscription_upgrade", "subscription_renewal", "subscription_activation"].includes(operation)
    || expected.operation !== operation || expected.targetPlan !== plan
    || expected.billingInterval !== payment.billingInterval
    || Number(expected.amountMinor) !== amount || expected.currency !== payment.currency
    || payment.currency !== "THB" || !Number.isInteger(amount) || amount <= 0
    || amount !== Number(PRICE_CATALOG_MINOR[plan]?.[payment.billingInterval])
    || !start || !end || !(Date.parse(end) > Date.parse(start))
    || expected.billingPeriodStartedAt !== start || expected.billingPeriodEndsAt !== end
    || !reference || !payment.idempotencyKey) throw resumeError();

  const attempts = await readAttempts(tenantId);
  const linked = attempts.filter(row => row.paymentId === payment.id);
  const attempt = linked[0] || null;
  if (linked.length > 1 || (operation === "subscription_upgrade" && !attempt)) throw resumeError();
  if (attempt && (attempt.tenantId !== tenantId || attempt.subscriptionId !== subscription.id
    || attempt.targetPlan !== plan || attempt.currentPlan !== subscription.plan
    || attempt.billingInterval !== payment.billingInterval || attempt.currency !== payment.currency
    || Number(attempt.amountMinor) !== amount || attempt.idempotencyKey !== payment.idempotencyKey
    || !["pending", "processing"].includes(attempt.status)
    || (attempt.providerPaymentReference && attempt.providerPaymentReference !== reference))) throw resumeError();
  const pending = (db.payments || []).filter(row => row.tenantId === tenantId
    && ["pending", "processing"].includes(row.status));
  if (pending.some(row => row.id !== payment.id)) throw resumeError();
  // Proven local terminal rows are never treated as active or repaired here.
  if (["failed", "cancelled", "expired", "refunded"].includes(payment.status)) {
    return { state: "terminal", status: payment.status, payment };
  }
  if (!["pending", "processing", "paid"].includes(payment.status)) throw resumeError();
  const promptpay = await retrieve(reference); // Any lookup failure propagates; never becomes "failed".
  const evidence = promptpay.providerEvidence;
  const stripeMetadata = evidence?.metadata || {};
  if (promptpay.paymentIntentId !== reference || evidence?.id !== reference
    || evidence.livemode !== liveMode || Number(promptpay.amountMinor) !== amount
    || promptpay.currency !== payment.currency
    || stripeMetadata.growup_payment_id !== payment.id
    || stripeMetadata.growup_tenant_id !== tenantId
    || stripeMetadata.growup_subscription_id !== subscription.id
    || stripeMetadata.growup_plan !== plan
    || stripeMetadata.growup_billing_interval !== payment.billingInterval
    || stripeMetadata.growup_operation !== operation
    || stripeMetadata.growup_billing_period_started_at !== start
    || stripeMetadata.growup_billing_period_ends_at !== end
    || stripeMetadata.growup_promotion_code_id || stripeMetadata.growup_promo_reservation_id
    || !Number.isInteger(evidence.amount_received) || evidence.amount_received < 0
    || evidence.amount_received > amount) throw resumeError();
  const status = String(promptpay.status || "");
  if (status === "succeeded" || payment.status === "paid") {
    return { state: "awaiting_webhook", status: "paid", payment, promptpay, attempt };
  }
  if (["canceled", "requires_payment_method"].includes(status)
    || promptpay.localStatus === "expired") {
    return { state: "terminal", status: promptpay.localStatus, payment, promptpay, attempt };
  }
  if (!["requires_action", "processing"].includes(status)
    || !["pending", "processing"].includes(promptpay.localStatus)
    || (status === "requires_action" && !promptpay.qrImageUrl)) throw resumeError();
  const safePromptpay = { ...promptpay };
  delete safePromptpay.clientSecret;
  return { state: "active", status: promptpay.localStatus, payment, attempt, promptpay: safePromptpay };
}

module.exports = { readOnlyCheckoutResume };
