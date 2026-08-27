"use strict";

process.env.NODE_ENV = "test";
process.env.DATABASE_PROVIDER = "supabase";
process.env.SUPABASE_URL = "https://subscription-core-test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.SESSION_SECRET = "subscription-core-test-session-secret";
process.env.AUTH_RATE_LIMIT_MAX = "500";

const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const crypto = require("crypto");
const appHandler = require("../server");

const ROOT = path.join(__dirname, "..");
const migration = fs.readFileSync(path.join(ROOT, "supabase", "migrations", "20260814000000_subscription_core.sql"), "utf8");

const PRICE_MINOR = {
  "starter:monthly": 49000,
  "starter:yearly": 490000,
  "business:monthly": 99000,
  "business:yearly": 990000,
  "enterprise:monthly": 199000,
  "enterprise:yearly": 1990000
};

const db = {
  users: [
    { id: "u_existing", username: "existing@example.com", password_hash: "hash", name: "Existing", role: "Owner", phone: "", is_active: true }
  ],
  tenants: [],
  tenant_memberships: [],
  tenant_role_permissions: [],
  settings: [],
  follow_up_rules: [],
  customers: [],
  orders: [],
  line_messages: [],
  tags: [],
  customer_tags: [],
  contact_logs: [],
  notification_reads: [],
  tenant_settings: [],
  signup_bootstraps: [],
  subscriptions: [],
  promotion_codes: [
    { id: "promo_percent", code: "SAVE20", active: true, benefit_type: "percent_discount", benefit_value: 20, applicable_plans: ["business"], applicable_billing: ["monthly"], starts_at: null, ends_at: null, max_redemptions: null, max_redemptions_per_tenant: null },
    { id: "promo_fixed", code: "FIXED300", active: true, benefit_type: "fixed_amount_discount", benefit_value: 300, applicable_plans: ["business"], applicable_billing: ["yearly"], starts_at: null, ends_at: null, max_redemptions: null, max_redemptions_per_tenant: null },
    { id: "promo_trial", code: "TRIAL15", active: true, benefit_type: "extra_trial_days", benefit_value: 15, applicable_plans: ["starter"], applicable_billing: ["monthly", "yearly"], starts_at: null, ends_at: null, max_redemptions: null, max_redemptions_per_tenant: null },
    { id: "promo_month", code: "MONTH1", active: true, benefit_type: "free_months", benefit_value: 1, applicable_plans: ["enterprise"], applicable_billing: ["yearly"], starts_at: null, ends_at: null, max_redemptions: null, max_redemptions_per_tenant: null },
    { id: "promo_expired", code: "EXPIRED", active: true, benefit_type: "percent_discount", benefit_value: 10, applicable_plans: ["starter"], applicable_billing: ["monthly"], starts_at: "2025-01-01T00:00:00.000Z", ends_at: "2025-02-01T00:00:00.000Z", max_redemptions: null, max_redemptions_per_tenant: null },
    { id: "promo_inapplicable", code: "BUSINESSONLY", active: true, benefit_type: "percent_discount", benefit_value: 10, applicable_plans: ["business"], applicable_billing: ["monthly"], starts_at: null, ends_at: null, max_redemptions: null, max_redemptions_per_tenant: null },
    { id: "promo_once", code: "ONCE", active: true, benefit_type: "percent_discount", benefit_value: 10, applicable_plans: ["business"], applicable_billing: ["monthly"], starts_at: null, ends_at: null, max_redemptions: 1, max_redemptions_per_tenant: null }
  ],
  promotion_redemptions: []
};

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function restore(snapshot) {
  for (const key of Object.keys(db)) db[key] = clone(snapshot[key]);
}

function normalizePromotionCode(value = "") {
  return String(value || "").trim().toUpperCase();
}

function promotionBenefitDescription(promo) {
  const value = Number(promo?.benefit_value || 0);
  if (promo?.benefit_type === "percent_discount") return `ลด ${value}%`;
  if (promo?.benefit_type === "fixed_amount_discount") return `ลด ฿${value}`;
  if (promo?.benefit_type === "extra_trial_days") return `เพิ่มระยะทดลองใช้ฟรี ${value} วัน`;
  if (promo?.benefit_type === "free_months") return `ใช้ฟรีเพิ่ม ${value} เดือน`;
  return "";
}

function validatePromotionRule(payload = {}) {
  const code = normalizePromotionCode(payload.p_code || payload.p_promotion_code || "");
  const selectedPlan = String(payload.p_selected_plan || "").trim().toLowerCase();
  const selectedBilling = String(payload.p_selected_billing || "").trim().toLowerCase();
  const invalid = reason => [{ valid: false, code, selected_plan: selectedPlan, selected_billing: selectedBilling, reason }];
  if (!code || !["starter", "business", "enterprise"].includes(selectedPlan) || !["monthly", "yearly"].includes(selectedBilling)) return invalid("PROMOTION_CODE_INVALID");
  const promo = db.promotion_codes.find(row => normalizePromotionCode(row.code) === code);
  if (!promo || !promo.active) return invalid("PROMOTION_CODE_INVALID");
  const now = new Date("2026-08-14T00:00:00.000Z").getTime();
  if ((promo.starts_at && new Date(promo.starts_at).getTime() > now) || (promo.ends_at && new Date(promo.ends_at).getTime() < now)) return invalid("PROMOTION_CODE_EXPIRED");
  if (!promo.applicable_plans.includes(selectedPlan) || !promo.applicable_billing.includes(selectedBilling)) return invalid("PROMOTION_CODE_INVALID");
  const totalRedemptions = db.promotion_redemptions.filter(row => row.promotion_code_id === promo.id).length;
  if (promo.max_redemptions && totalRedemptions >= promo.max_redemptions) return invalid("PROMOTION_CODE_EXHAUSTED");
  return [{
    valid: true,
    code,
    selected_plan: selectedPlan,
    selected_billing: selectedBilling,
    benefit_type: promo.benefit_type,
    benefit_value: promo.benefit_value,
    benefit_description: promotionBenefitDescription(promo),
    reason: null
  }];
}

function signupResult(userId, tenantId) {
  const user = db.users.find(row => row.id === userId);
  const tenant = db.tenants.find(row => row.id === tenantId);
  const membership = db.tenant_memberships.find(row => row.user_id === userId && row.tenant_id === tenantId && row.is_active);
  return [{
    user_id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    phone: user.phone,
    is_active: user.is_active,
    tenant_id: tenant.id,
    tenant_name: tenant.name,
    tenant_role: membership.role
  }];
}

function rpcError(message) {
  return new Response(JSON.stringify({ message }), { status: 400 });
}

function signupBootstrap(payload = {}) {
  const before = clone(db);
  try {
    const key = String(payload.p_idempotency_key || "").trim();
    const username = String(payload.p_username || "").trim().toLowerCase();
    const selectedPlan = String(payload.p_selected_plan || "starter").trim().toLowerCase();
    const selectedBilling = String(payload.p_selected_billing || "monthly").trim().toLowerCase();
    const existingBootstrap = db.signup_bootstraps.find(row => row.idempotency_key === key);
    if (existingBootstrap) {
      if (existingBootstrap.username !== username) return rpcError("IDEMPOTENCY_CONFLICT");
      return new Response(JSON.stringify(signupResult(existingBootstrap.user_id, existingBootstrap.tenant_id)), { status: 200 });
    }
    if (!PRICE_MINOR[`${selectedPlan}:${selectedBilling}`]) return rpcError("INVALID_SIGNUP_INPUT");
    if (db.users.some(row => row.username.toLowerCase() === username)) return rpcError("ACCOUNT_EXISTS");
    if (!key || !username || !payload.p_password_hash || !payload.p_business_name) return rpcError("INVALID_SIGNUP_INPUT");
    const promoResult = payload.p_promotion_code ? validatePromotionRule(payload)[0] : null;
    if (promoResult && !promoResult.valid) return rpcError(promoResult.reason);

    const tenantId = crypto.randomUUID();
    const userId = String(payload.p_user_id || `u_${crypto.randomUUID()}`);
    db.users.push({ id: userId, username, password_hash: payload.p_password_hash, name: String(payload.p_name || payload.p_business_name), role: "Owner", phone: "", is_active: true });
    db.tenants.push({ id: tenantId, name: String(payload.p_business_name), status: "active", metadata: { source: "public_signup", selected_plan: selectedPlan, selected_billing: selectedBilling } });
    db.tenant_memberships.push({ id: crypto.randomUUID(), tenant_id: tenantId, user_id: userId, role: "Owner", is_active: true });
    for (const role of ["Owner", "Admin", "Staff"]) db.tenant_role_permissions.push({ tenant_id: tenantId, role, permissions: {} });
    for (const [settingKey, value] of Object.entries((payload.p_defaults || {}).settings || {})) {
      db.settings.push({ id: `${tenantId}:${settingKey}`, key: settingKey, value, tenant_id: tenantId });
    }
    for (const rule of (payload.p_defaults || {}).followUpRules || []) {
      db.follow_up_rules.push({ id: `${tenantId}:${rule.jars}`, jars: rule.jars, days: rule.days, tenant_id: tenantId });
    }

    let promo = null;
    let redemption = null;
    if (promoResult?.valid) {
      promo = db.promotion_codes.find(row => normalizePromotionCode(row.code) === promoResult.code);
      redemption = {
        id: crypto.randomUUID(),
        promotion_code_id: promo.id,
        tenant_id: tenantId,
        selected_plan: selectedPlan,
        selected_billing: selectedBilling,
        benefit_type: promo.benefit_type,
        benefit_value: promo.benefit_value,
        benefit_description: promoResult.benefit_description,
        redeemed_at: new Date().toISOString()
      };
      db.promotion_redemptions.push(redemption);
    }

    if (String(payload.p_business_name) === "Force Subscription Failure") throw new Error("FORCED_SUBSCRIPTION_FAILURE");

    const base = PRICE_MINOR[`${selectedPlan}:${selectedBilling}`];
    let discount = 0;
    let extraTrialDays = 0;
    let freeMonths = 0;
    if (promo?.benefit_type === "percent_discount") discount = Math.min(base, Math.round((base * Number(promo.benefit_value)) / 100));
    if (promo?.benefit_type === "fixed_amount_discount") discount = Math.min(base, Math.round(Number(promo.benefit_value) * 100));
    if (promo?.benefit_type === "extra_trial_days") throw new Error("PROMOTION_CODE_INVALID");
    if (promo?.benefit_type === "free_months") freeMonths = Math.max(0, Math.floor(Number(promo.benefit_value)));
    const now = new Date();
    const trialEnds = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    db.subscriptions.push({
      id: crypto.randomUUID(),
      tenant_id: tenantId,
      source: "public_signup",
      is_initial: true,
      plan: selectedPlan,
      billing_interval: selectedBilling,
      status: selectedPlan === "starter" ? "trialing" : "pending_payment",
      currency: "THB",
      base_amount_minor: base,
      discount_amount_minor: discount,
      amount_due_minor: base - discount,
      promotion_code_id: promo?.id || null,
      promotion_redemption_id: redemption?.id || null,
      promotion_code: promo ? normalizePromotionCode(promo.code) : null,
      promotion_benefit_type: promo?.benefit_type || null,
      promotion_benefit_value: promo?.benefit_value || null,
      promotion_applicable_plans: promo?.applicable_plans || null,
      promotion_applicable_billing: promo?.applicable_billing || null,
      extra_trial_days: extraTrialDays,
      free_months: freeMonths,
      trial_started_at: selectedPlan === "starter" ? now.toISOString() : null,
      trial_ends_at: selectedPlan === "starter" ? trialEnds.toISOString() : null,
      current_period_started_at: selectedPlan === "starter" ? now.toISOString() : null,
      current_period_ends_at: selectedPlan === "starter" ? trialEnds.toISOString() : null,
      next_renewal_at: selectedPlan === "starter" ? trialEnds.toISOString() : null,
      payment_due_at: selectedPlan === "starter" ? trialEnds.toISOString() : now.toISOString(),
      promotion_snapshot: promo ? { base_amount_minor: base, discount_amount_minor: discount, amount_due_minor: base - discount, extra_trial_days: extraTrialDays, free_months: freeMonths } : {}
    });
    db.signup_bootstraps.push({ idempotency_key: key, username, user_id: userId, tenant_id: tenantId, status: "completed" });
    return new Response(JSON.stringify(signupResult(userId, tenantId)), { status: 200 });
  } catch (error) {
    restore(before);
    return rpcError(error.message || "SIGNUP_FAILED");
  }
}

function parseValue(raw = "") {
  return decodeURIComponent(String(raw).replace(/^"|"$/g, ""));
}

function applyFilters(rows, params) {
  let out = [...rows];
  for (const [key, value] of params.entries()) {
    if (["select", "limit", "order", "on_conflict"].includes(key)) continue;
    if (value.startsWith("eq.")) out = out.filter(row => String(row[key]) === parseValue(value.slice(3)));
  }
  return out;
}

global.fetch = async function mockFetch(input, options = {}) {
  const url = new URL(String(input));
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.at(-2) === "rpc" && parts.at(-1) === "growup_signup_bootstrap") return signupBootstrap(JSON.parse(options.body || "{}"));
  if (parts.at(-2) === "rpc" && parts.at(-1) === "growup_validate_promotion_code") {
    return new Response(JSON.stringify(validatePromotionRule(JSON.parse(options.body || "{}"))), { status: 200 });
  }
  const table = parts.at(-1);
  if (!Object.prototype.hasOwnProperty.call(db, table)) return new Response(JSON.stringify({ message: `unknown table ${table}` }), { status: 404 });
  return new Response(JSON.stringify(applyFilters(db[table], url.searchParams)), { status: 200 });
};

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
      setHeader(key, value) { this.headers[key] = value; },
      write(chunk) { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); },
      end(chunk) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: this.statusCode, headers: this.headers, text, json: () => text ? JSON.parse(text) : {} });
      }
    };
    Promise.resolve(appHandler(req, res)).catch(reject);
  });
}

async function signup({ username, plan, billing, promotionCode, signupRequestId, businessName, extra = {} }) {
  const body = {
    username,
    password: "subscription123",
    businessName: businessName || `Biz ${username}`,
    displayName: `Owner ${username}`,
    signupRequestId,
    landingSelectedPlan: plan,
    landingSelectedBilling: billing,
    promotionCode,
    amountDueMinor: 1,
    status: "active",
    trialEndsAt: "2099-01-01T00:00:00.000Z",
    tenantId: "forged",
    ...extra
  };
  const res = await request("/api/signup", { method: "POST", body: JSON.stringify(body) });
  return res;
}

function subscriptionForTenant(tenantId) {
  return db.subscriptions.find(row => row.tenant_id === tenantId);
}

function assertSubscription(row, expected) {
  assert(row, "subscription missing");
  for (const [key, value] of Object.entries(expected)) {
    assert(row[key] === value, `subscription ${key} expected ${value}, got ${row[key]}`);
  }
  assert(row.currency === "THB", "subscription currency must be THB");
  assert(row.amount_due_minor === row.base_amount_minor - row.discount_amount_minor, "amount due must derive from base minus discount");
}

(async () => {
  for (const token of [
    "create table if not exists public.subscriptions",
    "growup_subscription_base_amount_minor",
    "49000",
    "99000",
    "1990000",
    "unique index if not exists uniq_subscriptions_initial_tenant",
    "alter table public.subscriptions enable row level security",
    "promotion_snapshot",
    "for update",
    "status text not null check"
  ]) assert(migration.includes(token), `subscription migration missing ${token}`);

  const cases = [
    ["starter_m", "starter", "monthly", "trialing", 49000],
    ["starter_y", "starter", "yearly", "trialing", 490000],
    ["business_m", "business", "monthly", "pending_payment", 99000],
    ["business_y", "business", "yearly", "pending_payment", 990000],
    ["enterprise_m", "enterprise", "monthly", "pending_payment", 199000],
    ["enterprise_y", "enterprise", "yearly", "pending_payment", 1990000]
  ];
  for (const [name, plan, billing, status, base] of cases) {
    const res = await signup({ username: `${name}@example.com`, plan, billing, signupRequestId: `sub-${name}` });
    assert(res.status === 200, `${name} signup failed: ${res.status} ${res.text}`);
    const sub = subscriptionForTenant(res.json().user.tenantId);
    assertSubscription(sub, { plan, billing_interval: billing, status, base_amount_minor: base, discount_amount_minor: 0, amount_due_minor: base });
    if (plan === "starter") {
      const trialDays = Math.round((new Date(sub.trial_ends_at) - new Date(sub.trial_started_at)) / (24 * 60 * 60 * 1000));
      assert(trialDays === 30, `${name} starter trial expected 30 days, got ${trialDays}`);
    } else {
      assert(!sub.trial_started_at && !sub.trial_ends_at, `${name} paid plan must not start Starter trial`);
    }
  }

  const defaultPlan = await signup({ username: "default@example.com", plan: "", billing: "", signupRequestId: "sub-default" });
  assert(defaultPlan.status === 200, `default signup failed: ${defaultPlan.text}`);
  assertSubscription(subscriptionForTenant(defaultPlan.json().user.tenantId), { plan: "starter", billing_interval: "monthly", status: "trialing", base_amount_minor: 49000, discount_amount_minor: 0, amount_due_minor: 49000 });

  for (const [label, extra] of [
    ["bad plan", { landingSelectedPlan: "pro", landingSelectedBilling: "monthly" }],
    ["bad billing", { landingSelectedPlan: "starter", landingSelectedBilling: "weekly" }]
  ]) {
    const before = clone(db);
    const res = await signup({ username: `${label.replace(" ", "-")}@example.com`, plan: "starter", billing: "monthly", signupRequestId: `sub-${label}`, extra });
    assert(res.status === 400, `${label} was not rejected: ${res.status} ${res.text}`);
    assert(db.subscriptions.length === before.subscriptions.length && db.tenants.length === before.tenants.length, `${label} left partial signup state`);
  }

  const percent = await signup({ username: "percent@example.com", plan: "business", billing: "monthly", promotionCode: "SAVE20", signupRequestId: "sub-percent" });
  assert(percent.status === 200, `percent promo signup failed: ${percent.text}`);
  assertSubscription(subscriptionForTenant(percent.json().user.tenantId), { plan: "business", billing_interval: "monthly", status: "pending_payment", base_amount_minor: 99000, discount_amount_minor: 19800, amount_due_minor: 79200 });

  const fixed = await signup({ username: "fixed@example.com", plan: "business", billing: "yearly", promotionCode: "FIXED300", signupRequestId: "sub-fixed" });
  assert(fixed.status === 200, `fixed promo signup failed: ${fixed.text}`);
  assertSubscription(subscriptionForTenant(fixed.json().user.tenantId), { plan: "business", billing_interval: "yearly", status: "pending_payment", base_amount_minor: 990000, discount_amount_minor: 30000, amount_due_minor: 960000 });

  const trial = await signup({ username: "trial@example.com", plan: "starter", billing: "monthly", promotionCode: "TRIAL15", signupRequestId: "sub-trial" });
  assert(trial.status === 400, `extra-trial promotion must not extend the exact 30-day contract: ${trial.status} ${trial.text}`);

  const month = await signup({ username: "month@example.com", plan: "enterprise", billing: "yearly", promotionCode: "MONTH1", signupRequestId: "sub-month" });
  assert(month.status === 200, `free-month promo signup failed: ${month.text}`);
  assertSubscription(subscriptionForTenant(month.json().user.tenantId), { plan: "enterprise", billing_interval: "yearly", status: "pending_payment", base_amount_minor: 1990000, discount_amount_minor: 0, amount_due_minor: 1990000, free_months: 1 });

  for (const [code, plan, billing, expectedStatus] of [
    ["MISSING", "business", "monthly", 400],
    ["EXPIRED", "starter", "monthly", 400],
    ["BUSINESSONLY", "starter", "monthly", 400]
  ]) {
    const before = clone(db);
    const res = await signup({ username: `${code.toLowerCase()}@example.com`, plan, billing, promotionCode: code, signupRequestId: `sub-${code}` });
    assert(res.status === expectedStatus, `${code} promo returned ${res.status}`);
    assert(db.subscriptions.length === before.subscriptions.length && db.promotion_redemptions.length === before.promotion_redemptions.length, `${code} promo left subscription/redemption state`);
  }

  const duplicateBefore = clone(db);
  const duplicate = await signup({ username: "existing@example.com", plan: "business", billing: "monthly", promotionCode: "SAVE20", signupRequestId: "sub-duplicate" });
  assert(duplicate.status === 409, `duplicate username returned ${duplicate.status}`);
  assert(db.subscriptions.length === duplicateBefore.subscriptions.length && db.promotion_redemptions.length === duplicateBefore.promotion_redemptions.length, "duplicate username consumed promo or created subscription");

  const onceA = await signup({ username: "once-a@example.com", plan: "business", billing: "monthly", promotionCode: "ONCE", signupRequestId: "sub-once-a" });
  const onceB = await signup({ username: "once-b@example.com", plan: "business", billing: "monthly", promotionCode: "ONCE", signupRequestId: "sub-once-b" });
  assert(onceA.status === 200 && onceB.status === 400 && onceB.json().code === "PROMOTION_CODE_EXHAUSTED", `promo once behavior failed: ${onceA.status}/${onceB.status} ${onceB.text}`);

  const idemPayload = { username: "idem@example.com", plan: "enterprise", billing: "monthly", signupRequestId: "sub-idem" };
  const idemA = await signup(idemPayload);
  const idemB = await signup(idemPayload);
  assert(idemA.status === 200 && idemB.status === 200, `idempotent signup failed: ${idemA.status}/${idemB.status}`);
  const idemTenantId = idemA.json().user.tenantId;
  assert(db.subscriptions.filter(row => row.tenant_id === idemTenantId).length === 1, "idempotent retry created duplicate subscription");

  const rollbackBefore = clone(db);
  const forced = await signup({ username: "rollback@example.com", plan: "starter", billing: "monthly", signupRequestId: "sub-rollback", businessName: "Force Subscription Failure" });
  assert(forced.status === 500 || forced.status === 400, `forced failure returned ${forced.status}`);
  assert(db.users.length === rollbackBefore.users.length && db.tenants.length === rollbackBefore.tenants.length && db.subscriptions.length === rollbackBefore.subscriptions.length, "forced subscription failure left partial signup state");

  for (const sub of db.subscriptions) {
    assert(db.tenants.some(tenant => tenant.id === sub.tenant_id), "subscription has orphan tenant");
    assert(db.subscriptions.filter(row => row.tenant_id === sub.tenant_id && row.is_initial).length === 1, "tenant has duplicate initial subscriptions");
    if (sub.promotion_redemption_id) {
      const redemption = db.promotion_redemptions.find(row => row.id === sub.promotion_redemption_id);
      assert(redemption?.tenant_id === sub.tenant_id, "promotion redemption crosses tenant ownership");
    }
  }

  assert(!migration.includes("insert into public.promotion_codes"), "subscription migration must not seed promo codes");
  assert(!migration.includes("active/paid"), "subscription migration must not pretend pending payment is paid");

  console.log("Subscription Core checks passed.");
})().catch(error => {
  console.error(error);
  process.exit(1);
});
