"use strict";

const crypto = require("crypto");

const STRIPE_API_BASE = "https://api.stripe.com";
const STRIPE_PROVIDER = "stripe_promptpay";
const WEBHOOK_TOLERANCE_SECONDS = 300;

function stripeRuntimeMode() {
  return process.env.VERCEL_ENV === "production" ? "live" : "test";
}

function stripeSecretKey() {
  if (stripeRuntimeMode() === "live") {
    return String(process.env.STRIPE_LIVE_SECRET_KEY || process.env.STRIPE_SECRET_KEY || "").trim();
  }
  return String(process.env.STRIPE_TEST_SECRET_KEY || process.env.STRIPE_SECRET_KEY || "").trim();
}

function stripeWebhookSecret() {
  if (stripeRuntimeMode() === "live") {
    return String(process.env.STRIPE_LIVE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET || "").trim();
  }
  return String(process.env.STRIPE_TEST_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET || "").trim();
}

function stripePublishableKey() {
  if (stripeRuntimeMode() === "live") {
    return String(process.env.STRIPE_LIVE_PUBLISHABLE_KEY || process.env.STRIPE_PUBLISHABLE_KEY || "").trim();
  }
  return String(process.env.STRIPE_TEST_PUBLISHABLE_KEY || process.env.STRIPE_PUBLISHABLE_KEY || "").trim();
}

function isStripeTestSecret(value = stripeSecretKey()) {
  return /^sk_test_[A-Za-z0-9]/.test(String(value || ""));
}

function isStripeLiveSecret(value = stripeSecretKey()) {
  return /^sk_live_[A-Za-z0-9]/.test(String(value || ""));
}

function isStripeTestPublishable(value = stripePublishableKey()) {
  const clean = String(value || "");
  return !clean || /^pk_test_[A-Za-z0-9]/.test(clean);
}

function isStripeLivePublishable(value = stripePublishableKey()) {
  const clean = String(value || "");
  return !clean || /^pk_live_[A-Za-z0-9]/.test(clean);
}

function isStripeSecretForRuntime(value = stripeSecretKey()) {
  return stripeRuntimeMode() === "live" ? isStripeLiveSecret(value) : isStripeTestSecret(value);
}

function isStripePublishableForRuntime(value = stripePublishableKey()) {
  return stripeRuntimeMode() === "live" ? isStripeLivePublishable(value) : isStripeTestPublishable(value);
}

function stripePromptPayConfig() {
  const secretKey = stripeSecretKey();
  const webhookSecret = stripeWebhookSecret();
  const publishableKey = stripePublishableKey();
  const mode = stripeRuntimeMode();
  return {
    provider: STRIPE_PROVIDER,
    mode,
    secretKeyConfigured: Boolean(secretKey),
    webhookSecretConfigured: Boolean(webhookSecret),
    publishableKeyConfigured: Boolean(publishableKey),
    testMode: mode === "test" && isStripeTestSecret(secretKey) && isStripeTestPublishable(publishableKey),
    liveMode: mode === "live" && isStripeLiveSecret(secretKey) && isStripeLivePublishable(publishableKey),
    modeConfigured: isStripeSecretForRuntime(secretKey) && isStripePublishableForRuntime(publishableKey),
    checkoutConfigured: isStripeSecretForRuntime(secretKey),
    webhookConfigured: /^whsec_[A-Za-z0-9]/.test(webhookSecret)
  };
}

function stripeFormBody(values = {}) {
  const params = new URLSearchParams();
  function append(prefix, value) {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) {
      for (const item of value) params.append(`${prefix}[]`, String(item));
      return;
    }
    if (typeof value === "object") {
      for (const [key, nested] of Object.entries(value)) append(`${prefix}[${key}]`, nested);
      return;
    }
    params.append(prefix, String(value));
  }
  for (const [key, value] of Object.entries(values)) append(key, value);
  return params;
}

async function stripeRequest(path, { method = "POST", body = {}, idempotencyKey = "" } = {}) {
  const secretKey = stripeSecretKey();
  if (!isStripeSecretForRuntime(secretKey)) {
    const code = stripeRuntimeMode() === "live" ? "STRIPE_LIVE_SECRET_KEY_REQUIRED" : "STRIPE_TEST_SECRET_KEY_REQUIRED";
    const error = new Error(code);
    error.code = code;
    throw error;
  }
  const res = await fetch(`${STRIPE_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {})
    },
    body: method === "GET" ? undefined : stripeFormBody(body).toString()
  });
  const text = await res.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!res.ok) {
    const error = new Error(payload.error?.message || `Stripe request failed: ${res.status}`);
    error.code = payload.error?.code || "STRIPE_REQUEST_FAILED";
    error.status = res.status;
    error.stripeType = payload.error?.type || "";
    throw error;
  }
  return payload;
}

function promptPayAttemptExpired(intent = {}) {
  if (String(intent.last_payment_error?.code || "").toLowerCase() === "payment_intent_payment_attempt_expired") return true;
  const expiresAt = Number(intent.next_action?.promptpay_display_qr_code?.expires_at || 0);
  return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt * 1000 <= Date.now();
}

function stripePaymentStatus(status = "", intent = {}) {
  const value = String(status || "").toLowerCase();
  if (value === "succeeded") return "paid";
  if (value === "processing") return "processing";
  // PromptPay's API status can remain requires_action after the QR attempt
  // expires. Treat Stripe's explicit expiry evidence as terminal so a stale
  // local checkout never blocks a safe new checkout forever.
  if (value === "requires_action" && promptPayAttemptExpired(intent)) return "expired";
  if (value === "requires_action") return "pending";
  if (value === "canceled") return "cancelled";
  if (value === "requires_payment_method") return "failed";
  return "pending";
}

function safePromptPayPayload(intent = {}) {
  const qr = intent.next_action?.promptpay_display_qr_code || {};
  const imageUrlPng = qr.image_url_png || qr.imageUrlPng || "";
  const imageUrlSvg = qr.image_url_svg || qr.imageUrlSvg || "";
  const hostedInstructionsUrl = qr.hosted_instructions_url || qr.hostedInstructionsUrl || "";
  const payload = {
    paymentIntentId: intent.id || "",
    status: intent.status || "",
    localStatus: stripePaymentStatus(intent.status, intent),
    amountMinor: Number(intent.amount || 0),
    currency: String(intent.currency || "").toUpperCase(),
    clientSecret: intent.client_secret || "",
    promptpay: {
      data: qr.data || "",
      hostedInstructionsUrl,
      imageUrlPng,
      imageUrlSvg,
      qrImageUrl: imageUrlPng || imageUrlSvg
    },
    qr: {
      pngUrl: imageUrlPng,
      svgUrl: imageUrlSvg,
      hostedInstructionsUrl
    },
    qrImageUrl: imageUrlPng || imageUrlSvg
  };
  // Server-only authoritative evidence; never serialize metadata/client secrets
  // into the API payload. Used for durable terminal reconciliation audit.
  Object.defineProperty(payload, "providerEvidence", { value: {
    id: intent.id, status: intent.status, livemode: intent.livemode,
    amount: intent.amount, amount_received: intent.amount_received, currency: intent.currency,
    metadata: intent.metadata, last_payment_error: { code: intent.last_payment_error?.code },
    next_action: { promptpay_display_qr_code: { expires_at: qr.expires_at } }
  } });
  return payload;
}

async function createPromptPayPaymentIntent({ payment, returnUrl = "", receiptEmail = "" } = {}) {
  if (!payment?.id) throw new Error("LOCAL_PAYMENT_REQUIRED");
  const amount = Number(payment.amountMinor || 0);
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("STRIPE_PAYMENT_AMOUNT_REQUIRED");
  if (String(payment.currency || "").toUpperCase() !== "THB") throw new Error("STRIPE_PAYMENT_CURRENCY_MUST_BE_THB");
  const billingEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(receiptEmail || ""))
    ? String(receiptEmail).trim()
    : `billing-${payment.id}@growuppilot.test`;
  const intent = await stripeRequest("/v1/payment_intents", {
    idempotencyKey: `growup:${payment.id}`,
    body: {
      amount,
      currency: "thb",
      confirm: "true",
      payment_method_types: ["promptpay"],
      payment_method_data: {
        type: "promptpay",
        billing_details: { email: billingEmail }
      },
      return_url: returnUrl,
      receipt_email: billingEmail,
      description: `Growup Pilot ${payment.plan || ""} ${payment.billingInterval || ""}`.trim(),
      metadata: {
        growup_payment_id: payment.id,
        growup_tenant_id: payment.tenantId || "",
        growup_subscription_id: payment.subscriptionId || "",
        growup_plan: payment.plan || "",
        growup_billing_interval: payment.billingInterval || "",
        growup_billing_period_started_at: payment.billingPeriodStartedAt || "",
        growup_billing_period_ends_at: payment.billingPeriodEndsAt || "",
        growup_operation: payment.operation || payment.checkoutMetadata?.operation || "",
        growup_current_plan: payment.currentPlan || payment.checkoutMetadata?.current_plan || "",
        ...(require("./checkout-promo").checkoutPromoEnabled() && payment.checkoutMetadata?.promotion?.reservation_id ? {
          growup_promo_reservation_id: payment.checkoutMetadata.promotion.reservation_id,
          growup_promotion_code_id: payment.checkoutMetadata.promotion.promotion_code_id
        } : {})
      }
    }
  });
  return safePromptPayPayload(intent);
}

async function retrievePaymentIntent(paymentIntentId) {
  const id = String(paymentIntentId || "").trim();
  if (!/^pi_[A-Za-z0-9_]+$/.test(id)) throw new Error("INVALID_STRIPE_PAYMENT_INTENT_ID");
  return safePromptPayPayload(await stripeRequest(`/v1/payment_intents/${encodeURIComponent(id)}`, { method: "GET" }));
}

async function cancelUnpaidTestPaymentIntentForReplacement(payment = {}, paymentIntentId = "") {
  const config = stripePromptPayConfig();
  if (stripeRuntimeMode() !== "test" || !config.testMode) throw new Error("STRIPE_TEST_MODE_REQUIRED");
  const id = String(paymentIntentId || "").trim();
  if (!/^pi_[A-Za-z0-9_]+$/.test(id) || !payment?.id || !payment?.tenantId || !payment?.subscriptionId) {
    throw new Error("REPLACEMENT_PAYMENT_CONTEXT_REQUIRED");
  }
  const metadata = payment.checkoutMetadata || payment.checkout_metadata || {};
  const promotion = metadata.promotion || {};
  const expected = {
    growup_payment_id: String(payment.id),
    growup_tenant_id: String(payment.tenantId),
    growup_subscription_id: String(payment.subscriptionId),
    growup_plan: String(payment.plan || payment.targetPlan || ""),
    growup_billing_interval: String(payment.billingInterval || ""),
    growup_billing_period_started_at: String(payment.billingPeriodStartedAt || ""),
    growup_billing_period_ends_at: String(payment.billingPeriodEndsAt || ""),
    growup_operation: String(payment.operation || metadata.operation || ""),
    growup_current_plan: String(payment.currentPlan || metadata.current_plan || "")
  };
  if (!expected.growup_plan || !expected.growup_billing_interval || !expected.growup_billing_period_started_at
    || !expected.growup_billing_period_ends_at || !["subscription_upgrade", "subscription_activation", "subscription_renewal"].includes(expected.growup_operation)) {
    throw new Error("REPLACEMENT_PAYMENT_CONTEXT_UNVERIFIED");
  }
  if (promotion.reservation_id) {
    expected.growup_promo_reservation_id = String(promotion.reservation_id);
    expected.growup_promotion_code_id = String(promotion.promotion_code_id || "");
    if (!expected.growup_promo_reservation_id || !expected.growup_promotion_code_id) {
      throw new Error("REPLACEMENT_PAYMENT_CONTEXT_UNVERIFIED");
    }
  }
  const verify = intent => {
    if (intent?.id !== id || intent.livemode !== false || Number(intent.amount_received) !== 0
      || Number(intent.amount) !== Number(payment.amountMinor)
      || String(intent.currency || "").toLowerCase() !== String(payment.currency || "").toLowerCase()) return false;
    return Object.entries(expected).every(([key, value]) => String(intent.metadata?.[key] || "") === value)
      && (Boolean(intent.metadata?.growup_promo_reservation_id) === Boolean(promotion.reservation_id))
      && (Boolean(intent.metadata?.growup_promotion_code_id) === Boolean(promotion.reservation_id));
  };
  const retrieve = () => stripeRequest(`/v1/payment_intents/${encodeURIComponent(id)}`, { method: "GET" });
  let intent = await retrieve();
  if (!verify(intent)) throw new Error("REPLACEMENT_PAYMENT_METADATA_MISMATCH");
  // PromptPay checkouts created by this flow wait for the customer in requires_action.
  // Other provider states are deliberately fail-closed, even if they appear unpaid.
  if (intent.status === "canceled") return safePromptPayPayload(intent);
  if (intent.status !== "requires_action" || !intent.next_action?.promptpay_display_qr_code) {
    throw new Error("REPLACEMENT_PAYMENT_NOT_SAFE_TO_CANCEL");
  }
  try {
    intent = await stripeRequest(`/v1/payment_intents/${encodeURIComponent(id)}/cancel`, {
      idempotencyKey: `growup:replace-cancel:${payment.id}`,
      body: { cancellation_reason: "abandoned" }
    });
    if (!verify(intent) || intent.status !== "canceled") throw new Error("REPLACEMENT_PAYMENT_CANCEL_UNVERIFIED");
  } catch (error) {
    let latest;
    try {
      latest = await retrieve();
    } catch {
      const uncertain = new Error("REPLACEMENT_PAYMENT_CANCEL_UNCERTAIN");
      uncertain.code = "REPLACEMENT_PAYMENT_CANCEL_UNCERTAIN";
      throw uncertain;
    }
    if (!verify(latest) || latest.status !== "canceled") {
      const failed = new Error("REPLACEMENT_PAYMENT_CANCEL_FAILED");
      failed.code = "REPLACEMENT_PAYMENT_CANCEL_FAILED";
      throw failed;
    }
    intent = latest;
  }
  return safePromptPayPayload(intent);
}

// Approved Preview/Test only. Read authoritative Stripe state BEFORE canceling;
// exact ownership/amount/metadata must match. Never cancel a paid/live intent.
async function cancelPromoTestPaymentIntent(payment, paymentIntentId, reason) {
  if (!require("./checkout-promo").checkoutPromoEnabled() || stripeRuntimeMode() !== "test"
    || !payment?.checkoutMetadata?.promotion?.reservation_id) throw new Error("PROMOTION_CHECKOUT_NOT_ALLOWED");
  const id = String(paymentIntentId || "");
  if (!/^pi_[A-Za-z0-9_]+$/.test(id)) throw new Error("INVALID_STRIPE_PAYMENT_INTENT_ID");
  const matches = row => row.id === id && row.livemode === false
    && row.metadata?.growup_payment_id === payment.id
    && row.metadata?.growup_tenant_id === payment.tenantId
    && row.metadata?.growup_subscription_id === payment.subscriptionId
    && row.metadata?.growup_promo_reservation_id === payment.checkoutMetadata.promotion.reservation_id
    && Number(row.amount) === Number(payment.amountMinor) && row.currency === "thb";
  const read = async () => {
    const row = await stripeRequest(`/v1/payment_intents/${encodeURIComponent(id)}`, { method: "GET" });
    if (!matches(row)) throw new Error("PROMOTION_PAYMENT_NOT_VERIFIED");
    return row;
  };
  let intent = await read();
  if (["succeeded","processing","canceled"].includes(intent.status)) return intent.status;
  const expiredAt = Number(intent.next_action?.promptpay_display_qr_code?.expires_at || 0);
  const eligible = (reason === "failed" && intent.status === "requires_payment_method")
    || (reason === "expired" && expiredAt > 0 && expiredAt * 1000 <= Date.now())
    || (reason === "abandoned" && payment.checkoutMetadata.promotion.abandoned_by_user_id
      && payment.checkoutMetadata.promotion.abandoned_at);
  if (!eligible) return intent.status; // Merely pending is NEVER permission to cancel.
  if (!["requires_payment_method","requires_confirmation","requires_action"].includes(intent.status)) return intent.status;
  try {
    intent = await stripeRequest(`/v1/payment_intents/${encodeURIComponent(id)}/cancel`, {
      idempotencyKey: `growup:promo-cancel:${payment.id}`, body: { cancellation_reason: "abandoned" }
    });
    if (!matches(intent)) throw new Error("PROMOTION_PAYMENT_NOT_VERIFIED");
  } catch (error) {
    // A concurrent cancel/payment can win. Re-read; never infer cancellation
    // from a timeout/error and never release quota on an uncertain outcome.
    intent = await read();
    if (!["canceled","succeeded","processing"].includes(intent.status)) throw error;
  }
  return intent.status;
}

async function findPaymentIntentByPaymentId(paymentId) {
  const id = String(paymentId || "").trim();
  if (!id || !/^[A-Za-z0-9_-]{8,120}$/.test(id)) return null;
  const query = `metadata['growup_payment_id']:'${id}'`;
  const payload = await stripeRequest(
    `/v1/payment_intents/search?query=${encodeURIComponent(query)}&limit=10`,
    { method: "GET" }
  );
  const match = (payload.data || [])
    .filter(intent => String(intent?.metadata?.growup_payment_id || "") === id)
    .sort((left, right) => Number(right.created || 0) - Number(left.created || 0))[0];
  return match ? safePromptPayPayload(match) : null;
}

function parseStripeSignatureHeader(header = "") {
  const parts = String(header || "").split(",").map(part => part.trim()).filter(Boolean);
  const parsed = {};
  for (const part of parts) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index);
    const value = part.slice(index + 1);
    if (!parsed[key]) parsed[key] = [];
    parsed[key].push(value);
  }
  return parsed;
}

function verifyStripeWebhookPayload(rawBody = "", signatureHeader = "", nowSeconds = Math.floor(Date.now() / 1000)) {
  const secret = stripeWebhookSecret();
  if (!/^whsec_[A-Za-z0-9]/.test(secret)) {
    const error = new Error("STRIPE_WEBHOOK_SECRET_REQUIRED");
    error.code = "STRIPE_WEBHOOK_SECRET_REQUIRED";
    throw error;
  }
  const parsed = parseStripeSignatureHeader(signatureHeader);
  const timestamp = Number(parsed.t?.[0] || 0);
  const signatures = parsed.v1 || [];
  if (!timestamp || !signatures.length) {
    const error = new Error("STRIPE_SIGNATURE_MISSING");
    error.code = "STRIPE_SIGNATURE_MISSING";
    throw error;
  }
  if (Math.abs(nowSeconds - timestamp) > WEBHOOK_TOLERANCE_SECONDS) {
    const error = new Error("STRIPE_SIGNATURE_EXPIRED");
    error.code = "STRIPE_SIGNATURE_EXPIRED";
    throw error;
  }
  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const ok = signatures.some(signature => {
    const provided = Buffer.from(signature, "hex");
    return provided.length === expectedBuffer.length && crypto.timingSafeEqual(provided, expectedBuffer);
  });
  if (!ok) {
    const error = new Error("STRIPE_SIGNATURE_INVALID");
    error.code = "STRIPE_SIGNATURE_INVALID";
    throw error;
  }
  try {
    return JSON.parse(rawBody);
  } catch {
    const error = new Error("STRIPE_WEBHOOK_MALFORMED_JSON");
    error.code = "STRIPE_WEBHOOK_MALFORMED_JSON";
    throw error;
  }
}

module.exports = {
  STRIPE_PROVIDER,
  stripePromptPayConfig,
  stripeRuntimeMode,
  promptPayAttemptExpired,
  stripePaymentStatus,
  createPromptPayPaymentIntent,
  retrievePaymentIntent,
  cancelUnpaidTestPaymentIntentForReplacement,
  cancelPromoTestPaymentIntent,
  findPaymentIntentByPaymentId,
  verifyStripeWebhookPayload,
  safePromptPayPayload,
  parseStripeSignatureHeader
};
