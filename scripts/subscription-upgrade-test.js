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

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const vm = require("vm");
const { Readable } = require("stream");
const { hashPassword } = require("../lib/auth");

const ROOT = path.join(__dirname, "..");
const migration = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260822010000_subscription_upgrade.sql"), "utf8");
const appSource = fs.readFileSync(path.join(ROOT, "public/app.js"), "utf8");
const nowIso = "2026-08-22T00:00:00.000Z";
const ids = {
  starter: "11111111-1111-4111-8111-111111111111",
  business: "22222222-2222-4222-8222-222222222222",
  failure: "33333333-3333-4333-8333-333333333333",
  legacy: "44444444-4444-4444-8444-444444444444"
};

const db = {
  tenants: [
    { id: ids.starter, name: "Starter Tenant", status: "active" },
    { id: ids.business, name: "Business Tenant", status: "active" },
    { id: ids.failure, name: "Failure Tenant", status: "active" },
    { id: ids.legacy, name: "Legacy Pending Tenant", status: "active" }
  ],
  users: [
    { id: "u_starter", username: "starter@example.com", password_hash: hashPassword("pass12345"), name: "Starter Owner", role: "Owner", is_active: true },
    { id: "u_business", username: "business@example.com", password_hash: hashPassword("pass12345"), name: "Business Owner", role: "Owner", is_active: true },
    { id: "u_failure", username: "failure@example.com", password_hash: hashPassword("pass12345"), name: "Failure Owner", role: "Owner", is_active: true },
    { id: "u_legacy", username: "legacy@example.com", password_hash: hashPassword("pass12345"), name: "Legacy Owner", role: "Owner", is_active: true },
    { id: "u_staff", username: "staff@example.com", password_hash: hashPassword("pass12345"), name: "Staff", role: "Staff", is_active: true }
  ],
  tenant_memberships: [
    { id: "m_starter", tenant_id: ids.starter, user_id: "u_starter", role: "Owner", is_active: true },
    { id: "m_business", tenant_id: ids.business, user_id: "u_business", role: "Owner", is_active: true },
    { id: "m_failure", tenant_id: ids.failure, user_id: "u_failure", role: "Owner", is_active: true },
    { id: "m_legacy", tenant_id: ids.legacy, user_id: "u_legacy", role: "Owner", is_active: true },
    { id: "m_staff", tenant_id: ids.starter, user_id: "u_staff", role: "Staff", is_active: true }
  ],
  subscriptions: [
    { id: "s_starter", tenant_id: ids.starter, is_initial: true, plan: "starter", billing_interval: "monthly", status: "trialing", currency: "THB", base_amount_minor: 49000, discount_amount_minor: 0, amount_due_minor: 49000, trial_ends_at: "2099-01-01T00:00:00.000Z", created_at: nowIso, updated_at: nowIso },
    { id: "s_business", tenant_id: ids.business, is_initial: true, plan: "business", billing_interval: "monthly", status: "active", currency: "THB", base_amount_minor: 99000, discount_amount_minor: 0, amount_due_minor: 99000, current_period_ends_at: "2099-01-01T00:00:00.000Z", created_at: nowIso, updated_at: nowIso },
    { id: "s_failure", tenant_id: ids.failure, is_initial: true, plan: "starter", billing_interval: "monthly", status: "trialing", currency: "THB", base_amount_minor: 49000, discount_amount_minor: 0, amount_due_minor: 49000, trial_ends_at: "2099-01-01T00:00:00.000Z", created_at: nowIso, updated_at: nowIso },
    { id: "s_legacy", tenant_id: ids.legacy, is_initial: true, plan: "starter", billing_interval: "monthly", status: "trialing", currency: "THB", base_amount_minor: 49000, discount_amount_minor: 0, amount_due_minor: 49000, trial_ends_at: "2099-01-01T00:00:00.000Z", created_at: nowIso, updated_at: nowIso }
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
  db.payment_provider_events.push({ provider: payload.p_provider, provider_event_id: payload.p_provider_event_id, payment_id: payment.id });
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
  }
  return jsonResponse([upgradeRpcRow(upgrade, payment)]);
}

global.fetch = async function mockFetch(input, options = {}) {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com") {
    if (String(options.method || "GET").toUpperCase() === "GET") {
      const id = url.pathname.split("/").at(-1);
      stripeRetrieveRequests.push(id);
      return jsonResponse(stripeIntents.get(id) || { error: { message: "not found" } }, stripeIntents.has(id) ? 200 : 404);
    }
    stripeCreateRequests.push({ body: String(options.body || "") });
    const params = new URLSearchParams(options.body || "");
    const id = `pi_upgrade_${intentSequence++}`;
    const intent = { id, status: "requires_action", amount: Number(params.get("amount")), currency: "thb", client_secret: `${id}_secret_test`, next_action: { promptpay_display_qr_code: { image_url_png: "data:image/png;base64,cXJ0ZXN0", hosted_instructions_url: "https://pay.stripe.test/promptpay" } } };
    stripeIntents.set(id, intent);
    return jsonResponse(intent);
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.at(-2) === "rpc") {
    const name = parts.at(-1);
    const payload = JSON.parse(options.body || "{}");
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

const appHandler = require("../server");
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

async function verifyCheckoutInitializationStateMachine() {
  const start = appSource.indexOf("const SUBSCRIPTION_INITIALIZATION_TIMEOUT_MS = ");
  const end = appSource.indexOf("\n/* pricing-scope: authenticated-upgrade-state:end */", start);
  if (start < 0 || end < 0) fail("checkout initialization helper boundary is missing");
  const helperSource = appSource.slice(start, end).replace("SUBSCRIPTION_INITIALIZATION_TIMEOUT_MS = 15000", "SUBSCRIPTION_INITIALIZATION_TIMEOUT_MS = 8");
  function harness(api) {
    const context = {
      app: { subscriptionCheckoutDraft: null, subscriptionQuoteLoading: false, pricingUpgradeLoading: "busy", data: {} },
      api,
      render() {},
      window: { setTimeout, clearTimeout }
    };
    vm.createContext(context);
    vm.runInContext(`${helperSource}\nthis.initialize = initializeSubscriptionCheckout; this.blockReason = subscriptionCheckoutBlockReason;`, context);
    return context;
  }
  function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));

  const quote = deferred();
  const reconciliation = deferred();
  const requests = [];
  const successful = harness((path, options) => {
    const request = { path, options, deferred: path.endsWith("/quote") ? quote : reconciliation };
    requests.push(request);
    return request.deferred.promise;
  });
  const draft = { targetPlan: "business", billingInterval: "monthly", action: "upgrade", baseQuote: null };
  successful.app.subscriptionCheckoutDraft = draft;
  const initialization = successful.initialize(draft);
  if (!successful.app.subscriptionQuoteLoading || !draft.initializing) fail("checkout loading state did not start immediately");
  await tick();
  if (requests.length !== 2 || requests[0].path !== "/api/billing/quote" || requests[1].path !== "/api/billing/reconcile") fail("quote and reconciliation did not start concurrently");
  quote.resolve({ quote: { amount_minor: 99000, intent: "subscription_upgrade" } });
  await tick();
  if (draft.baseQuote?.amount_minor !== 99000 || draft.reconciliationReady) fail("authoritative quote was not rendered independently while reconciliation remained pending");
  reconciliation.resolve({ state: "none" });
  await initialization;
  if (!draft.reconciliationReady || draft.initializing || successful.app.subscriptionQuoteLoading || successful.app.pricingUpgradeLoading) fail("successful initialization did not reach a settled ready state");

  const activeCalls = [];
  const activeHarness = harness(path => {
    activeCalls.push(path);
    if (path.endsWith("/quote")) return Promise.resolve({ quote: { amount_minor: 99000, intent: "subscription_upgrade" } });
    if (path.endsWith("/reconcile")) return Promise.resolve({ state: "active", pendingPayment: { id: "existing_payment", targetPlan: "business", amountMinor: 99000, currency: "THB", billingInterval: "monthly", operation: "subscription_upgrade" }, billing: { latestPayments: [{ id: "existing_payment" }] } });
    return Promise.resolve({ payment: { id: "existing_payment" }, promptpay: { paymentIntentId: "existing_intent" }, billing: { latestPayments: [{ id: "existing_payment" }] } });
  });
  const activeDraft = { targetPlan: "business", billingInterval: "monthly" };
  activeHarness.app.subscriptionCheckoutDraft = activeDraft;
  await activeHarness.initialize(activeDraft);
  if (activeHarness.app.subscriptionCheckoutDraft !== activeDraft || activeDraft.pendingPayment?.id !== "existing_payment" || !activeDraft.reconciliationReady || activeCalls.some(path => path.endsWith("/upgrade") || path.endsWith("/checkout")) || activeHarness.app.billingCheckout || activeDraft.initializing || activeHarness.app.subscriptionQuoteLoading) fail("active existing payment advanced or resumed before explicit confirmation");
  if (activeHarness.blockReason(activeDraft)) fail("compatible existing payment was incorrectly blocked from explicit continuation");
  activeDraft.pendingPayment.promotion = { code: "OLDPROMO" };
  if (!activeHarness.blockReason(activeDraft)) fail("existing payment with a different promotion was silently reusable");
  activeHarness.app.checkoutPromotionCode = "oldpromo";
  activeHarness.app.checkoutPromoQuote = { quote: { amount_minor: 99000, currency: "THB", code: "OLDPROMO" } };
  if (activeHarness.blockReason(activeDraft)) fail("matching authoritative promotion quote was incorrectly blocked");
  activeHarness.app.checkoutPromotionCode = "not-applied";
  activeHarness.app.checkoutPromoQuote = null;
  if (!activeHarness.blockReason(activeDraft)) fail("typed but unapplied promotion was not blocked from confirmation");
  activeHarness.app.checkoutPromotionCode = "";
  activeDraft.pendingPayment.promotion = undefined;
  activeDraft.pendingPayment.amountMinor = 100000;
  if (!activeHarness.blockReason(activeDraft)) fail("existing payment with a different amount was silently reusable");

  const confirmBlock = appSource.match(/const subscriptionConfirmButton = event\.target\.closest\("\[data-subscription-checkout-confirm\]"\);([\s\S]*?)\n  const subscriptionInitializationRetryButton =/)?.[1];
  if (!confirmBlock) fail("explicit confirmation handler could not be isolated for interaction testing");
  const confirmHarness = harness(() => Promise.resolve());
  const confirmDraft = { targetPlan: "business", billingInterval: "monthly", action: "upgrade", baseQuote: { amount_minor: 99000 }, reconciliationReady: true, initializing: false };
  confirmHarness.app.view = "settingsSubscription";
  confirmHarness.app.pricingUpgradeLoading = "";
  confirmHarness.app.subscriptionCheckoutDraft = confirmDraft;
  let resolvePayment;
  let confirmationCalls = 0;
  confirmHarness.beginSubscriptionCheckoutForUi = () => {
    confirmationCalls += 1;
    return new Promise(resolve => { resolvePayment = resolve; });
  };
  confirmHarness.render = () => {};
  confirmHarness.showToast = () => {};
  vm.runInContext(`this.clickConfirm = async event => { const subscriptionConfirmButton = event.target.closest("[data-subscription-checkout-confirm]"); ${confirmBlock}\n};`, confirmHarness);
  const confirmEvent = { target: { closest: selector => selector === "[data-subscription-checkout-confirm]" ? {} : null } };
  const firstConfirm = confirmHarness.clickConfirm(confirmEvent);
  await tick();
  const rapidSecondConfirm = confirmHarness.clickConfirm(confirmEvent);
  if (confirmationCalls !== 1 || confirmHarness.app.billingCheckout) fail("payment was not single-shot or advanced before its authoritative response");
  resolvePayment({ payment: { id: "confirmed_payment" }, promptpay: { paymentIntentId: "confirmed_intent" } });
  await Promise.all([firstConfirm, rapidSecondConfirm]);
  if (confirmHarness.app.billingCheckout?.payment?.id !== "confirmed_payment" || confirmHarness.app.subscriptionCheckoutDraft || confirmationCalls !== 1) fail("explicit confirmation did not advance exactly once after authoritative payment response");

  const unvalidatedHarness = harness(() => Promise.resolve());
  const unvalidatedDraft = { targetPlan: "business", billingInterval: "monthly", action: "upgrade", baseQuote: { amount_minor: 99000 }, reconciliationReady: true, initializing: false };
  unvalidatedHarness.app.view = "settingsSubscription";
  unvalidatedHarness.app.pricingUpgradeLoading = "";
  unvalidatedHarness.app.subscriptionCheckoutDraft = unvalidatedDraft;
  unvalidatedHarness.app.checkoutPromotionCode = "TYPED-BUT-NOT-APPLIED";
  let unvalidatedCalls = 0;
  unvalidatedHarness.beginSubscriptionCheckoutForUi = () => { unvalidatedCalls += 1; return Promise.resolve({}); };
  unvalidatedHarness.render = () => {};
  unvalidatedHarness.showToast = () => {};
  vm.runInContext(`this.clickConfirm = async event => { const subscriptionConfirmButton = event.target.closest("[data-subscription-checkout-confirm]"); ${confirmBlock}\n};`, unvalidatedHarness);
  await unvalidatedHarness.clickConfirm(confirmEvent);
  if (unvalidatedCalls || unvalidatedHarness.app.subscriptionCheckoutDraft !== unvalidatedDraft) fail("unapplied promo was ignored or confirmation advanced checkout");

  const webhookCalls = [];
  const webhookHarness = harness(path => {
    webhookCalls.push(path);
    if (path.endsWith("/quote")) return Promise.resolve({ quote: { amount_minor: 99000, intent: "subscription_upgrade" } });
    return Promise.resolve({ state: "awaiting_webhook", pendingPayment: { id: "webhook_payment", plan: "business", operation: "subscription_upgrade", amountMinor: 99000 }, billing: { latestPayments: [{ id: "webhook_payment" }] } });
  });
  const webhookDraft = { targetPlan: "business", billingInterval: "monthly" };
  webhookHarness.app.subscriptionCheckoutDraft = webhookDraft;
  await webhookHarness.initialize(webhookDraft);
  if (webhookHarness.app.subscriptionCheckoutDraft !== webhookDraft || !webhookDraft.awaitingWebhook || webhookDraft.reconciliationReady || webhookHarness.app.billingCheckout || webhookCalls.some(path => path.endsWith("/upgrade") || path.endsWith("/checkout")) || webhookDraft.initializing) fail("awaiting-webhook payment advanced or created/resumed a payment before explicit confirmation");

  const quoteFailure = deferred();
  const reconAfterQuoteFailure = deferred();
  const quoteFailHarness = harness(path => path.endsWith("/quote") ? quoteFailure.promise : reconAfterQuoteFailure.promise);
  const quoteFailDraft = { targetPlan: "business", billingInterval: "monthly" };
  quoteFailHarness.app.subscriptionCheckoutDraft = quoteFailDraft;
  const quoteFailTask = quoteFailHarness.initialize(quoteFailDraft);
  await tick();
  quoteFailure.reject(new Error("quote unavailable"));
  reconAfterQuoteFailure.resolve({ state: "none" });
  await quoteFailTask;
  if (quoteFailDraft.initializing || quoteFailHarness.app.subscriptionQuoteLoading || !quoteFailDraft.initializationError || quoteFailDraft.baseQuote) fail("quote rejection left checkout loading or an unsafe quote");

  const reconFailureHarness = harness(path => path.endsWith("/quote")
    ? Promise.resolve({ quote: { amount_minor: 99000, intent: "subscription_upgrade" } })
    : Promise.reject(new Error("reconciliation unavailable")));
  const reconFailDraft = { targetPlan: "business", billingInterval: "monthly" };
  reconFailureHarness.app.subscriptionCheckoutDraft = reconFailDraft;
  await reconFailureHarness.initialize(reconFailDraft);
  if (reconFailDraft.initializing || reconFailDraft.reconciliationReady || !reconFailDraft.initializationError || reconFailureHarness.app.subscriptionQuoteLoading) fail("reconciliation rejection left checkout pending or enabled");

  const timeoutHarness = harness(() => new Promise(() => {}));
  const timeoutDraft = { targetPlan: "business", billingInterval: "monthly" };
  timeoutHarness.app.subscriptionCheckoutDraft = timeoutDraft;
  await timeoutHarness.initialize(timeoutDraft);
  if (timeoutDraft.initializing || timeoutHarness.app.subscriptionQuoteLoading || !timeoutDraft.initializationError) fail("timed-out initialization remained permanently pending");

  const oldQuote = deferred();
  const oldReconciliation = deferred();
  let call = 0;
  const staleHarness = harness(path => {
    if (call++ < 2) return path.endsWith("/quote") ? oldQuote.promise : oldReconciliation.promise;
    return Promise.resolve(path.endsWith("/quote")
      ? { quote: { amount_minor: 199000, intent: "subscription_upgrade" } }
      : { state: "none", billing: { marker: "new" } });
  });
  const oldDraft = { targetPlan: "business", billingInterval: "monthly" };
  staleHarness.app.subscriptionCheckoutDraft = oldDraft;
  const oldTask = staleHarness.initialize(oldDraft);
  await tick();
  const newDraft = { targetPlan: "enterprise", billingInterval: "yearly" };
  staleHarness.app.subscriptionCheckoutDraft = newDraft;
  await staleHarness.initialize(newDraft);
  oldQuote.resolve({ quote: { amount_minor: 1 } });
  oldReconciliation.resolve({ state: "none", billing: { marker: "stale" } });
  await oldTask;
  if (newDraft.baseQuote?.amount_minor !== 199000 || staleHarness.app.data.billing?.marker !== "new") fail("stale initialization overwrote the current checkout");

  let retryNumber = 0;
  const retryHarness = harness(() => {
    retryNumber += 1;
    if (retryNumber <= 2) return Promise.reject(new Error("transient"));
    return Promise.resolve(retryNumber === 3
      ? { quote: { amount_minor: 99000, intent: "subscription_upgrade" } }
      : { state: "terminal" });
  });
  const retryDraft = { targetPlan: "business", billingInterval: "monthly" };
  retryHarness.app.subscriptionCheckoutDraft = retryDraft;
  await retryHarness.initialize(retryDraft);
  if (!retryDraft.initializationError) fail("transient failure did not expose a retry state");
  await retryHarness.initialize(retryDraft);
  if (retryDraft.initializationError || !retryDraft.reconciliationReady || retryDraft.baseQuote?.amount_minor !== 99000) fail("safe initialization retry did not recover to READY");
}

(async () => {
  for (const token of [
    "create table if not exists public.subscription_upgrade_attempts",
    "growup_begin_subscription_upgrade",
    "growup_record_subscription_upgrade_success",
    "growup_record_subscription_upgrade_status",
    "UPGRADE_IN_PROGRESS",
    "amount_minor",
    "target_plan"
  ]) if (!migration.includes(token)) fail(`upgrade migration missing ${token}`);
  if (!appSource.includes("data-pricing-upgrade=") || !appSource.includes('event.target.closest("[data-pricing-action]")') || !appSource.includes("beginSubscriptionCheckoutForUi")) fail("pricing upgrade action binding missing");
  if (!appSource.includes('disabled aria-disabled=\\"true\\"')) fail("current pricing button is not disabled");
  if (appSource.includes('subscription.plan === targetPlan && targetPlan && targetPlan !== currentPlan ? "succeeded"')) fail("checkout inferred success from the subscription target plan");
  if (!appSource.includes("function subscriptionPaymentDisplayStatus(promptpay = {}, payment = {})")) fail("checkout payment status helper is missing");
  if (!appSource.includes('latestPayment.verifiedSuccess === true')) fail("subscription success UI is not gated by verified payment reconciliation");
  if (!appSource.includes('"/api/billing/upgrade/qr"') || !appSource.includes("data-subscription-qr-image")) fail("subscription QR delivery fallback is missing");
  if (!appSource.includes("data-subscription-qr-source") || !appSource.includes("qrFallbackAttempted")) fail("subscription QR image retry fallback is missing");
  if (!appSource.includes('"/api/billing/reconcile"')) fail("pricing must reconcile a stale checkout before opening a new draft");
  const checkoutInitialization = appSource.match(/async function initializeSubscriptionCheckout\(draft\) \{[\s\S]*?\n\}/)?.[0];
  const checkoutHydration = appSource.match(/async function hydrateSubscriptionCheckout\(\) \{[\s\S]*?\n\}/)?.[0];
  if (!checkoutInitialization || /beginSubscriptionCheckoutForUi|\/api\/billing\/(?:upgrade|checkout)/.test(checkoutInitialization)) fail("checkout initialization must not create or resume payment");
  if (!checkoutHydration || /\/api\/billing\/(?:upgrade|checkout)/.test(checkoutHydration)) fail("route hydration must not auto-advance to PromptPay");
  if (!appSource.includes('event.target.closest("[data-subscription-checkout-confirm]")') || !appSource.includes("subscriptionCheckoutBlockReason(draft)")) fail("only an explicitly confirmed, compatible checkout may create/resume payment");
  const pricingHandler = appSource.match(/const pricingCheckoutButton = event\.target\.closest\("\[data-pricing-action\]"\);[\s\S]*?\/\* pricing-scope: authenticated-upgrade-handler:end \*\//)?.[0];
  if (!pricingHandler) fail("pricing checkout handler could not be loaded");
  if (!/setView\("settingsSubscription"\);[\s\S]*?void initializeSubscriptionCheckout\(draft\)/.test(pricingHandler)) fail("checkout page must appear immediately before asynchronous initialization");
  if (!/requestSubscriptionInitialization\("\/api\/billing\/quote"/.test(appSource) || !/requestSubscriptionInitialization\("\/api\/billing\/reconcile"/.test(appSource)) fail("quote and reconciliation must both use bounded requests");
  if (!/\["active", "awaiting_webhook"\]\.includes\(reconciliation\.state\)/.test(appSource)) fail("checkout must remain gated by active and awaiting-webhook payments");
  if (!/draft\.initializing \|\| checkoutBlockReason/.test(appSource) || !appSource.includes("if (!draft.baseQuote || !draft.reconciliationReady || draft.initializing || app.subscriptionQuoteLoading || subscriptionCheckoutBlockReason(draft)) return;")) fail("confirm must require settled authoritative quote, reconciliation, and a compatible payment state");
  if (!appSource.includes("data-subscription-initialization-retry") || !appSource.includes("draft.initializationAttempt === attempt")) fail("initialization retry or stale-attempt protection is missing");
  await verifyCheckoutInitializationStateMachine();
  const statusFunction = appSource.match(/function subscriptionPaymentDisplayStatus\(promptpay = \{\}, payment = \{\}\) \{[\s\S]*?\n\}/)?.[0];
  if (!statusFunction) fail("checkout payment status helper could not be loaded");
  const statusSandbox = {};
  vm.runInNewContext(`this.subscriptionPaymentDisplayStatus = ${statusFunction}`, statusSandbox);
  const pendingUiStatus = statusSandbox.subscriptionPaymentDisplayStatus(
    { status: "requires_action" },
    { operation: "subscription_upgrade", status: "paid", providerStatus: "requires_action", verifiedSuccess: false, targetPlan: "business" }
  );
  if (pendingUiStatus !== "requires_action") fail(`requires_action rendered as ${pendingUiStatus}`);
  const targetMatchPendingStatus = statusSandbox.subscriptionPaymentDisplayStatus(
    {},
    { operation: "subscription_upgrade", status: "paid", providerStatus: "succeeded", verifiedSuccess: false, targetPlan: "business", currentPlan: "business" }
  );
  if (targetMatchPendingStatus !== "pending") fail(`unverified target-plan match rendered as ${targetMatchPendingStatus}`);
  const verifiedUiStatus = statusSandbox.subscriptionPaymentDisplayStatus(
    {},
    { operation: "subscription_upgrade", status: "paid", providerStatus: "succeeded", verifiedSuccess: true, targetPlan: "business" }
  );
  if (verifiedUiStatus !== "succeeded") fail(`verified success rendered as ${verifiedUiStatus}`);

  const anonymous = await request("/api/billing/upgrade", { method: "POST", body: JSON.stringify({ targetPlan: "business" }) });
  if (anonymous.status !== 401) fail(`anonymous upgrade should be rejected: ${anonymous.status}`);
  const starterCookie = await login("starter@example.com");
  const staffCookie = await login("staff@example.com");
  const anonymousReconcile = await request("/api/billing/reconcile", { method: "POST", body: "{}" });
  if (anonymousReconcile.status !== 401) fail(`anonymous reconciliation should be rejected: ${anonymousReconcile.status}`);
  const staffReconcile = await request("/api/billing/reconcile", { method: "POST", headers: { cookie: staffCookie }, body: "{}" });
  if (staffReconcile.status !== 403) fail(`staff reconciliation should be rejected: ${staffReconcile.status}`);
  const staff = await request("/api/billing/upgrade", { method: "POST", headers: { cookie: staffCookie }, body: JSON.stringify({ targetPlan: "business" }) });
  if (staff.status !== 403) fail(`staff upgrade should be rejected: ${staff.status}`);
  const first = await request("/api/billing/upgrade", { method: "POST", headers: { cookie: starterCookie }, body: JSON.stringify({ targetPlan: "business", tenantId: ids.business, amountMinor: 1 }) });
  if (first.status !== 200 || first.json().payment.amountMinor !== 99000 || first.json().payment.targetPlan !== "business") fail(`Starter -> Business wrong: ${first.status} ${first.text}`);
  const activeReconciliation = await request("/api/billing/reconcile", { method: "POST", headers: { cookie: starterCookie }, body: "{}" });
  if (activeReconciliation.status !== 200 || activeReconciliation.json().state !== "active") fail("active pending checkout was not protected during reconciliation");
  if (db.payments.find(row => row.id === first.json().payment.id).status !== "pending") fail("active pending checkout was modified by reconciliation");
  const resumed = await request("/api/billing/upgrade", { method: "POST", headers: { cookie: starterCookie }, body: JSON.stringify({ targetPlan: "business" }) });
  if (resumed.status !== 200 || resumed.json().payment.id !== first.json().payment.id || resumed.json().promptpay.promptpay.imageUrlPng !== first.json().promptpay.promptpay.imageUrlPng) fail("same target did not resume the same payment and QR");
  if (db.payments.filter(row => row.tenant_id === ids.starter).length !== 1) fail("same-target resume created a duplicate payment");
  const qrProxy = await request("/api/billing/upgrade/qr", { method: "GET", headers: { cookie: starterCookie } });
  if (qrProxy.status !== 200 || !String(header(qrProxy.headers, "content-type")).startsWith("image/png")) fail("same-payment QR proxy failed: " + qrProxy.status + " " + header(qrProxy.headers, "content-type") + " " + qrProxy.text.slice(0, 120));

  // Legacy Preview shape: the payment already has the authoritative Stripe
  // reference, while the upgrade attempt record predates that field. The
  // resume path must use the existing payment/PaymentIntent and never call
  // Stripe create again.
  const legacyPayment = {
    id: "p_legacy_pending",
    tenant_id: ids.legacy,
    subscription_id: "s_legacy",
    idempotency_key: "legacy-upgrade-key",
    provider: "stripe_promptpay",
    provider_payment_reference: "pi_legacy_pending",
    status: "requires_action",
    currency: "THB",
    amount_minor: 99000,
    plan: "business",
    billing_interval: "monthly",
    billing_period_started_at: nowIso,
    billing_period_ends_at: "2026-09-22T00:00:00.000Z",
    created_at: nowIso
  };
  const legacyAttempt = {
    id: "u_legacy_pending",
    tenant_id: ids.legacy,
    subscription_id: "s_legacy",
    payment_id: legacyPayment.id,
    idempotency_key: "legacy-upgrade-key",
    current_plan: "starter",
    target_plan: "business",
    provider: "stripe_promptpay",
    provider_payment_reference: null,
    status: "pending",
    currency: "THB",
    amount_minor: 99000,
    billing_interval: "monthly",
    created_at: nowIso
  };
  db.payments.push(legacyPayment);
  db.subscription_upgrade_attempts.push(legacyAttempt);
  stripeIntents.set("pi_legacy_pending", {
    id: "pi_legacy_pending",
    status: "requires_action",
    amount: 99000,
    currency: "thb",
    client_secret: "pi_legacy_pending_secret_test",
    next_action: { promptpay_display_qr_code: { image_url_png: "data:image/png;base64,bGVnYWN5", hosted_instructions_url: "https://pay.stripe.test/legacy" } }
  });
  const legacyCookie = await login("legacy@example.com");
  const legacyPaymentCount = db.payments.filter(row => row.tenant_id === ids.legacy).length;
  const legacyCreateCount = stripeCreateRequests.length;
  const legacySuccessRpcCount = subscriptionUpgradeSuccessRpcCalls;
  const legacyFirst = await request("/api/billing/upgrade", { method: "POST", headers: { cookie: legacyCookie }, body: JSON.stringify({ targetPlan: "business" }) });
  const legacySecond = await request("/api/billing/upgrade", { method: "POST", headers: { cookie: legacyCookie }, body: JSON.stringify({ targetPlan: "business" }) });
  if (legacyFirst.status !== 200 || legacySecond.status !== 200) fail(`legacy pending resume failed: ${legacyFirst.status}/${legacySecond.status} ${legacyFirst.text} ${legacySecond.text}`);
  if (!legacyFirst.json().resumed || legacyFirst.json().payment.id !== legacyPayment.id || legacyFirst.json().promptpay.paymentIntentId !== "pi_legacy_pending") fail("legacy pending resume did not return the authoritative payment intent");
  if (legacyFirst.json().upgrade?.id !== legacyAttempt.id || legacyFirst.json().payment.amountMinor !== 99000) fail("legacy pending resume did not preserve the existing upgrade attempt or amount");
  if (subscriptionUpgradeSuccessRpcCalls !== legacySuccessRpcCount) fail("pending resume invoked subscription upgrade success RPC");
  stripeIntents.get("pi_legacy_pending").status = "succeeded";
  const legacySucceededResume = await request("/api/billing/upgrade", { method: "POST", headers: { cookie: legacyCookie }, body: JSON.stringify({ targetPlan: "business" }) });
  if (legacySucceededResume.status !== 200 || !legacySucceededResume.json().awaitingWebhook) fail("succeeded PaymentIntent resume did not wait for the verified webhook");
  const succeededReconciliation = await request("/api/billing/reconcile", { method: "POST", headers: { cookie: legacyCookie }, body: "{}" });
  if (succeededReconciliation.status !== 200 || succeededReconciliation.json().state !== "awaiting_webhook") fail("succeeded PaymentIntent was not preserved for webhook reconciliation");
  if (legacyPayment.status !== "requires_action" || legacyAttempt.status !== "pending") fail("succeeded PaymentIntent was cleared or replaced before webhook reconciliation");
  if (subscriptionUpgradeSuccessRpcCalls !== legacySuccessRpcCount || db.subscriptions.find(row => row.id === "s_legacy").plan !== "starter") fail("checkout resume activated the subscription without a verified webhook");
  if (legacySecond.json().payment.id !== legacyFirst.json().payment.id || legacySecond.json().promptpay.paymentIntentId !== legacyFirst.json().promptpay.paymentIntentId) fail("legacy second resume changed the payment intent");
  if (db.payments.filter(row => row.tenant_id === ids.legacy).length !== legacyPaymentCount || stripeCreateRequests.length !== legacyCreateCount) fail("legacy pending resume created a duplicate payment or PaymentIntent");

  const duplicate = await request("/api/billing/upgrade", { method: "POST", headers: { cookie: starterCookie }, body: JSON.stringify({ targetPlan: "enterprise" }) });
  if (duplicate.status !== 409 || duplicate.json().code !== "UPGRADE_IN_PROGRESS" || !duplicate.json().pendingPayment) fail(`conflicting duplicate upgrade not blocked cleanly: ${duplicate.status} ${duplicate.text}`);
  const payment = db.payments.find(row => row.id === first.json().payment.id);
  const invalid = await request("/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": "t=1,v1=bad" }, body: webhookPayload("payment_intent.succeeded", payment) });
  if (invalid.status !== 400 || db.subscriptions.find(row => row.id === "s_starter").plan !== "starter") fail("invalid webhook changed the Starter plan");
  const successPayload = webhookPayload("payment_intent.succeeded", payment);
  const successEffectBeforeWebhook = subscriptionUpgradeSuccessEffects;
  const success = await postWebhook(successPayload);
  const duplicateSuccess = await postWebhook(successPayload);
  if (success.status !== 200 || duplicateSuccess.status !== 200 || db.subscriptions.find(row => row.id === "s_starter").plan !== "business") fail("successful or duplicate webhook did not reconcile exactly once");
  if (subscriptionUpgradeSuccessEffects !== successEffectBeforeWebhook + 1) fail("verified succeeded webhook did not reconcile exactly once");
  const businessCookie = await login("business@example.com");
  const enterprise = await request("/api/billing/upgrade", { method: "POST", headers: { cookie: businessCookie }, body: JSON.stringify({ targetPlan: "enterprise" }) });
  if (enterprise.status !== 200 || enterprise.json().payment.amountMinor !== 199000) fail(`Business -> Enterprise wrong: ${enterprise.status} ${enterprise.text}`);
  const businessSubscriptionBefore = db.subscriptions.find(row => row.id === "s_business").plan;
  const processingPayment = db.payments.find(row => row.id === enterprise.json().payment.id);
  const processing = await postWebhook(webhookPayload("payment_intent.processing", processingPayment, "processing"));
  if (processing.status !== 200 || db.subscriptions.find(row => row.id === "s_business").plan !== businessSubscriptionBefore) fail("processing payment activated Enterprise");
  stripeIntents.get(processingPayment.provider_payment_reference).status = "canceled";
  const cancelledReconciliation = await request("/api/billing/reconcile", { method: "POST", headers: { cookie: businessCookie }, body: "{}" });
  const cancelledAttempt = db.subscription_upgrade_attempts.find(row => row.payment_id === processingPayment.id);
  if (cancelledReconciliation.status !== 200 || cancelledReconciliation.json().state !== "terminal" || cancelledReconciliation.json().status !== "cancelled" || processingPayment.status !== "cancelled" || cancelledAttempt.status !== "cancelled" || db.subscriptions.find(row => row.id === "s_business").plan !== businessSubscriptionBefore) fail("cancelled terminal checkout was not reconciled safely");
  const failureCookie = await login("failure@example.com");
  const failedUpgrade = await request("/api/billing/upgrade", { method: "POST", headers: { cookie: failureCookie }, body: JSON.stringify({ targetPlan: "enterprise" }) });
  const failedPayment = db.payments.find(row => row.id === failedUpgrade.json().payment.id);
  // PromptPay expiry becomes Stripe requires_payment_method with the
  // payment_intent_payment_attempt_expired failure code; locally it is a
  // terminal failed checkout, never a resumable pending checkout.
  Object.assign(stripeIntents.get(failedPayment.provider_payment_reference), {
    status: "requires_action",
    last_payment_error: { code: "payment_intent_payment_attempt_expired" },
    next_action: { promptpay_display_qr_code: { expires_at: Math.floor(Date.now() / 1000) - 60 } }
  });
  const statusEventCountBeforeReconcile = db.payment_provider_events.length;
  const terminalReconciliation = await request("/api/billing/reconcile", { method: "POST", headers: { cookie: failureCookie }, body: "{}" });
  if (terminalReconciliation.status !== 200 || terminalReconciliation.json().state !== "terminal" || terminalReconciliation.json().status !== "expired") fail(`expired checkout was not reconciled: ${terminalReconciliation.status} ${terminalReconciliation.text}`);
  const failedAttempt = db.subscription_upgrade_attempts.find(row => row.payment_id === failedPayment.id);
  if (failedPayment.status !== "expired" || failedAttempt.status !== "expired" || db.subscriptions.find(row => row.id === "s_failure").plan !== "starter") fail("terminal checkout reconciliation changed subscription or did not close local evidence");
  if (failedPayment.checkout_metadata?.promotion || db.payment_provider_events.length !== statusEventCountBeforeReconcile + 1) fail("terminal non-promo checkout reconciliation created an unrelated promo effect or missing history");
  const repeatedTerminalReconciliation = await request("/api/billing/reconcile", { method: "POST", headers: { cookie: failureCookie }, body: "{}" });
  if (repeatedTerminalReconciliation.status !== 200 || repeatedTerminalReconciliation.json().state !== "none" || db.payment_provider_events.length !== statusEventCountBeforeReconcile + 1) fail("terminal checkout reconciliation is not idempotent");
  // A terminal checkout may be retried only after reconciliation closes the
  // old local attempt. This test's new mock PaymentIntent is separate.
  const failurePaymentCountBeforeRetry = db.payments.filter(row => row.tenant_id === ids.failure).length;
  const failureCreateCountBeforeRetry = stripeCreateRequests.length;
  const retryUpgrade = await request("/api/billing/upgrade", { method: "POST", headers: { cookie: failureCookie }, body: JSON.stringify({ targetPlan: "enterprise" }) });
  if (retryUpgrade.status !== 200 || retryUpgrade.json().payment.id === failedPayment.id || db.subscriptions.find(row => row.id === "s_failure").plan !== "starter") fail("terminal failed upgrade did not create a fresh pending retry");
  if (failedPayment.status !== "expired" || failedAttempt.status !== "expired") fail("terminal retry changed the expired payment or did not preserve the stale evidence");
  if (db.payments.filter(row => row.tenant_id === ids.failure).length !== failurePaymentCountBeforeRetry + 1 || stripeCreateRequests.length !== failureCreateCountBeforeRetry + 1) fail("terminal retry did not create exactly one new PaymentIntent");
  const retryPayment = db.payments.find(row => row.id === retryUpgrade.json().payment.id);
  const failed = await postWebhook(webhookPayload("payment_intent.payment_failed", retryPayment, "requires_payment_method"));
  if (failed.status !== 200 || db.subscriptions.find(row => row.id === "s_failure").plan !== "starter") fail("failed payment activated Enterprise");
  const downgrade = await request("/api/billing/upgrade", { method: "POST", headers: { cookie: businessCookie }, body: JSON.stringify({ targetPlan: "starter" }) });
  if (downgrade.status !== 409 || downgrade.json().code !== "UPGRADE_NOT_ALLOWED") fail("downgrade was not rejected");
  console.log("Subscription upgrade checks passed.");
})().catch(error => { console.error(error); process.exit(1); });
