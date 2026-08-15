"use strict";

const crypto = require("crypto");

const STRIPE_API_BASE = "https://api.stripe.com";
const STRIPE_PROVIDER = "stripe_promptpay";
const WEBHOOK_TOLERANCE_SECONDS = 300;

function stripeSecretKey() {
  return String(process.env.STRIPE_SECRET_KEY || process.env.STRIPE_TEST_SECRET_KEY || "").trim();
}

function stripeWebhookSecret() {
  return String(process.env.STRIPE_WEBHOOK_SECRET || process.env.STRIPE_TEST_WEBHOOK_SECRET || "").trim();
}

function stripePublishableKey() {
  return String(process.env.STRIPE_PUBLISHABLE_KEY || process.env.STRIPE_TEST_PUBLISHABLE_KEY || "").trim();
}

function isStripeTestSecret(value = stripeSecretKey()) {
  return /^sk_test_[A-Za-z0-9]/.test(String(value || ""));
}

function isStripeTestPublishable(value = stripePublishableKey()) {
  const clean = String(value || "");
  return !clean || /^pk_test_[A-Za-z0-9]/.test(clean);
}

function stripePromptPayConfig() {
  const secretKey = stripeSecretKey();
  const webhookSecret = stripeWebhookSecret();
  const publishableKey = stripePublishableKey();
  return {
    provider: STRIPE_PROVIDER,
    secretKeyConfigured: Boolean(secretKey),
    webhookSecretConfigured: Boolean(webhookSecret),
    publishableKeyConfigured: Boolean(publishableKey),
    testMode: isStripeTestSecret(secretKey) && isStripeTestPublishable(publishableKey),
    checkoutConfigured: isStripeTestSecret(secretKey),
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
  if (!isStripeTestSecret(secretKey)) {
    const error = new Error("STRIPE_TEST_SECRET_KEY_REQUIRED");
    error.code = "STRIPE_TEST_SECRET_KEY_REQUIRED";
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

function stripePaymentStatus(status = "") {
  const value = String(status || "").toLowerCase();
  if (value === "succeeded") return "paid";
  if (value === "processing" || value === "requires_action") return "processing";
  if (value === "canceled") return "cancelled";
  if (value === "requires_payment_method") return "failed";
  return "pending";
}

function safePromptPayPayload(intent = {}) {
  const qr = intent.next_action?.promptpay_display_qr_code || {};
  return {
    paymentIntentId: intent.id || "",
    status: intent.status || "",
    localStatus: stripePaymentStatus(intent.status),
    amountMinor: Number(intent.amount || 0),
    currency: String(intent.currency || "").toUpperCase(),
    clientSecret: intent.client_secret || "",
    promptpay: {
      data: qr.data || "",
      hostedInstructionsUrl: qr.hosted_instructions_url || "",
      imageUrlPng: qr.image_url_png || "",
      imageUrlSvg: qr.image_url_svg || ""
    }
  };
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
        growup_billing_interval: payment.billingInterval || ""
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
  stripePaymentStatus,
  createPromptPayPaymentIntent,
  retrievePaymentIntent,
  verifyStripeWebhookPayload,
  safePromptPayPayload,
  parseStripeSignatureHeader
};
