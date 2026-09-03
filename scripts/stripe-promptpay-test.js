"use strict";

process.env.NODE_ENV = "test";
process.env.DATABASE_PROVIDER = "supabase";
process.env.SUPABASE_URL = "https://stripe-promptpay-test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.SESSION_SECRET = "stripe-promptpay-test-session-secret";
process.env.AUTH_RATE_LIMIT_MAX = "500";
process.env.PAYMENT_PROVIDER_ENABLED = "true";
process.env.PAYMENT_PROVIDER = "stripe_promptpay";
process.env.STRIPE_SECRET_KEY = "sk_test_mock_secret";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_mock_secret";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const { hashPassword } = require("../lib/auth");
const { stripePromptPayConfig, stripePaymentStatus, safePromptPayPayload, findPaymentIntentByPaymentId } = require("../lib/stripe-promptpay");

const ROOT = path.join(__dirname, "..");
const migration = fs.readFileSync(path.join(ROOT, "supabase", "migrations", "20260814030000_stripe_promptpay_payment.sql"), "utf8");
const nowIso = "2026-08-14T00:00:00.000Z";

const tenants = {
  business: "11111111-1111-4111-8111-111111111111",
  zero: "22222222-2222-4222-8222-222222222222",
  starter: "33333333-3333-4333-8333-333333333333",
  failed: "44444444-4444-4444-8444-444444444444"
};

const db = {
  tenants: [
    { id: tenants.business, name: "Business Pending", status: "active", created_at: nowIso },
    { id: tenants.zero, name: "Zero Promo", status: "active", created_at: nowIso },
    { id: tenants.starter, name: "Starter Trial", status: "active", created_at: nowIso },
    { id: tenants.failed, name: "Failed Payment", status: "active", created_at: nowIso }
  ],
  users: [
    { id: "u_business", username: "business@example.com", password_hash: hashPassword("pass12345"), name: "Business Owner", role: "Owner", phone: "", is_active: true },
    { id: "u_zero", username: "zero@example.com", password_hash: hashPassword("pass12345"), name: "Zero Owner", role: "Owner", phone: "", is_active: true },
    { id: "u_starter", username: "starter@example.com", password_hash: hashPassword("pass12345"), name: "Starter Owner", role: "Owner", phone: "", is_active: true },
    { id: "u_failed", username: "failed@example.com", password_hash: hashPassword("pass12345"), name: "Failed Owner", role: "Owner", phone: "", is_active: true }
  ],
  tenant_memberships: [
    { id: "m_business", tenant_id: tenants.business, user_id: "u_business", role: "Owner", is_active: true },
    { id: "m_zero", tenant_id: tenants.zero, user_id: "u_zero", role: "Owner", is_active: true },
    { id: "m_starter", tenant_id: tenants.starter, user_id: "u_starter", role: "Owner", is_active: true },
    { id: "m_failed", tenant_id: tenants.failed, user_id: "u_failed", role: "Owner", is_active: true }
  ],
  subscriptions: [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", tenant_id: tenants.business, is_initial: true, plan: "business", billing_interval: "monthly", status: "pending_payment", currency: "THB", base_amount_minor: 99000, discount_amount_minor: 19800, amount_due_minor: 79200, payment_due_at: nowIso, created_at: nowIso, updated_at: nowIso },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", tenant_id: tenants.zero, is_initial: true, plan: "enterprise", billing_interval: "yearly", status: "pending_payment", currency: "THB", base_amount_minor: 3588000, discount_amount_minor: 3588000, amount_due_minor: 0, payment_due_at: nowIso, created_at: nowIso, updated_at: nowIso },
    { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", tenant_id: tenants.starter, is_initial: true, plan: "starter", billing_interval: "monthly", status: "trialing", currency: "THB", base_amount_minor: 49000, discount_amount_minor: 0, amount_due_minor: 49000, trial_started_at: nowIso, trial_ends_at: "2099-01-01T00:00:00.000Z", current_period_ends_at: "2099-01-01T00:00:00.000Z", created_at: nowIso, updated_at: nowIso },
    { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", tenant_id: tenants.failed, is_initial: true, plan: "business", billing_interval: "yearly", status: "pending_payment", currency: "THB", base_amount_minor: 950400, discount_amount_minor: 0, amount_due_minor: 950400, payment_due_at: nowIso, created_at: nowIso, updated_at: nowIso }
  ],
  payments: [],
  payment_provider_events: [],
  settings: [],
  follow_up_rules: [],
  customers: [],
  orders: [],
  line_messages: [],
  tags: [],
  customer_tags: [],
  contact_logs: [],
  notification_reads: [],
  tenant_role_permissions: [],
  tenant_settings: []
};

const stripeIntentsByIdempotency = new Map();
const stripeRequests = [];
let stripeIntentSequence = 1;

function fail(message) {
  throw new Error(message);
}

function withEnvPatch(patch, task) {
  const keys = Object.keys(patch);
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return task();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function assertStripeEnvironmentGuards() {
  withEnvPatch({
    VERCEL_ENV: "preview",
    STRIPE_SECRET_KEY: "sk_test_mock_secret",
    STRIPE_TEST_SECRET_KEY: undefined,
    STRIPE_LIVE_SECRET_KEY: undefined,
    STRIPE_PUBLISHABLE_KEY: undefined,
    STRIPE_TEST_PUBLISHABLE_KEY: undefined,
    STRIPE_LIVE_PUBLISHABLE_KEY: undefined
  }, () => {
    const config = stripePromptPayConfig();
    if (!config.testMode || !config.modeConfigured || config.liveMode || config.mode !== "test") {
      fail(`Preview test Stripe config was rejected: ${JSON.stringify(config)}`);
    }
  });

  withEnvPatch({
    VERCEL_ENV: "preview",
    STRIPE_SECRET_KEY: "sk_live_mock_secret",
    STRIPE_TEST_SECRET_KEY: undefined,
    STRIPE_LIVE_SECRET_KEY: undefined
  }, () => {
    const config = stripePromptPayConfig();
    if (config.modeConfigured || config.checkoutConfigured || config.liveMode || config.testMode) {
      fail(`Preview accepted a live Stripe secret: ${JSON.stringify(config)}`);
    }
  });

  withEnvPatch({
    VERCEL_ENV: "production",
    STRIPE_SECRET_KEY: undefined,
    STRIPE_TEST_SECRET_KEY: "sk_test_mock_secret",
    STRIPE_LIVE_SECRET_KEY: "sk_live_mock_secret",
    STRIPE_PUBLISHABLE_KEY: undefined,
    STRIPE_TEST_PUBLISHABLE_KEY: undefined,
    STRIPE_LIVE_PUBLISHABLE_KEY: "pk_live_mock_publishable"
  }, () => {
    const config = stripePromptPayConfig();
    if (!config.liveMode || !config.modeConfigured || config.testMode || config.mode !== "live") {
      fail(`Production live Stripe config was rejected: ${JSON.stringify(config)}`);
    }
  });

  withEnvPatch({
    VERCEL_ENV: "production",
    STRIPE_SECRET_KEY: "sk_test_mock_secret",
    STRIPE_TEST_SECRET_KEY: undefined,
    STRIPE_LIVE_SECRET_KEY: undefined,
    STRIPE_LIVE_PUBLISHABLE_KEY: undefined
  }, () => {
    const config = stripePromptPayConfig();
    if (config.modeConfigured || config.checkoutConfigured || config.testMode || config.liveMode) {
      fail(`Production accepted a test Stripe secret: ${JSON.stringify(config)}`);
    }
  });
}

function assertPromptPayExpiryMapping() {
  const now = Math.floor(Date.now() / 1000);
  const explicitExpiry = safePromptPayPayload({
    id: "pi_expired_error",
    status: "requires_action",
    last_payment_error: { code: "payment_intent_payment_attempt_expired" },
    amount: 99000,
    currency: "thb"
  });
  if (explicitExpiry.localStatus !== "expired") fail("PromptPay expiry error was treated as active pending payment");
  const qrExpiry = safePromptPayPayload({
    id: "pi_expired_qr",
    status: "requires_action",
    amount: 99000,
    currency: "thb",
    next_action: { promptpay_display_qr_code: { expires_at: now - 1 } }
  });
  if (qrExpiry.localStatus !== "expired") fail("Expired PromptPay QR was treated as active pending payment");
  if (stripePaymentStatus("requires_action", { next_action: { promptpay_display_qr_code: { expires_at: now + 60 } } }) !== "pending") fail("Unexpired PromptPay QR was not protected as pending");
}

function parseValue(raw = "") {
  return decodeURIComponent(String(raw).replace(/^"|"$/g, ""));
}

function parseIn(raw = "") {
  return parseValue(raw).replace(/^\(|\)$/g, "").split(",").map(item => item.replace(/^"|"$/g, "")).filter(Boolean);
}

function applyFilters(rows, params) {
  let out = [...rows];
  for (const [key, value] of params.entries()) {
    if (["select", "limit", "order", "on_conflict"].includes(key)) continue;
    if (value.startsWith("eq.")) out = out.filter(row => String(row[key]) === parseValue(value.slice(3)));
    else if (value.startsWith("in.")) {
      const values = new Set(parseIn(value.slice(3)));
      out = out.filter(row => values.has(String(row[key])));
    }
  }
  const limit = Number(params.get("limit") || 0);
  return limit ? out.slice(0, limit) : out;
}

function rpcError(message) {
  return new Response(JSON.stringify({ message }), { status: 400 });
}

function paymentRpcRow(payment) {
  return {
    payment_id: payment.id,
    tenant_id: payment.tenant_id,
    subscription_id: payment.subscription_id,
    provider: payment.provider,
    status: payment.status,
    currency: payment.currency,
    amount_minor: payment.amount_minor,
    plan: payment.plan,
    billing_interval: payment.billing_interval,
    idempotency_key: payment.idempotency_key,
    provider_payment_reference: payment.provider_payment_reference,
    billing_period_started_at: payment.billing_period_started_at,
    billing_period_ends_at: payment.billing_period_ends_at,
    created_at: payment.created_at,
    paid_at: payment.paid_at || null
  };
}

function beginPayment(payload = {}) {
  const tenantId = String(payload.p_tenant_id || "");
  const userId = String(payload.p_user_id || "");
  const key = String(payload.p_idempotency_key || "");
  const provider = String(payload.p_provider || "provider_required");
  if (!db.tenant_memberships.some(row => row.tenant_id === tenantId && row.user_id === userId && row.is_active)) return rpcError("PAYMENT_TENANT_FORBIDDEN");
  const existing = db.payments.find(row => row.tenant_id === tenantId && row.idempotency_key === key);
  if (existing) return new Response(JSON.stringify([paymentRpcRow(existing)]), { status: 200 });
  const subscription = db.subscriptions.find(row => row.tenant_id === tenantId && row.is_initial);
  if (!subscription) return rpcError("SUBSCRIPTION_NOT_FOUND");
  if (subscription.status === "active" || (subscription.status === "trialing" && new Date(subscription.trial_ends_at) > new Date())) return rpcError("PAYMENT_NOT_REQUIRED");
  const payment = {
    id: crypto.randomUUID(),
    tenant_id: tenantId,
    subscription_id: subscription.id,
    idempotency_key: key,
    provider,
    provider_payment_reference: null,
    status: "pending",
    currency: subscription.currency,
    amount_minor: subscription.amount_due_minor,
    plan: subscription.plan,
    billing_interval: subscription.billing_interval,
    billing_period_started_at: nowIso,
    billing_period_ends_at: subscription.billing_interval === "yearly" ? "2027-08-14T00:00:00.000Z" : "2026-09-14T00:00:00.000Z",
    created_at: nowIso
  };
  db.payments.push(payment);
  return new Response(JSON.stringify([paymentRpcRow(payment)]), { status: 200 });
}

function setProviderReference(payload = {}) {
  const payment = db.payments.find(row => row.id === payload.p_payment_id && row.tenant_id === payload.p_tenant_id);
  if (!payment) return rpcError("PAYMENT_NOT_FOUND");
  if (payment.provider !== payload.p_provider) return rpcError("PAYMENT_PROVIDER_MISMATCH");
  const reference = String(payload.p_provider_payment_reference || "");
  if (payment.provider_payment_reference && payment.provider_payment_reference !== reference) return rpcError("PAYMENT_PROVIDER_REFERENCE_CONFLICT");
  payment.provider_payment_reference = reference;
  payment.status = String(payload.p_status || "pending");
  payment.provider_metadata = payload.p_provider_metadata || {};
  return new Response(JSON.stringify([paymentRpcRow(payment)]), { status: 200 });
}

function validateProviderPayment(payload = {}) {
  const payment = db.payments.find(row => row.id === payload.p_payment_id);
  if (!payment) throw new Error("PAYMENT_NOT_FOUND");
  if (payment.provider !== payload.p_provider) throw new Error("PAYMENT_PROVIDER_MISMATCH");
  if (payment.provider_payment_reference !== payload.p_provider_payment_reference) throw new Error("PAYMENT_REFERENCE_MISMATCH");
  if (Number(payment.amount_minor) !== Number(payload.p_amount_minor)) throw new Error("PAYMENT_AMOUNT_MISMATCH");
  if (String(payment.currency).toUpperCase() !== String(payload.p_currency).toUpperCase()) throw new Error("PAYMENT_CURRENCY_MISMATCH");
  return payment;
}

function recordProviderEvent(payload = {}) {
  const existing = db.payment_provider_events.find(row => row.provider === payload.p_provider && row.provider_event_id === payload.p_provider_event_id);
  if (existing) return { duplicate: true };
  db.payment_provider_events.push({
    id: crypto.randomUUID(),
    provider: payload.p_provider,
    provider_event_id: payload.p_provider_event_id,
    payment_id: payload.p_payment_id,
    event_type: payload.p_status || "paid",
    raw_event: payload.p_raw_event || {},
    created_at: nowIso
  });
  return { duplicate: false };
}

function providerSuccess(payload = {}) {
  let payment;
  try {
    payment = validateProviderPayment(payload);
  } catch (error) {
    return rpcError(error.message);
  }
  const event = recordProviderEvent(payload);
  if (!event.duplicate && payment.status !== "paid") {
    payment.status = "paid";
    payment.paid_at = nowIso;
    const subscription = db.subscriptions.find(row => row.id === payment.subscription_id);
    subscription.status = "active";
    subscription.current_period_started_at = payment.billing_period_started_at;
    subscription.current_period_ends_at = payment.billing_period_ends_at;
    subscription.next_renewal_at = payment.billing_period_ends_at;
    subscription.updated_at = nowIso;
  }
  return new Response(JSON.stringify({ ok: true, payment_id: payment.id, duplicate: event.duplicate }), { status: 200 });
}

function providerStatus(payload = {}) {
  let payment;
  try {
    payment = validateProviderPayment(payload);
  } catch (error) {
    return rpcError(error.message);
  }
  recordProviderEvent(payload);
  const status = String(payload.p_status || "");
  if (status === "processing" || status === "failed" || status === "cancelled" || status === "expired") {
    payment.status = status;
    if (status === "failed") payment.failed_at = nowIso;
    if (status === "cancelled" || status === "expired") payment.expired_at = nowIso;
  }
  return new Response(JSON.stringify({ ok: true, payment_id: payment.id, status: payment.status }), { status: 200 });
}

function zeroAmountPayment(payload = {}) {
  const tenantId = String(payload.p_tenant_id || "");
  const userId = String(payload.p_user_id || "");
  const key = String(payload.p_idempotency_key || "");
  if (!db.tenant_memberships.some(row => row.tenant_id === tenantId && row.user_id === userId && row.is_active)) return rpcError("PAYMENT_TENANT_FORBIDDEN");
  const existing = db.payments.find(row => row.tenant_id === tenantId && row.idempotency_key === key);
  if (existing) return new Response(JSON.stringify([paymentRpcRow(existing)]), { status: 200 });
  const subscription = db.subscriptions.find(row => row.tenant_id === tenantId && row.is_initial);
  if (!subscription || Number(subscription.amount_due_minor) !== 0) return rpcError("ZERO_AMOUNT_SUBSCRIPTION_REQUIRED");
  const payment = {
    id: crypto.randomUUID(),
    tenant_id: tenantId,
    subscription_id: subscription.id,
    idempotency_key: key,
    provider: "zero_amount",
    provider_payment_reference: `zero_amount:${key}`,
    status: "paid",
    currency: subscription.currency,
    amount_minor: 0,
    plan: subscription.plan,
    billing_interval: subscription.billing_interval,
    billing_period_started_at: nowIso,
    billing_period_ends_at: "2027-08-14T00:00:00.000Z",
    created_at: nowIso,
    paid_at: nowIso
  };
  db.payments.push(payment);
  subscription.status = "active";
  subscription.current_period_started_at = payment.billing_period_started_at;
  subscription.current_period_ends_at = payment.billing_period_ends_at;
  subscription.next_renewal_at = payment.billing_period_ends_at;
  return new Response(JSON.stringify([paymentRpcRow(payment)]), { status: 200 });
}

function stripeIntentResponse(options = {}) {
  const idempotencyKey = String(options.headers?.["Idempotency-Key"] || options.headers?.["idempotency-key"] || "");
  if (stripeIntentsByIdempotency.has(idempotencyKey)) {
    return new Response(JSON.stringify(stripeIntentsByIdempotency.get(idempotencyKey)), { status: 200 });
  }
  const params = new URLSearchParams(options.body || "");
  stripeRequests.push({ idempotencyKey, params });
  const amount = Number(params.get("amount") || 0);
  const currency = params.get("currency");
  if (amount <= 0 || currency !== "thb") {
    return new Response(JSON.stringify({ error: { message: "bad amount", code: "bad_amount" } }), { status: 400 });
  }
  const intent = {
    id: `pi_promptpay_${stripeIntentSequence++}`,
    object: "payment_intent",
    amount,
    currency: "thb",
    status: "requires_action",
    client_secret: "pi_secret_mock",
    payment_method_types: ["promptpay"],
    next_action: {
      promptpay_display_qr_code: {
        data: "000201010212",
        hosted_instructions_url: `https://payments.stripe.test/${idempotencyKey}`,
        image_url_png: `https://q.stripe.test/${idempotencyKey}.png`,
        image_url_svg: `https://q.stripe.test/${idempotencyKey}.svg`
      }
    },
    metadata: {
      growup_payment_id: params.get("metadata[growup_payment_id]") || "",
      growup_tenant_id: params.get("metadata[growup_tenant_id]") || "",
      growup_subscription_id: params.get("metadata[growup_subscription_id]") || "",
      growup_plan: params.get("metadata[growup_plan]") || "",
      growup_billing_interval: params.get("metadata[growup_billing_interval]") || ""
    }
  };
  stripeIntentsByIdempotency.set(idempotencyKey, intent);
  return new Response(JSON.stringify(intent), { status: 200 });
}

global.fetch = async function mockFetch(input, options = {}) {
  const url = new URL(String(input));
  if (url.host === "api.stripe.com") {
    if (url.pathname === "/v1/payment_intents" && String(options.method || "POST").toUpperCase() === "POST") return stripeIntentResponse(options);
    if (url.pathname === "/v1/payment_intents/search") {
      const query = String(url.searchParams.get("query") || "");
      const paymentId = query.match(/metadata\['growup_payment_id'\]:'([^']+)'/)?.[1] || "";
      const data = [...stripeIntentsByIdempotency.values()].filter(intent => intent.metadata?.growup_payment_id === paymentId);
      return new Response(JSON.stringify({ object: "search_result", data }), { status: 200 });
    }
    const match = url.pathname.match(/^\/v1\/payment_intents\/([^/]+)$/);
    if (match) {
      const intent = [...stripeIntentsByIdempotency.values()].find(item => item.id === match[1]);
      return intent
        ? new Response(JSON.stringify(intent), { status: 200 })
        : new Response(JSON.stringify({ error: { message: "not found", code: "resource_missing" } }), { status: 404 });
    }
    return new Response(JSON.stringify({ error: { message: "unknown stripe endpoint", code: "unknown" } }), { status: 404 });
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.at(-2) === "rpc") {
    const payload = JSON.parse(options.body || "{}");
    const name = parts.at(-1);
    if (name === "growup_begin_subscription_payment") return beginPayment(payload);
    if (name === "growup_set_payment_provider_reference") return setProviderReference(payload);
    if (name === "growup_record_provider_payment_success") return providerSuccess(payload);
    if (name === "growup_record_provider_payment_status") return providerStatus(payload);
    if (name === "growup_activate_zero_amount_subscription_payment") return zeroAmountPayment(payload);
    return rpcError(`unknown rpc ${name}`);
  }
  const table = parts.at(-1);
  if (!Object.prototype.hasOwnProperty.call(db, table)) return new Response(JSON.stringify({ message: `unknown table ${table}` }), { status: 404 });
  const method = String(options.method || "GET").toUpperCase();
  if (method === "GET") return new Response(JSON.stringify(applyFilters(db[table], url.searchParams)), { status: 200 });
  if (method === "POST") {
    const rows = JSON.parse(options.body || "[]");
    for (const row of rows) db[table].push(row);
    return new Response(JSON.stringify(rows), { status: 200 });
  }
  return new Response("unsupported", { status: 405 });
};

const appHandler = require("../server");

function header(headers, name) {
  const found = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found ? found[1] : "";
}

function request(pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body || "";
    const req = Readable.from(body ? [body] : []);
    req.method = options.method || "GET";
    req.url = pathname;
    req.headers = { host: "127.0.0.1", "content-type": "application/json", ...(options.headers || {}) };
    const chunks = [];
    const res = {
      statusCode: 200,
      headers: {},
      writeHead(status, headers = {}) { this.statusCode = status; this.headers = { ...this.headers, ...headers }; },
      end(chunk) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: this.statusCode, headers: this.headers, text, json: () => text ? JSON.parse(text) : {} });
      }
    };
    Promise.resolve(appHandler(req, res)).catch(reject);
  });
}

async function login(username) {
  const res = await request("/api/login", { method: "POST", body: JSON.stringify({ username, password: "pass12345" }) });
  if (res.status !== 200) fail(`${username} login failed: ${res.status} ${res.text}`);
  return header(res.headers, "set-cookie");
}

function stripeSignature(payload, timestamp = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac("sha256", process.env.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${payload}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

function intentEvent(type, intent, overrides = {}) {
  return {
    id: overrides.id || `evt_${crypto.randomBytes(4).toString("hex")}`,
    object: "event",
    type,
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: intent.id,
        object: "payment_intent",
        amount: overrides.amount ?? intent.amount,
        currency: overrides.currency || intent.currency,
        status: overrides.status || (type === "payment_intent.succeeded" ? "succeeded" : intent.status),
        payment_method_types: ["promptpay"],
        client_secret: "should-not-be-stored",
        next_action: intent.next_action,
        metadata: intent.metadata || {}
      }
    }
  };
}

async function postStripeWebhook(event) {
  const body = typeof event === "string" ? event : JSON.stringify(event);
  return request("/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": stripeSignature(body) },
    body
  });
}

(async () => {
assertStripeEnvironmentGuards();
assertPromptPayExpiryMapping();

  for (const token of [
    "growup_set_payment_provider_reference",
    "growup_record_provider_payment_status",
    "growup_activate_zero_amount_subscription_payment",
    "PAYMENT_AMOUNT_MISMATCH",
    "zero_amount",
    "provider_payment_reference"
  ]) {
    if (!migration.includes(token)) fail(`stripe migration missing ${token}`);
  }

  const businessCookie = await login("business@example.com");
  const runtime = await request("/api/verify/runtime");
  if (runtime.status !== 200 || runtime.json().runtime.payment.provider !== "stripe_promptpay" || runtime.json().runtime.payment.stripe.testMode !== true) {
    fail(`runtime Stripe metadata wrong: ${runtime.status} ${runtime.text}`);
  }

  const checkoutBody = { idempotencyKey: "stripe-checkout-1", amountMinor: 1, currency: "USD", tenantId: tenants.zero };
  const checkoutA = await request("/api/billing/checkout", { method: "POST", headers: { cookie: businessCookie }, body: JSON.stringify(checkoutBody) });
  const checkoutB = await request("/api/billing/checkout", { method: "POST", headers: { cookie: businessCookie }, body: JSON.stringify(checkoutBody) });
  if (checkoutA.status !== 200 || checkoutA.json().provider !== "stripe_promptpay") fail(`Stripe checkout failed: ${checkoutA.status} ${checkoutA.text}`);
  if (!checkoutA.json().promptpay.promptpay.imageUrlSvg || !checkoutA.json().promptpay.promptpay.hostedInstructionsUrl) fail("PromptPay checkout did not return Stripe QR instructions");
  if (checkoutA.json().payment.amountMinor !== 79200 || checkoutA.json().promptpay.amountMinor !== 79200 || checkoutA.json().promptpay.currency !== "THB") fail("Stripe checkout trusted browser amount/currency");
  if (checkoutB.json().payment.id !== checkoutA.json().payment.id || db.payments.filter(row => row.tenant_id === tenants.business).length !== 1) fail("Stripe checkout idempotency did not reuse the local payment");
  if (stripeRequests.length !== 1 || stripeRequests[0].idempotencyKey !== `growup:${checkoutA.json().payment.id}`) fail("Stripe idempotency key was not based on the local payment id");
  if (stripeRequests[0].params.get("payment_method_types[]") !== "promptpay" || stripeRequests[0].params.get("payment_method_data[type]") !== "promptpay") fail("Stripe request did not request PromptPay");
  if (stripeRequests[0].params.get("payment_method_data[billing_details][email]") !== "business@example.com") fail("Stripe PromptPay request did not include required billing email");
  const recoveredIntent = await findPaymentIntentByPaymentId(checkoutA.json().payment.id);
  if (recoveredIntent?.paymentIntentId !== checkoutA.json().promptpay.paymentIntentId || recoveredIntent.localStatus !== "pending") fail("Stripe PaymentIntent metadata recovery did not find the existing pending intent");

  const invalidWebhook = await request("/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": "t=1,v1=bad" }, body: "{}" });
  if (invalidWebhook.status !== 400) fail(`invalid webhook signature was accepted: ${invalidWebhook.status} ${invalidWebhook.text}`);
  const malformedWebhook = await postStripeWebhook("{");
  if (malformedWebhook.status !== 400 || malformedWebhook.json().code !== "STRIPE_WEBHOOK_MALFORMED_JSON") fail(`malformed webhook wrong: ${malformedWebhook.status} ${malformedWebhook.text}`);

  const intent = [...stripeIntentsByIdempotency.values()][0];
  const successEvent = intentEvent("payment_intent.succeeded", intent, { id: "evt_success_once" });
  const successA = await postStripeWebhook(successEvent);
  const successB = await postStripeWebhook(successEvent);
  if (successA.status !== 200 || successB.status !== 200) fail(`success webhook failed: ${successA.status}/${successB.status}`);
  const businessSubscription = db.subscriptions.find(row => row.tenant_id === tenants.business);
  const businessPayment = db.payments.find(row => row.tenant_id === tenants.business);
  if (businessSubscription.status !== "active" || businessPayment.status !== "paid") fail("success webhook did not activate subscription and mark payment paid");
  if (db.payment_provider_events.filter(row => row.provider_event_id === "evt_success_once").length !== 1) fail("duplicate webhook event was inserted twice");
  if (JSON.stringify(db.payment_provider_events[0].raw_event).includes("should-not-be-stored")) fail("webhook storage kept Stripe client_secret");

  const wrongAmount = await postStripeWebhook(intentEvent("payment_intent.succeeded", intent, { id: "evt_wrong_amount", amount: 1 }));
  if (wrongAmount.status !== 400) fail(`wrong amount webhook was accepted: ${wrongAmount.status} ${wrongAmount.text}`);

  const failedCookie = await login("failed@example.com");
  const failedCheckout = await request("/api/billing/checkout", { method: "POST", headers: { cookie: failedCookie }, body: JSON.stringify({ idempotencyKey: "stripe-checkout-failed" }) });
  if (failedCheckout.status !== 200) fail(`failed checkout setup failed: ${failedCheckout.status} ${failedCheckout.text}`);
  const failedIntent = [...stripeIntentsByIdempotency.values()].find(item => item.id === failedCheckout.json().promptpay.paymentIntentId);
  const failedWebhook = await postStripeWebhook(intentEvent("payment_intent.payment_failed", failedIntent, { id: "evt_failed", status: "requires_payment_method" }));
  if (failedWebhook.status !== 200) fail(`failed webhook rejected: ${failedWebhook.status} ${failedWebhook.text}`);
  const failedSubscription = db.subscriptions.find(row => row.tenant_id === tenants.failed);
  const failedPayment = db.payments.find(row => row.tenant_id === tenants.failed);
  if (failedSubscription.status === "active" || failedPayment.status !== "failed") fail("failed webhook activated subscription or did not mark payment failed");

  const zeroCookie = await login("zero@example.com");
  const stripeCountBeforeZero = stripeRequests.length;
  const zeroCheckout = await request("/api/billing/checkout", { method: "POST", headers: { cookie: zeroCookie }, body: JSON.stringify({ idempotencyKey: "zero-promo" }) });
  if (zeroCheckout.status !== 200 || zeroCheckout.json().provider !== "zero_amount" || zeroCheckout.json().payment.amountMinor !== 0) fail(`zero amount checkout wrong: ${zeroCheckout.status} ${zeroCheckout.text}`);
  if (stripeRequests.length !== stripeCountBeforeZero) fail("zero-amount activation called Stripe");
  if (db.subscriptions.find(row => row.tenant_id === tenants.zero).status !== "active") fail("zero amount subscription was not activated");

  const starterCookie = await login("starter@example.com");
  const starterCheckout = await request("/api/billing/checkout", { method: "POST", headers: { cookie: starterCookie }, body: JSON.stringify({ idempotencyKey: "starter-trial-checkout" }) });
  if (starterCheckout.status !== 409 || starterCheckout.json().code !== "PAYMENT_NOT_REQUIRED") fail(`Starter trial checkout was not blocked: ${starterCheckout.status} ${starterCheckout.text}`);

  console.log("Stripe PromptPay checks passed.");
})().catch(error => {
  console.error(error);
  process.exit(1);
});
