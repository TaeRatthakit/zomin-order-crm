"use strict";

process.env.NODE_ENV = "test";
process.env.DATABASE_PROVIDER = "supabase";
process.env.SUPABASE_URL = "https://subscription-upgrade-test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.SESSION_SECRET = "subscription-upgrade-test-session-secret";
process.env.AUTH_RATE_LIMIT_MAX = "500";
process.env.PAYMENT_PROVIDER_ENABLED = "true";
process.env.PAYMENT_PROVIDER = "stripe_promptpay";
process.env.STRIPE_TEST_SECRET_KEY = "sk_test_mock_secret";
process.env.STRIPE_TEST_WEBHOOK_SECRET = "whsec_mock_secret";
process.env.VERCEL_ENV = "preview";

const path = require("path");
const crypto = require("crypto");
const assert = require("node:assert/strict");
const { Readable } = require("stream");
const { hashPassword } = require("../lib/auth");

const ROOT = path.join(__dirname, "..");
const nowIso = "2026-08-22T00:00:00.000Z";
const ids = {
  starter: "11111111-1111-4111-8111-111111111111",
  business: "22222222-2222-4222-8222-222222222222",
  failure: "33333333-3333-4333-8333-333333333333",
  legacy: "44444444-4444-4444-8444-444444444444",
  replacement: "55555555-5555-4555-8555-555555555555"
};

const db = {
  tenants: [
    { id: ids.starter, name: "Starter Tenant", status: "active" },
    { id: ids.business, name: "Business Tenant", status: "active" },
    { id: ids.failure, name: "Failure Tenant", status: "active" },
    { id: ids.legacy, name: "Legacy Pending Tenant", status: "active" },
    { id: ids.replacement, name: "Replacement Tenant", status: "active" }
  ],
  users: [
    { id: "u_starter", username: "starter@example.com", password_hash: hashPassword("pass12345"), name: "Starter Owner", role: "Owner", is_active: true },
    { id: "u_business", username: "business@example.com", password_hash: hashPassword("pass12345"), name: "Business Owner", role: "Owner", is_active: true },
    { id: "u_failure", username: "failure@example.com", password_hash: hashPassword("pass12345"), name: "Failure Owner", role: "Owner", is_active: true },
    { id: "u_legacy", username: "legacy@example.com", password_hash: hashPassword("pass12345"), name: "Legacy Owner", role: "Owner", is_active: true },
    { id: "u_replacement", username: "replacement@example.com", password_hash: hashPassword("pass12345"), name: "Replacement Owner", role: "Owner", is_active: true },
    { id: "u_staff", username: "staff@example.com", password_hash: hashPassword("pass12345"), name: "Staff", role: "Staff", is_active: true }
  ],
  tenant_memberships: [
    { id: "m_starter", tenant_id: ids.starter, user_id: "u_starter", role: "Owner", is_active: true },
    { id: "m_business", tenant_id: ids.business, user_id: "u_business", role: "Owner", is_active: true },
    { id: "m_failure", tenant_id: ids.failure, user_id: "u_failure", role: "Owner", is_active: true },
    { id: "m_legacy", tenant_id: ids.legacy, user_id: "u_legacy", role: "Owner", is_active: true },
    { id: "m_replacement", tenant_id: ids.replacement, user_id: "u_replacement", role: "Owner", is_active: true },
    { id: "m_staff", tenant_id: ids.starter, user_id: "u_staff", role: "Staff", is_active: true }
  ],
  subscriptions: [
    { id: "s_starter", tenant_id: ids.starter, is_initial: true, plan: "starter", billing_interval: "monthly", status: "trialing", currency: "THB", base_amount_minor: 49000, discount_amount_minor: 0, amount_due_minor: 49000, trial_ends_at: "2099-01-01T00:00:00.000Z", created_at: nowIso, updated_at: nowIso },
    { id: "s_business", tenant_id: ids.business, is_initial: true, plan: "business", billing_interval: "monthly", status: "active", currency: "THB", base_amount_minor: 99000, discount_amount_minor: 0, amount_due_minor: 99000, current_period_ends_at: "2099-01-01T00:00:00.000Z", created_at: nowIso, updated_at: nowIso },
    { id: "s_failure", tenant_id: ids.failure, is_initial: true, plan: "starter", billing_interval: "monthly", status: "trialing", currency: "THB", base_amount_minor: 49000, discount_amount_minor: 0, amount_due_minor: 49000, trial_ends_at: "2099-01-01T00:00:00.000Z", created_at: nowIso, updated_at: nowIso },
    { id: "s_legacy", tenant_id: ids.legacy, is_initial: true, plan: "starter", billing_interval: "monthly", status: "trialing", currency: "THB", base_amount_minor: 49000, discount_amount_minor: 0, amount_due_minor: 49000, trial_ends_at: "2099-01-01T00:00:00.000Z", created_at: nowIso, updated_at: nowIso },
    { id: "s_replacement", tenant_id: ids.replacement, is_initial: true, plan: "business", billing_interval: "monthly", status: "active", currency: "THB", base_amount_minor: 99000, discount_amount_minor: 0, amount_due_minor: 99000, current_period_ends_at: "2099-01-01T00:00:00.000Z", created_at: nowIso, updated_at: nowIso }
  ],
  payments: [],
  subscription_upgrade_attempts: [],
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

let intentSequence = 1;
const stripeIntents = new Map();
const stripeCreateRequests = [];
const stripeCancelRequests = [];
let stripeCancelFailure = false;
const stripeRetrieveRequests = [];
let subscriptionUpgradeSuccessRpcCalls = 0;
let subscriptionUpgradeSuccessEffects = 0;

function fail(message) { throw new Error(message); }
function jsonResponse(value, status = 200) { return new Response(JSON.stringify(value), { status }); }
function parseValue(raw = "") { return decodeURIComponent(String(raw).replace(/^"|"$/g, "")); }
function parseIn(raw = "") { return parseValue(raw).replace(/^\(|\)$/g, "").split(",").map(item => item.replace(/^"|"$/g, "")).filter(Boolean); }
function applyFilters(rows, params) {
  let out = [...rows];
  for (const [key, value] of params.entries()) {
    if (["select", "limit", "order", "on_conflict", "tenant_memberships.is_active"].includes(key)) continue;
    if (value.startsWith("eq.")) out = out.filter(row => String(row[key]) === parseValue(value.slice(3)));
    if (value === "is.null") out = out.filter(row => row[key] == null);
    if (value.startsWith("in.")) {
      const values = new Set(parseIn(value.slice(3)));
      out = out.filter(row => values.has(String(row[key])));
    }
  }
  const limit = Number(params.get("limit") || 0);
  return limit ? out.slice(0, limit) : out;
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
    created_at: payment.created_at
  };
}
function upgradeRpcRow(upgrade, payment) {
  return {
    upgrade_id: upgrade.id,
    payment_id: payment.id,
    tenant_id: upgrade.tenant_id,
    subscription_id: upgrade.subscription_id,
    current_plan: upgrade.current_plan,
    target_plan: upgrade.target_plan,
    provider: upgrade.provider,
    status: upgrade.status,
    currency: upgrade.currency,
    amount_minor: upgrade.amount_minor,
    billing_interval: upgrade.billing_interval,
    idempotency_key: upgrade.idempotency_key,
    provider_payment_reference: upgrade.provider_payment_reference,
    billing_period_started_at: payment.billing_period_started_at,
    billing_period_ends_at: payment.billing_period_ends_at,
    created_at: upgrade.created_at,
    paid_at: payment.paid_at || null
  };
}
function rpcError(code) { return jsonResponse({ message: code }, 400); }
function beginUpgrade(payload = {}) {
  const tenantId = String(payload.p_tenant_id || "");
  const userId = String(payload.p_user_id || "");
  const targetPlan = String(payload.p_target_plan || "");
  const key = String(payload.p_idempotency_key || "");
  const provider = String(payload.p_provider || "provider_required");
  const membership = db.tenant_memberships.find(row => row.tenant_id === tenantId && row.user_id === userId && row.is_active && row.role === "Owner");
  if (!membership) return rpcError("UPGRADE_TENANT_FORBIDDEN");
  const subscription = db.subscriptions.find(row => row.tenant_id === tenantId && row.is_initial);
  if (!subscription) return rpcError("SUBSCRIPTION_NOT_FOUND");
  const order = { starter: 0, business: 1, enterprise: 2 };
  if (!order[targetPlan] || order[targetPlan] <= order[subscription.plan]) return rpcError("UPGRADE_NOT_ALLOWED");
  const existing = db.subscription_upgrade_attempts.find(row => row.tenant_id === tenantId && row.idempotency_key === key);
  if (existing) return jsonResponse([upgradeRpcRow(existing, db.payments.find(row => row.id === existing.payment_id))]);
  const pending = db.subscription_upgrade_attempts.find(row => row.tenant_id === tenantId && ["pending", "processing"].includes(row.status));
  if (pending) {
    if (pending.target_plan !== targetPlan) return rpcError("UPGRADE_IN_PROGRESS");
    return jsonResponse([upgradeRpcRow(pending, db.payments.find(row => row.id === pending.payment_id))]);
  }
  const amount = targetPlan === "business" ? 99000 : 199000;
  const payment = { id: `p_${crypto.randomUUID()}`, tenant_id: tenantId, subscription_id: subscription.id, idempotency_key: key, provider, provider_payment_reference: null, status: "pending", currency: "THB", amount_minor: amount, plan: targetPlan, billing_interval: "monthly", billing_period_started_at: nowIso, billing_period_ends_at: "2026-09-22T00:00:00.000Z", checkout_metadata: { operation: "subscription_upgrade", current_plan: subscription.plan, target_plan: targetPlan }, created_at: nowIso };
  const upgrade = { id: `u_${crypto.randomUUID()}`, tenant_id: tenantId, subscription_id: subscription.id, payment_id: payment.id, idempotency_key: key, current_plan: subscription.plan, target_plan: targetPlan, currency: "THB", amount_minor: amount, billing_interval: "monthly", provider, provider_payment_reference: null, status: "pending", created_at: nowIso };
  db.payments.push(payment);
  db.subscription_upgrade_attempts.push(upgrade);
  return jsonResponse([upgradeRpcRow(upgrade, payment)]);
}
function setProviderReference(payload = {}) {
  const payment = db.payments.find(row => row.id === payload.p_payment_id);
  if (!payment || payment.tenant_id !== payload.p_tenant_id) return rpcError("PAYMENT_NOT_FOUND");
  payment.provider_payment_reference = payload.p_provider_payment_reference;
  payment.status = payload.p_status || "pending";
  payment.provider_metadata = { ...payment.provider_metadata, ...payload.p_provider_metadata };
  const upgrade = db.subscription_upgrade_attempts.find(row => row.payment_id === payment.id);
  if (upgrade) upgrade.provider_payment_reference = payment.provider_payment_reference;
  return jsonResponse([paymentRpcRow(payment)]);
}
function reconcileUpgrade(payload = {}, success) {
  const payment = db.payments.find(row => row.id === payload.p_payment_id);
  const upgrade = db.subscription_upgrade_attempts.find(row => row.payment_id === payload.p_payment_id);
  const subscription = db.subscriptions.find(row => row.id === upgrade?.subscription_id);
  if (!payment || !upgrade || !subscription) return rpcError("SUBSCRIPTION_UPGRADE_NOT_FOUND");
  const existingEvent = db.payment_provider_events.find(row => row.provider === payload.p_provider && row.provider_event_id === payload.p_provider_event_id);
  if (existingEvent) return jsonResponse([upgradeRpcRow(upgrade, payment)]);
  if (payment.amount_minor !== Number(payload.p_amount_minor) || payload.p_currency !== "THB" || payment.provider !== payload.p_provider || !["pending", "processing"].includes(payment.status)) return rpcError("SUBSCRIPTION_UPGRADE_EVENT_MISMATCH");
  db.payment_provider_events.push({ provider: payload.p_provider, provider_event_id: payload.p_provider_event_id, payment_id: payment.id,
    status: "processed", event_type: success ? "subscription_upgrade_payment_succeeded" : `subscription_upgrade_payment_${payload.p_status}`,
    raw_event: payload.p_raw_event, processed_at: nowIso });
  if (success) {
    subscriptionUpgradeSuccessEffects += 1;
    payment.status = "paid";
    payment.paid_at = nowIso;
    upgrade.status = "paid";
    upgrade.paid_at = nowIso;
    subscription.plan = upgrade.target_plan;
    subscription.status = "active";
    subscription.billing_interval = "monthly";
    subscription.base_amount_minor = upgrade.amount_minor;
    subscription.amount_due_minor = upgrade.amount_minor;
    subscription.discount_amount_minor = 0;
  } else {
    payment.status = payload.p_status;
    upgrade.status = payload.p_status;
    if (["failed", "cancelled", "expired"].includes(payload.p_status)) payment[`${payload.p_status}_at`] = nowIso;
    payment.provider_metadata = { ...payment.provider_metadata, last_event_id: payload.p_provider_event_id, last_provider_status: payload.p_status };
  }
  return jsonResponse([upgradeRpcRow(upgrade, payment)]);
}

global.fetch = async function mockFetch(input, options = {}) {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com") {
    const cancelMatch = url.pathname.match(/^\/v1\/payment_intents\/([^/]+)\/cancel$/);
    if (cancelMatch) {
      stripeCancelRequests.push(cancelMatch[1]);
      if (stripeCancelFailure) return jsonResponse({ error: { message: "cancel failed", code: "cancel_failed" } }, 500);
      const canceled = stripeIntents.get(cancelMatch[1]);
      if (!canceled) return jsonResponse({ error: { message: "not found" } }, 404);
      canceled.status = "canceled";
      if (process.env.TASK5_TEST_WEBHOOK_RACE === "true") {
        // A previous deployed webhook can win before the checkout's status
        // RPC. Reproduce its generic writer: payment terminal, attempt pending.
        const payment = db.payments.find(row => row.provider_payment_reference === canceled.id);
        if (db.subscription_upgrade_attempts.some(row => row.payment_id === payment?.id)) {
          payment.status = "cancelled";
          payment.cancelled_at = nowIso;
          const eventId = `evt_racing_cancel_${payment.id}`;
          payment.provider_metadata = { ...payment.provider_metadata, last_event_id: eventId };
          db.payment_provider_events.push({ provider: payment.provider, provider_event_id: eventId,
            payment_id: payment.id, status: "processed", event_type: "payment_cancelled", processed_at: nowIso,
            raw_event: { id: eventId, type: "payment_intent.canceled", livemode: false, data: { object: structuredClone(canceled) } } });
        }
      }
      return jsonResponse(canceled);
    }
    if (String(options.method || "GET").toUpperCase() === "GET") {
      const id = url.pathname.split("/").at(-1);
      stripeRetrieveRequests.push(id);
      return jsonResponse(stripeIntents.get(id) || { error: { message: "not found" } }, stripeIntents.has(id) ? 200 : 404);
    }
    stripeCreateRequests.push({ body: String(options.body || "") });
    const params = new URLSearchParams(options.body || "");
    const id = `pi_upgrade_${intentSequence++}`;
    const intent = { id, status: "requires_action", livemode: false, amount_received: 0, amount: Number(params.get("amount")), currency: "thb", client_secret: `${id}_secret_test`, next_action: { promptpay_display_qr_code: { image_url_png: "data:image/png;base64,cXJ0ZXN0", hosted_instructions_url: "https://pay.stripe.test/promptpay" } }, metadata: Object.fromEntries([...params.entries()].filter(([key]) => key.startsWith("metadata[")).map(([key, value]) => [key.slice(9, -1), value])) };
    stripeIntents.set(id, intent);
    return jsonResponse(intent);
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.at(-2) === "rpc") {
    const name = parts.at(-1);
    const payload = JSON.parse(options.body || "{}");
    if (name === "growup_begin_subscription_checkout") return beginCheckout(payload);
    if (name === "growup_record_provider_payment_status") {
      const payment = db.payments.find(row => row.id === payload.p_payment_id);
      if (!payment) return rpcError("PAYMENT_NOT_FOUND");
      if (!db.payment_provider_events.some(row => row.provider_event_id === payload.p_provider_event_id)) {
        if (!["pending", "processing"].includes(payment.status)) return rpcError("PAYMENT_STATUS_INVALID");
        payment.status = payload.p_status;
        payment[`${payload.p_status}_at`] = nowIso;
        payment.provider_metadata = { ...payment.provider_metadata, last_event_id: payload.p_provider_event_id, last_provider_status: payload.p_status };
        db.payment_provider_events.push({ provider: payment.provider, provider_event_id: payload.p_provider_event_id, payment_id: payment.id,
          status: "processed", event_type: `payment_${payload.p_status}`, processed_at: nowIso, raw_event: payload.p_raw_event });
      }
      return jsonResponse([paymentRpcRow(payment)]);
    }
    if (name === "growup_record_subscription_checkout_success") {
      return reconcileUpgrade(payload, true);
    }
    if (name === "growup_begin_subscription_upgrade") return beginUpgrade(payload);
    if (name === "growup_set_payment_provider_reference") return setProviderReference(payload);
    if (name === "growup_record_subscription_upgrade_success") {
      subscriptionUpgradeSuccessRpcCalls += 1;
      return reconcileUpgrade(payload, true);
    }
    if (name === "growup_record_subscription_upgrade_status") return reconcileUpgrade(payload, false);
  }
  const table = parts.at(-1);
  if (!Object.prototype.hasOwnProperty.call(db, table)) return jsonResponse({ message: `unknown table ${table}` }, 404);
  const method = String(options.method || "GET").toUpperCase();
  if (method === "GET") {
    let rows = applyFilters(db[table], url.searchParams);
    if (table === "users" && String(url.searchParams.get("select") || "").includes("tenant_memberships(")) {
      const activeOnly = url.searchParams.get("tenant_memberships.is_active") === "eq.true";
      rows = rows.map(user => ({
        ...user,
        tenant_memberships: db.tenant_memberships
          .filter(membership => membership.user_id === user.id && (!activeOnly || membership.is_active === true))
          .map(membership => ({
            tenant_id: membership.tenant_id,
            role: membership.role,
            is_active: membership.is_active,
            tenant: db.tenants.find(tenant => tenant.id === membership.tenant_id) || null
          }))
      }));
    } else if (table === "tenant_memberships" && String(url.searchParams.get("select") || "").includes("tenant:tenants(")) {
      rows = rows.map(row => ({
        tenant_id: row.tenant_id,
        role: row.role,
        tenant: db.tenants.find(tenant => tenant.id === row.tenant_id) || null
      }));
    }
    return jsonResponse(rows);
  }
  if (method === "PATCH" && table === "subscription_upgrade_attempts") {
    const rows = applyFilters(db[table], url.searchParams);
    const body = JSON.parse(options.body || "{}");
    for (const row of rows) Object.assign(row, body);
    return jsonResponse(rows);
  }
  return jsonResponse([], 200);
};

const appHandler = require(path.join(process.env.TASK5_TEST_SOURCE_ROOT || ROOT, "server"));
function header(headers, name) { const found = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase()); return found ? found[1] : ""; }
function request(pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(options.body ? [options.body] : []);
    req.method = options.method || "GET";
    req.url = pathname;
    req.headers = { host: "127.0.0.1", "content-type": "application/json", ...(options.headers || {}) };
    const chunks = [];
    const res = { statusCode: 200, headers: {}, writeHead(status, headers = {}) { this.statusCode = status; this.headers = { ...this.headers, ...headers }; }, end(chunk) { if (chunk) chunks.push(Buffer.from(String(chunk))); const text = Buffer.concat(chunks).toString("utf8"); resolve({ status: this.statusCode, headers: this.headers, text, json: () => text ? JSON.parse(text) : {} }); } };
    Promise.resolve(appHandler(req, res)).catch(reject);
  });
}
async function login(username) {
  const res = await request("/api/login", { method: "POST", body: JSON.stringify({ username, password: "pass12345" }) });
  if (res.status !== 200) fail(`${username} login failed: ${res.status} ${res.text}`);
  return header(res.headers, "set-cookie");
}
function webhookPayload(type, payment, status = "succeeded") {
  return JSON.stringify({ id: `evt_${payment.id}_${type}`, type, created: 1755820800, livemode: false, data: { object: { id: payment.provider_payment_reference, status, amount: payment.amount_minor, currency: "thb", metadata: { growup_payment_id: payment.id, growup_tenant_id: payment.tenant_id, growup_plan: payment.plan } } } });
}
async function postWebhook(payload) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac("sha256", process.env.STRIPE_TEST_WEBHOOK_SECRET).update(`${timestamp}.${payload}`, "utf8").digest("hex");
  return request("/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": `t=${timestamp},v1=${signature}` }, body: payload });
}

// Mirrors the deployed lifecycle RPC's payment-first selection. Attempts have
// exactly the schema's columns: period bounds belong ONLY to payments.
function beginCheckout(payload) {
  const subscription = db.subscriptions.find(row => row.tenant_id === payload.p_tenant_id);
  const existing = db.payments.find(row => row.tenant_id === payload.p_tenant_id && row.idempotency_key === payload.p_idempotency_key)
    || db.payments.find(row => row.tenant_id === payload.p_tenant_id && ["pending", "processing"].includes(row.status));
  if (existing) {
    if (existing.plan !== payload.p_target_plan || existing.billing_interval !== payload.p_billing_interval
      || existing.checkout_metadata.operation !== payload.p_intent) return rpcError("SUBSCRIPTION_CHECKOUT_IN_PROGRESS");
    const attempt = db.subscription_upgrade_attempts.find(row => row.payment_id === existing.id);
    return jsonResponse([{ ...paymentRpcRow(existing), current_plan: subscription.plan, target_plan: existing.plan,
      operation: payload.p_intent, upgrade_id: attempt?.id }]);
  }
  const payment = { id: crypto.randomUUID(), tenant_id: payload.p_tenant_id, subscription_id: subscription.id,
    idempotency_key: payload.p_idempotency_key, provider: payload.p_provider, status: "pending", currency: "THB",
    amount_minor: payload.p_target_plan === "business" ? 99000 : 199000, plan: payload.p_target_plan,
    billing_interval: payload.p_billing_interval, billing_period_started_at: nowIso, billing_period_ends_at: "2026-09-22T00:00:00.000Z",
    checkout_metadata: { operation: payload.p_intent, current_plan: subscription.plan, target_plan: payload.p_target_plan },
    created_at: new Date(Date.now() + db.payments.length).toISOString(), paid_at: null };
  db.payments.push(payment);
  let attempt;
  if (payload.p_intent === "subscription_upgrade") {
    attempt = { id: crypto.randomUUID(), tenant_id: payment.tenant_id, subscription_id: payment.subscription_id, payment_id: payment.id,
      idempotency_key: payment.idempotency_key, current_plan: subscription.plan, target_plan: payment.plan, provider: payment.provider,
      status: "pending", currency: payment.currency, amount_minor: payment.amount_minor, billing_interval: payment.billing_interval,
      provider_payment_reference: null, paid_at: null, created_at: payment.created_at, updated_at: payment.created_at };
    db.subscription_upgrade_attempts.push(attempt);
  }
  return jsonResponse([{ ...paymentRpcRow(payment), current_plan: subscription.plan, target_plan: payment.plan,
    operation: payload.p_intent, upgrade_id: attempt?.id }]);
}

const adapter = require(path.join(process.env.TASK5_TEST_SOURCE_ROOT || ROOT, "lib/db/supabase-adapter"));
const trace = [];
function state(label, tenantId) {
  const rows = db.payments.filter(row => row.tenant_id === tenantId).map(payment => {
    const attempt = db.subscription_upgrade_attempts.find(row => row.payment_id === payment.id);
    return { tenantId, package: payment.plan, billing: payment.billing_interval, paymentId: payment.id,
      intent: payment.provider_payment_reference, paymentStatus: payment.status, attemptId: attempt?.id,
      attemptStatus: attempt?.status, pendingUpgrade: attempt && ["pending", "processing"].includes(attempt.status),
      resumable: ["pending", "processing"].includes(payment.status), terminal: ["failed", "cancelled", "expired"].includes(payment.status) };
  });
  trace.push({ label, rows, retrieved: [...stripeRetrieveRequests], created: stripeCreateRequests.length });
  console.log("LIFECYCLE_STATE", JSON.stringify(trace.at(-1)));
}
async function checkout(cookie, targetPlan) {
  const res = await request(targetPlan === "enterprise" ? "/api/billing/upgrade" : "/api/billing/checkout", {
    method: "POST", headers: { cookie }, body: JSON.stringify({ targetPlan, billingInterval: "monthly", confirmReplacement: true }) });
  assert.equal(res.status, 200, `Owner lifecycle blocked: ${res.status} ${res.text}`);
  assert.ok(!res.text.includes("รายการเดิมยังตรวจสอบเพื่อเริ่มรายการใหม่ไม่ได้"));
  assert.ok(res.json().promptpay.promptpay.imageUrlPng);
  return db.payments.find(row => row.id === res.json().payment.id);
}

// Optional loopback-only renderer uses these same mocked adapters/data. It
// permits Golden comparisons without real datasource or payment mutations.
if (process.env.TASK5_TEST_SERVE) {
  require("node:http").createServer(appHandler).listen(Number(process.env.TASK5_TEST_SERVE), "127.0.0.1");
}
if (!process.env.TASK5_TEST_SERVE) (async () => {
  const tenantId = ids.replacement;
  const cookie = await login("replacement@example.com");
  const before = JSON.stringify(db.subscriptions);
  const business = await checkout(cookie, "business"); state("1 Business QR", tenantId);
  const enterprise = await checkout(cookie, "enterprise"); state("2 Enterprise QR", tenantId);
  assert.equal(business.status, "cancelled");
  assert.ok(!Object.hasOwn(db.subscription_upgrade_attempts.find(row => row.payment_id === enterprise.id), "billing_period_started_at"));
  // Always exercise the real Preview race in the mandatory continuous case.
  process.env.TASK5_TEST_WEBHOOK_RACE = "true";
  const back = await checkout(cookie, "business"); state("3 Business QR", tenantId);
  delete process.env.TASK5_TEST_WEBHOOK_RACE;
  assert.equal(enterprise.status, "cancelled");
  assert.equal(db.subscription_upgrade_attempts.find(row => row.payment_id === enterprise.id).status, "cancelled");
  const createCount = stripeCreateRequests.length;
  const freshCookie = await login("replacement@example.com");
  assert.equal((await checkout(freshCookie, "business")).id, back.id);
  const reload = await request("/api/billing/reconcile", { method: "POST", headers: { cookie: freshCookie }, body: "{}" });
  assert.equal(reload.status, 200);
  assert.equal(reload.json().resumePayload.payment.id, back.id);
  assert.equal(stripeCreateRequests.length, createCount);
  assert.equal(JSON.stringify(db.subscriptions), before);
  // Processing and unknown provider outcomes may not cancel or create another
  // checkout. Correct the provider fixture only AFTER checking each refusal.
  const activeIntent = stripeIntents.get(back.provider_payment_reference);
  for (const providerState of ["processing", "unknown"]) {
    activeIntent.status = providerState;
    const refused = await request("/api/billing/upgrade", { method: "POST", headers: { cookie: freshCookie },
      body: JSON.stringify({ targetPlan: "enterprise", confirmReplacement: true }) });
    assert.equal(refused.status, 409);
    assert.equal(stripeCreateRequests.length, createCount);
    assert.equal(back.status, "pending");
  }
  activeIntent.status = "requires_action";

  // Terminal historical generic writer + pending attempt: preserve accumulated
  // state. Test every schema-supported terminal NON-success (not refunded).
  for (const terminal of ["failed", "cancelled", "expired"]) {
    const tenant = terminal === "failed" ? ids.failure : terminal === "cancelled" ? ids.legacy : ids.business;
    const username = terminal === "failed" ? "failure@example.com" : terminal === "cancelled" ? "legacy@example.com" : "business@example.com";
    const c = await login(username);
    const p = await checkout(c, "enterprise");
    const a = db.subscription_upgrade_attempts.find(row => row.payment_id === p.id);
    const event = { id: `evt_generic_${terminal}`, type: terminal === "failed" ? "payment_intent.payment_failed" : "payment_intent.canceled",
      livemode: false, data: { object: { ...stripeIntents.get(p.provider_payment_reference),
        status: terminal === "failed" ? "requires_payment_method" : "canceled", next_action: undefined } } };
    await adapter.recordProviderPaymentStatus({ paymentId: p.id, provider: p.provider, providerEventId: event.id,
      providerPaymentReference: p.provider_payment_reference, status: terminal, amountMinor: p.amount_minor, currency: p.currency, rawEvent: event });
    // Simulate a pre-fix/in-flight generic writer snapshot without resetting
    // this tenant's payments/history. The actual reconcile/checkout must heal it.
    a.status = "pending";
    const retrieved = stripeRetrieveRequests.length;
    const reconcile = await request("/api/billing/reconcile", { method: "POST", headers: { cookie: c }, body: "{}" });
    assert.equal(reconcile.status, 200);
    assert.equal(a.status, terminal, `terminal ${terminal} retained pending attempt`);
    assert.equal(stripeRetrieveRequests.length, retrieved, "obsolete terminal intent retrieved");
    const eventCount = db.payment_provider_events.length;
    await request("/api/billing/reconcile", { method: "POST", headers: { cookie: c }, body: "{}" });
    assert.equal(db.payment_provider_events.length, eventCount);
    await checkout(c, tenant === ids.business ? "business" : "enterprise");
    // Duplicate signed delivery must not resurrect terminal state or activate.
    assert.equal((await postWebhook(JSON.stringify(event))).status, 200);
    assert.equal(p.status, terminal);
    assert.equal(a.status, terminal);
  }
  // Actual expired QR retrieval, not just an expired local label.
  const expiryCookie = await login("business@example.com");
  const expiring = await checkout(expiryCookie, "enterprise");
  const expiringIntent = stripeIntents.get(expiring.provider_payment_reference);
  expiringIntent.next_action.promptpay_display_qr_code.expires_at = Math.floor(Date.now()/1000)-30;
  const expiryRes = await request("/api/billing/reconcile", { method: "POST", headers: { cookie: expiryCookie }, body: "{}" });
  assert.equal(expiryRes.status, 200);
  assert.equal(expiring.status, "expired");
  assert.equal(db.subscription_upgrade_attempts.find(row => row.payment_id === expiring.id).status, "expired");
  await checkout(expiryCookie, "business");
  // Business renewal failed/cancelled -> Business again, accumulated SAME
  // tenant history, through real webhook and real checkout code, no reset.
  let currentBusiness = back;
  for (const terminal of ["failed", "cancelled"]) {
    const type = terminal === "failed" ? "payment_intent.payment_failed" : "payment_intent.canceled";
    const raw = { id: `evt_renewal_${terminal}`, type, livemode: false,
      data: { object: { ...stripeIntents.get(currentBusiness.provider_payment_reference),
        status: terminal === "failed" ? "requires_payment_method" : "canceled", next_action: undefined } } };
    assert.equal((await postWebhook(JSON.stringify(raw))).status, 200);
    assert.equal(currentBusiness.status, terminal);
    assert.equal((await postWebhook(JSON.stringify(raw))).status, 200);
    currentBusiness = await checkout(freshCookie, "business");
  }
  // Guard matrix against the same durable proof. Unsafe fixtures are local
  // isolated data only, never used as the persistent B/E/B tenant above.
  const guarded = db.payments.find(row => row.tenant_id === ids.business && row.plan === "enterprise");
  const guardedAttempt = db.subscription_upgrade_attempts.find(row => row.payment_id === guarded.id);
  const guardedEvent = db.payment_provider_events.find(row => row.payment_id === guarded.id);
  for (const unsafe of ["cross-tenant", "processing-attempt", "paid-attempt", "processing-payment", "paid-payment", "refunded", "unprocessed-proof", "activated", "successful-event"]) {
    const pCopy = { ...guarded }; const aCopy = { ...guardedAttempt }; const eCopy = { ...guardedEvent };
    const sub = db.subscriptions.find(row => row.id === guarded.subscription_id); const subCopy = { ...sub };
    guardedAttempt.status = "pending";
    if (unsafe === "cross-tenant") guardedAttempt.tenant_id = ids.starter;
    if (unsafe === "processing-attempt") guardedAttempt.status = "processing";
    if (unsafe === "paid-attempt") guardedAttempt.status = "paid";
    if (unsafe === "processing-payment") guarded.status = "processing";
    if (unsafe === "paid-payment") guarded.status = "paid";
    if (unsafe === "refunded") guarded.status = "refunded";
    if (unsafe === "unprocessed-proof") guardedEvent.status = "received";
    if (unsafe === "activated") sub.plan = "enterprise";
    if (unsafe === "successful-event") db.payment_provider_events.push({ payment_id: guarded.id, status: "processed", event_type: "payment_succeeded" });
    const unsafeBefore = JSON.stringify(guardedAttempt);
    assert.equal(await adapter.reconcileTerminalSubscriptionUpgradeAttempt({ paymentId: guarded.id, tenantId: guarded.tenant_id }), null, unsafe);
    assert.equal(JSON.stringify(guardedAttempt), unsafeBefore, unsafe);
    if (!["refunded", "unprocessed-proof", "processing-attempt", "processing-payment"].includes(unsafe)) {
      await assert.rejects(adapter.recordProviderPaymentStatus({ paymentId: guarded.id, provider: guarded.provider,
        providerEventId: 'evt_unsafe_guard', providerPaymentReference: guarded.provider_payment_reference,
        amountMinor: guarded.amount_minor, currency: guarded.currency, status: "cancelled", rawEvent: guardedEvent.raw_event }), /UNSAFE/);
      assert.equal(JSON.stringify(guardedAttempt), unsafeBefore);
    }
    if (unsafe === "successful-event") db.payment_provider_events.pop();
    Object.assign(guarded, pCopy); Object.assign(guardedAttempt, aCopy); Object.assign(guardedEvent, eCopy); Object.assign(sub, subCopy);
  }
  // Real signed success handler, unchanged exactly-once RPC: same event twice,
  // one activation and no replacement of the paid attempt.
  const successPayment = db.payments.find(row => row.tenant_id === ids.failure && row.status === "pending");
  const successEvent = webhookPayload("payment_intent.succeeded", successPayment);
  assert.equal((await postWebhook(successEvent)).status, 200);
  assert.equal((await postWebhook(successEvent)).status, 200);
  assert.equal(subscriptionUpgradeSuccessEffects, 1);
  assert.equal(successPayment.status, "paid");
  assert.equal(await adapter.reconcileTerminalSubscriptionUpgradeAttempt({ paymentId: successPayment.id, tenantId: successPayment.tenant_id }), null);
  state("final same tenant fresh-session/reload", tenantId);
  console.log("Payment state machine PASS: persistent B/E/B, fresh session, reload, resume/no duplicates, failed/cancelled/expired convergence.");
})().catch(error => { console.error(error); process.exitCode = 1; });
