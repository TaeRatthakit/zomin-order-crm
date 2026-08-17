"use strict";

process.env.NODE_ENV = "test";
process.env.DATABASE_PROVIDER = "supabase";
process.env.SUPABASE_URL = "https://payment-core-test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.SESSION_SECRET = "payment-core-test-session-secret";
process.env.AUTH_RATE_LIMIT_MAX = "500";

const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const crypto = require("crypto");
const { hashPassword } = require("../lib/auth");

const ROOT = path.join(__dirname, "..");
const migration = fs.readFileSync(path.join(ROOT, "supabase", "migrations", "20260814010000_payment_core.sql"), "utf8");

const nowIso = "2026-08-14T00:00:00.000Z";
const db = {
  tenants: [
    { id: "11111111-1111-4111-8111-111111111111", name: "Business Pending", status: "active", created_at: nowIso },
    { id: "22222222-2222-4222-8222-222222222222", name: "Starter Trial", status: "active", created_at: nowIso },
    { id: "33333333-3333-4333-8333-333333333333", name: "Starter Full", status: "active", created_at: nowIso }
  ],
  users: [
    { id: "u_business", username: "business@example.com", password_hash: hashPassword("pass12345"), name: "Business Owner", role: "Owner", phone: "", is_active: true },
    { id: "u_starter", username: "starter@example.com", password_hash: hashPassword("pass12345"), name: "Starter Owner", role: "Owner", phone: "", is_active: true },
    { id: "u_full", username: "full@example.com", password_hash: hashPassword("pass12345"), name: "Full Owner", role: "Owner", phone: "", is_active: true },
    { id: "u_full_2", username: "full2@example.com", password_hash: hashPassword("pass12345"), name: "Full 2", role: "Staff", phone: "", is_active: true },
    { id: "u_full_3", username: "full3@example.com", password_hash: hashPassword("pass12345"), name: "Full 3", role: "Staff", phone: "", is_active: true }
  ],
  tenant_memberships: [
    { id: "m_business", tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u_business", role: "Owner", is_active: true },
    { id: "m_starter", tenant_id: "22222222-2222-4222-8222-222222222222", user_id: "u_starter", role: "Owner", is_active: true },
    { id: "m_full", tenant_id: "33333333-3333-4333-8333-333333333333", user_id: "u_full", role: "Owner", is_active: true },
    { id: "m_full_2", tenant_id: "33333333-3333-4333-8333-333333333333", user_id: "u_full_2", role: "Staff", is_active: true },
    { id: "m_full_3", tenant_id: "33333333-3333-4333-8333-333333333333", user_id: "u_full_3", role: "Staff", is_active: true }
  ],
  subscriptions: [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", tenant_id: "11111111-1111-4111-8111-111111111111", is_initial: true, plan: "business", billing_interval: "monthly", status: "pending_payment", currency: "THB", base_amount_minor: 99000, discount_amount_minor: 19800, amount_due_minor: 79200, payment_due_at: nowIso, created_at: nowIso, updated_at: nowIso },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", tenant_id: "22222222-2222-4222-8222-222222222222", is_initial: true, plan: "starter", billing_interval: "monthly", status: "trialing", currency: "THB", base_amount_minor: 49000, discount_amount_minor: 0, amount_due_minor: 49000, trial_started_at: nowIso, trial_ends_at: "2099-01-01T00:00:00.000Z", current_period_ends_at: "2099-01-01T00:00:00.000Z", created_at: nowIso, updated_at: nowIso },
    { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", tenant_id: "33333333-3333-4333-8333-333333333333", is_initial: true, plan: "starter", billing_interval: "monthly", status: "trialing", currency: "THB", base_amount_minor: 49000, discount_amount_minor: 0, amount_due_minor: 49000, trial_started_at: nowIso, trial_ends_at: "2099-01-01T00:00:00.000Z", current_period_ends_at: "2099-01-01T00:00:00.000Z", created_at: nowIso, updated_at: nowIso }
  ],
  payments: [],
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

function fail(message) {
  throw new Error(message);
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
    billing_period_ends_at: "2026-09-14T00:00:00.000Z",
    created_at: nowIso
  };
  db.payments.push(payment);
  return new Response(JSON.stringify([paymentRpcRow(payment)]), { status: 200 });
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

global.fetch = async function mockFetch(input, options = {}) {
  const url = new URL(String(input));
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.at(-2) === "rpc" && parts.at(-1) === "growup_begin_subscription_payment") return beginPayment(JSON.parse(options.body || "{}"));
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

(async () => {
  for (const token of [
    "create table if not exists public.payments",
    "payment_provider_events",
    "uniq_payments_tenant_idempotency",
    "growup_begin_subscription_payment",
    "growup_record_provider_payment_success",
    "PAYMENT_EVENT_MISMATCH",
    "amount_minor"
  ]) {
    if (!migration.includes(token)) fail(`payment migration missing ${token}`);
  }

  const businessCookie = await login("business@example.com");
  const anonymousBilling = await request("/api/billing/subscription");
  if (anonymousBilling.status !== 401) fail(`anonymous billing snapshot should be denied before DB read: ${anonymousBilling.status} ${anonymousBilling.text}`);

  const blockedState = await request("/api/state", { headers: { cookie: businessCookie } });
  if (blockedState.status !== 402 || blockedState.json().code !== "SUBSCRIPTION_PAYMENT_REQUIRED") fail(`pending payment tenant was not gated: ${blockedState.status} ${blockedState.text}`);

  const billing = await request("/api/billing/subscription", { headers: { cookie: businessCookie } });
  if (billing.status !== 200 || billing.json().billing.subscription.amountDueMinor !== 79200) fail(`billing snapshot wrong: ${billing.status} ${billing.text}`);

  const checkoutBody = { idempotencyKey: "payment-core-checkout-1", amountMinor: 1, currency: "USD", tenantId: "22222222-2222-4222-8222-222222222222" };
  const checkoutA = await request("/api/billing/checkout", { method: "POST", headers: { cookie: businessCookie }, body: JSON.stringify(checkoutBody) });
  const checkoutB = await request("/api/billing/checkout", { method: "POST", headers: { cookie: businessCookie }, body: JSON.stringify(checkoutBody) });
  if (checkoutA.status !== 503 || checkoutA.json().code !== "PAYMENT_PROVIDER_REQUIRED") fail(`provider-required checkout wrong: ${checkoutA.status} ${checkoutA.text}`);
  if (checkoutA.json().payment.amountMinor !== 79200 || checkoutA.json().payment.currency !== "THB") fail("checkout trusted browser-supplied amount or currency");
  if (checkoutB.json().payment.id !== checkoutA.json().payment.id || db.payments.length !== 1) fail("checkout idempotency did not reuse the payment attempt");
  if (db.subscriptions.find(row => row.id === "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").status !== "pending_payment") fail("checkout activated subscription without verified provider success");

  const starterCookie = await login("starter@example.com");
  const starterState = await request("/api/state", { headers: { cookie: starterCookie } });
  if (starterState.status !== 200) fail(`valid Starter trial was gated: ${starterState.status} ${starterState.text}`);
  const starterCheckout = await request("/api/billing/checkout", { method: "POST", headers: { cookie: starterCookie }, body: JSON.stringify({ idempotencyKey: "starter-trial-checkout" }) });
  if (starterCheckout.status !== 409 || starterCheckout.json().code !== "PAYMENT_NOT_REQUIRED") fail(`starter trial checkout was not blocked: ${starterCheckout.status} ${starterCheckout.text}`);

  const fullCookie = await login("full@example.com");
  const seatLimit = await request("/api/team", {
    method: "POST",
    headers: { cookie: fullCookie },
    body: JSON.stringify({ name: "Fourth", username: "fourth@example.com", password: "pass12345", role: "Staff" })
  });
  if (seatLimit.status !== 402 || seatLimit.json().code !== "PLAN_USER_LIMIT_REACHED") fail(`Starter seat limit not enforced: ${seatLimit.status} ${seatLimit.text}`);

  console.log("Payment Core checks passed.");
})().catch(error => {
  console.error(error);
  process.exit(1);
});
