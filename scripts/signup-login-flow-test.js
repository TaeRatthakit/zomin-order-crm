"use strict";

process.env.NODE_ENV = "test";
process.env.DATABASE_PROVIDER = "supabase";
process.env.SUPABASE_URL = "https://signup-login-test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.SESSION_SECRET = "signup-login-test-session-secret";
process.env.AUTH_RATE_LIMIT_MAX = "200";

const { Readable } = require("stream");
const crypto = require("crypto");
const appHandler = require("../server");
const { hashPassword } = require("../lib/auth");

const db = {
  tenants: [
    { id: "11111111-1111-4111-8111-111111111111", name: "Tenant A", status: "active" },
    { id: "22222222-2222-4222-8222-222222222222", name: "Tenant B", status: "active" },
    { id: "33333333-3333-4333-8333-333333333333", name: "Tenant Suspended", status: "suspended" }
  ],
  tenant_memberships: [
    { id: "m_a_owner", tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u_owner", role: "Owner", is_active: true },
    { id: "m_a_admin", tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u_admin", role: "Admin", is_active: true },
    { id: "m_a_staff", tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u_staff", role: "Staff", is_active: true },
    { id: "m_b_owner", tenant_id: "22222222-2222-4222-8222-222222222222", user_id: "u_b_owner", role: "Owner", is_active: true },
    { id: "m_inactive", tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u_inactive_membership", role: "Owner", is_active: false },
    { id: "m_suspended", tenant_id: "33333333-3333-4333-8333-333333333333", user_id: "u_suspended", role: "Owner", is_active: true },
    { id: "m_multi_a", tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u_multi", role: "Owner", is_active: true },
    { id: "m_multi_b", tenant_id: "22222222-2222-4222-8222-222222222222", user_id: "u_multi", role: "Owner", is_active: true }
  ],
  users: [
    { id: "u_owner", username: "owner@example.com", password_hash: hashPassword("pass12345"), name: "Owner A", role: "Owner", phone: "", is_active: true },
    { id: "u_admin", username: "admin@example.com", password_hash: hashPassword("pass12345"), name: "Admin A", role: "Admin", phone: "", is_active: true },
    { id: "u_staff", username: "staff@example.com", password_hash: hashPassword("pass12345"), name: "Staff A", role: "Staff", phone: "", is_active: true },
    { id: "u_b_owner", username: "owner-b@example.com", password_hash: hashPassword("pass12345"), name: "Owner B", role: "Owner", phone: "", is_active: true },
    { id: "u_no_membership", username: "nomember@example.com", password_hash: hashPassword("pass12345"), name: "No Member", role: "Owner", phone: "", is_active: true },
    { id: "u_inactive_membership", username: "inactive-member@example.com", password_hash: hashPassword("pass12345"), name: "Inactive Member", role: "Owner", phone: "", is_active: true },
    { id: "u_disabled", username: "disabled@example.com", password_hash: hashPassword("pass12345"), name: "Disabled", role: "Owner", phone: "", is_active: false },
    { id: "u_suspended", username: "suspended@example.com", password_hash: hashPassword("pass12345"), name: "Suspended", role: "Owner", phone: "", is_active: true },
    { id: "u_multi", username: "multi@example.com", password_hash: hashPassword("pass12345"), name: "Multi", role: "Owner", phone: "", is_active: true }
  ],
  settings: [
    { id: "11111111-1111-4111-8111-111111111111:businessName", key: "businessName", value: "Tenant A", tenant_id: "11111111-1111-4111-8111-111111111111" },
    { id: "11111111-1111-4111-8111-111111111111:products", key: "products", value: [{ id: "product_a", name: "Product A", stockQuantity: 5 }], tenant_id: "11111111-1111-4111-8111-111111111111" },
    { id: "22222222-2222-4222-8222-222222222222:businessName", key: "businessName", value: "Tenant B", tenant_id: "22222222-2222-4222-8222-222222222222" },
    { id: "22222222-2222-4222-8222-222222222222:products", key: "products", value: [{ id: "product_b", name: "Product B", stockQuantity: 5 }], tenant_id: "22222222-2222-4222-8222-222222222222" }
  ],
  follow_up_rules: [
    { id: "11111111-1111-4111-8111-111111111111:1", jars: 1, days: 15, tenant_id: "11111111-1111-4111-8111-111111111111" },
    { id: "22222222-2222-4222-8222-222222222222:1", jars: 1, days: 15, tenant_id: "22222222-2222-4222-8222-222222222222" }
  ],
  customers: [
    { id: "c_a", name: "A Customer", phone: "0811111111", tenant_id: "11111111-1111-4111-8111-111111111111" },
    { id: "c_b", name: "B Customer", phone: "0822222222", tenant_id: "22222222-2222-4222-8222-222222222222" }
  ],
  orders: [
    { id: "o_a", customer_id: "c_a", items: "Product A", quantity: 1, amount: 100, order_date: "2026-08-09", tenant_id: "11111111-1111-4111-8111-111111111111" },
    { id: "o_b", customer_id: "c_b", items: "Product B", quantity: 1, amount: 100, order_date: "2026-08-09", tenant_id: "22222222-2222-4222-8222-222222222222" }
  ],
  line_messages: [],
  tags: [],
  customer_tags: [],
  contact_logs: [],
  notification_reads: [],
  tenant_role_permissions: [],
  tenant_settings: [],
  signup_bootstraps: [],
  promotion_codes: [
    { id: "promo_valid", code: "growup20", active: true, benefit_type: "percent_discount", benefit_value: 20, applicable_plans: ["business"], applicable_billing: ["monthly"], starts_at: "2026-01-01T00:00:00.000Z", ends_at: "2027-01-01T00:00:00.000Z", max_redemptions: null, max_redemptions_per_tenant: null },
    { id: "promo_fixed", code: "fixed300", active: true, benefit_type: "fixed_amount_discount", benefit_value: 300, applicable_plans: ["business"], applicable_billing: ["monthly"], starts_at: null, ends_at: null, max_redemptions: null, max_redemptions_per_tenant: null },
    { id: "promo_trial", code: "trial30", active: true, benefit_type: "extra_trial_days", benefit_value: 30, applicable_plans: ["starter"], applicable_billing: ["monthly", "yearly"], starts_at: null, ends_at: null, max_redemptions: null, max_redemptions_per_tenant: null },
    { id: "promo_month", code: "month1", active: true, benefit_type: "free_months", benefit_value: 1, applicable_plans: ["enterprise"], applicable_billing: ["yearly"], starts_at: null, ends_at: null, max_redemptions: null, max_redemptions_per_tenant: null },
    { id: "promo_inactive", code: "inactive", active: false, benefit_type: "percent_discount", benefit_value: 10, applicable_plans: ["starter"], applicable_billing: ["monthly"], starts_at: null, ends_at: null, max_redemptions: null, max_redemptions_per_tenant: null },
    { id: "promo_expired", code: "expired", active: true, benefit_type: "percent_discount", benefit_value: 10, applicable_plans: ["starter"], applicable_billing: ["monthly"], starts_at: "2025-01-01T00:00:00.000Z", ends_at: "2025-02-01T00:00:00.000Z", max_redemptions: null, max_redemptions_per_tenant: null },
    { id: "promo_maxed", code: "maxed", active: true, benefit_type: "percent_discount", benefit_value: 10, applicable_plans: ["starter"], applicable_billing: ["monthly"], starts_at: null, ends_at: null, max_redemptions: 1, max_redemptions_per_tenant: null },
    { id: "promo_last", code: "lastone", active: true, benefit_type: "percent_discount", benefit_value: 15, applicable_plans: ["business"], applicable_billing: ["monthly"], starts_at: null, ends_at: null, max_redemptions: 1, max_redemptions_per_tenant: null },
    { id: "promo_per_tenant", code: "tenantonce", active: true, benefit_type: "percent_discount", benefit_value: 5, applicable_plans: ["starter"], applicable_billing: ["monthly"], starts_at: null, ends_at: null, max_redemptions: null, max_redemptions_per_tenant: 1 }
  ],
  promotion_redemptions: [
    { id: "redemption_maxed", promotion_code_id: "promo_maxed", tenant_id: "11111111-1111-4111-8111-111111111111", selected_plan: "starter", selected_billing: "monthly", benefit_type: "percent_discount", benefit_value: 10, benefit_description: "ลด 10%", redeemed_at: "2026-08-01T00:00:00.000Z" },
    { id: "redemption_per_tenant", promotion_code_id: "promo_per_tenant", tenant_id: "11111111-1111-4111-8111-111111111111", selected_plan: "starter", selected_billing: "monthly", benefit_type: "percent_discount", benefit_value: 5, benefit_description: "ลด 5%", redeemed_at: "2026-08-01T00:00:00.000Z" }
  ]
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
    if (value.startsWith("eq.")) {
      const expected = parseValue(value.slice(3));
      out = out.filter(row => String(row[key]) === expected);
    } else if (value.startsWith("in.")) {
      const values = new Set(parseIn(value.slice(3)));
      out = out.filter(row => values.has(String(row[key])));
    }
  }
  const limit = Number(params.get("limit") || 0);
  return limit ? out.slice(0, limit) : out;
}

function conflictKey(row, params) {
  return String(params.get("on_conflict") || "id").split(",").map(key => `${key}:${row[key]}`).join("|");
}

function rpcError(message) {
  return new Response(JSON.stringify({ message }), { status: 400 });
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
  const tenantId = String(payload.p_tenant_id || "").trim();
  const invalid = reason => [{
    valid: false,
    code,
    selected_plan: selectedPlan,
    selected_billing: selectedBilling,
    benefit_type: null,
    benefit_value: null,
    benefit_description: null,
    reason
  }];
  if (!code || !["starter", "business", "enterprise"].includes(selectedPlan) || !["monthly", "yearly"].includes(selectedBilling)) {
    return invalid("PROMOTION_CODE_INVALID");
  }
  const promo = db.promotion_codes.find(row => normalizePromotionCode(row.code) === code);
  if (!promo || !promo.active) return invalid("PROMOTION_CODE_INVALID");
  const now = new Date("2026-08-11T00:00:00.000Z").getTime();
  if ((promo.starts_at && new Date(promo.starts_at).getTime() > now) || (promo.ends_at && new Date(promo.ends_at).getTime() < now)) {
    return invalid("PROMOTION_CODE_EXPIRED");
  }
  if (!promo.applicable_plans.includes(selectedPlan) || !promo.applicable_billing.includes(selectedBilling)) {
    return invalid("PROMOTION_CODE_INVALID");
  }
  const totalRedemptions = db.promotion_redemptions.filter(row => row.promotion_code_id === promo.id).length;
  if (promo.max_redemptions && totalRedemptions >= promo.max_redemptions) return invalid("PROMOTION_CODE_EXHAUSTED");
  if (tenantId && promo.max_redemptions_per_tenant) {
    const tenantRedemptions = db.promotion_redemptions.filter(row => row.promotion_code_id === promo.id && row.tenant_id === tenantId).length;
    if (tenantRedemptions >= promo.max_redemptions_per_tenant) return invalid("PROMOTION_CODE_EXHAUSTED");
  }
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

function signupCounts() {
  return {
    users: db.users.length,
    tenants: db.tenants.length,
    memberships: db.tenant_memberships.length,
    rolePermissions: db.tenant_role_permissions.length,
    settings: db.settings.length,
    followUpRules: db.follow_up_rules.length,
    bootstraps: db.signup_bootstraps.length,
    redemptions: db.promotion_redemptions.length
  };
}

function assertCountsUnchanged(before, label) {
  const after = signupCounts();
  for (const key of Object.keys(before)) {
    if (after[key] !== before[key]) fail(`${label} changed ${key}: ${before[key]} -> ${after[key]}`);
  }
}

function signupBootstrap(payload = {}) {
  const key = String(payload.p_idempotency_key || "").trim();
  const username = String(payload.p_username || "").trim().toLowerCase();
  const existingBootstrap = db.signup_bootstraps.find(row => row.idempotency_key === key);
  if (existingBootstrap) {
    if (existingBootstrap.username !== username) return rpcError("IDEMPOTENCY_CONFLICT");
    return new Response(JSON.stringify(signupResult(existingBootstrap.user_id, existingBootstrap.tenant_id)), { status: 200 });
  }
  if (db.users.some(row => row.username.toLowerCase() === username)) return rpcError("ACCOUNT_EXISTS");
  if (!key || !username || !payload.p_password_hash || !payload.p_business_name) return rpcError("INVALID_SIGNUP_INPUT");
  const promoResult = payload.p_promotion_code ? validatePromotionRule(payload)[0] : null;
  if (promoResult && !promoResult.valid) return rpcError(promoResult.reason);
  const tenantId = crypto.randomUUID();
  const userId = String(payload.p_user_id || `u_${crypto.randomUUID()}`);
  db.users.push({
    id: userId,
    username,
    password_hash: payload.p_password_hash,
    name: String(payload.p_name || payload.p_business_name),
    role: "Owner",
    phone: "",
    is_active: true
  });
  db.tenants.push({ id: tenantId, name: String(payload.p_business_name), status: "active", metadata: { source: "public_signup" } });
  db.tenant_memberships.push({ id: crypto.randomUUID(), tenant_id: tenantId, user_id: userId, role: "Owner", is_active: true });
  for (const role of ["Owner", "Admin", "Staff"]) {
    db.tenant_role_permissions.push({ tenant_id: tenantId, role, permissions: {} });
  }
  const defaults = payload.p_defaults || {};
  for (const [settingKey, value] of Object.entries(defaults.settings || {})) {
    db.settings.push({ id: `${tenantId}:${settingKey}`, key: settingKey, value, tenant_id: tenantId });
  }
  for (const rule of defaults.followUpRules || []) {
    db.follow_up_rules.push({ id: `${tenantId}:${rule.jars}`, jars: rule.jars, days: rule.days, tenant_id: tenantId });
  }
  if (promoResult?.valid) {
    const promo = db.promotion_codes.find(row => normalizePromotionCode(row.code) === promoResult.code);
    db.promotion_redemptions.push({
      id: crypto.randomUUID(),
      promotion_code_id: promo.id,
      tenant_id: tenantId,
      selected_plan: promoResult.selected_plan,
      selected_billing: promoResult.selected_billing,
      benefit_type: promo.benefit_type,
      benefit_value: promo.benefit_value,
      benefit_description: promoResult.benefit_description,
      redeemed_at: new Date().toISOString()
    });
  }
  db.signup_bootstraps.push({ idempotency_key: key, username, user_id: userId, tenant_id: tenantId, status: "completed" });
  return new Response(JSON.stringify(signupResult(userId, tenantId)), { status: 200 });
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

global.fetch = async function mockFetch(input, options = {}) {
  const url = new URL(String(input));
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.at(-2) === "rpc" && parts.at(-1) === "growup_signup_bootstrap") {
    return signupBootstrap(JSON.parse(options.body || "{}"));
  }
  if (parts.at(-2) === "rpc" && parts.at(-1) === "growup_validate_promotion_code") {
    return new Response(JSON.stringify(validatePromotionRule(JSON.parse(options.body || "{}"))), { status: 200 });
  }
  const table = parts.at(-1);
  if (!Object.prototype.hasOwnProperty.call(db, table)) {
    return new Response(JSON.stringify({ message: `unknown table ${table}` }), { status: 404 });
  }
  const method = String(options.method || "GET").toUpperCase();
  if (method === "GET") {
    const rows = applyFilters(db[table], url.searchParams);
    return new Response(JSON.stringify(rows), { status: 200 });
  }
  if (method === "POST") {
    const rows = JSON.parse(options.body || "[]");
    for (const row of rows) {
      const key = conflictKey(row, url.searchParams);
      const index = db[table].findIndex(existing => conflictKey(existing, url.searchParams) === key);
      if (index === -1) db[table].push({ ...row });
      else db[table][index] = { ...db[table][index], ...row };
    }
    return new Response(JSON.stringify(rows), { status: 200 });
  }
  if (method === "DELETE") {
    const rows = new Set(applyFilters(db[table], url.searchParams));
    db[table] = db[table].filter(row => !rows.has(row));
    return new Response(null, { status: 204 });
  }
  if (method === "PATCH") {
    const patch = JSON.parse(options.body || "{}");
    for (const row of applyFilters(db[table], url.searchParams)) Object.assign(row, patch);
    return new Response(null, { status: 204 });
  }
  return new Response("unsupported", { status: 405 });
};

function header(headers, name) {
  const found = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found ? found[1] : "";
}

function makeRequest(path, options = {}) {
  const body = options.body || "";
  const req = Readable.from(body ? [body] : []);
  req.method = options.method || "GET";
  req.url = path;
  req.headers = {
    host: "127.0.0.1",
    ...(options.headers || {})
  };
  return req;
}

function makeResponse(resolve) {
  const chunks = [];
  return {
    statusCode: 200,
    headers: {},
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = { ...this.headers, ...headers };
    },
    setHeader(key, value) {
      this.headers[key] = value;
    },
    write(chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      resolve({
        status: this.statusCode,
        headers: this.headers,
        text: Buffer.concat(chunks).toString("utf8"),
        json() {
          return this.text ? JSON.parse(this.text) : {};
        }
      });
    }
  };
}

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = makeRequest(path, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...(options.headers || {})
      }
    });
    const res = makeResponse(resolve);
    Promise.resolve(appHandler(req, res)).catch(reject);
  });
}

async function login(username, password = "pass12345") {
  const res = await request("/api/login", {
    method: "POST",
    body: JSON.stringify({ username, password })
  });
  if (res.status !== 200) fail(`${username} login returned ${res.status}: ${res.text}`);
  const cookie = header(res.headers, "set-cookie");
  if (!cookie) fail(`${username} login did not set cookie`);
  return { cookie, body: res.json() };
}

(async () => {
  try {
    const runtime = await request("/api/verify/runtime");
    if (runtime.status !== 200) fail(`runtime verify returned ${runtime.status}`);
    const runtimeBody = runtime.json();
    if (JSON.stringify(runtimeBody).includes("test-service-role-key")) fail("runtime verify leaked service role key");

    const owner = await login("owner@example.com");
    const admin = await login("admin@example.com");
    const staff = await login("staff@example.com");
    if (owner.body.user.role !== "Owner" || admin.body.user.role !== "Admin" || staff.body.user.role !== "Staff") fail("login roles were not preserved");
    if (owner.body.user.tenantId !== "11111111-1111-4111-8111-111111111111") fail("owner login did not resolve tenant A");

    for (const username of ["owner@example.com", "nomember@example.com", "inactive-member@example.com", "disabled@example.com", "suspended@example.com", "multi@example.com"]) {
      const res = await request("/api/login", {
        method: "POST",
        body: JSON.stringify({ username, password: username === "owner@example.com" ? "wrongpass" : "pass12345" })
      });
      if (res.status !== 401) fail(`${username} unsafe login returned ${res.status}`);
      if (!res.text.includes("Username หรือ Password ไม่ถูกต้อง")) fail(`${username} login leaked auth details: ${res.text}`);
    }

    const spoofedState = await request("/api/state", {
      headers: { cookie: owner.cookie, "x-tenant-id": "22222222-2222-4222-8222-222222222222" }
    });
    if (spoofedState.status !== 200) fail(`spoofed state returned ${spoofedState.status}`);
    const spoofedBody = spoofedState.json();
    if ((spoofedBody.orders || []).some(order => order.id === "o_b")) fail("tenant spoofing exposed tenant B order");

    const crossDelete = await request("/api/orders/o_b", { method: "DELETE", headers: { cookie: owner.cookie } });
    if (crossDelete.status !== 404) fail(`cross-tenant delete returned ${crossDelete.status}: ${crossDelete.text}`);
    const ownerB = await login("owner-b@example.com");
    const tenantBState = (await request("/api/state", { headers: { cookie: ownerB.cookie } })).json();
    if (!(tenantBState.orders || []).some(order => order.id === "o_b")) fail("tenant A direct-ID attempt deleted tenant B order");

    const signupPayload = {
      username: "new_owner",
      password: "newpass123",
      businessName: "New Pilot Co",
      displayName: "New Owner",
      signupRequestId: "signup-test-1"
    };
    const signup = await request("/api/signup", { method: "POST", body: JSON.stringify(signupPayload) });
    if (signup.status !== 200) fail(`signup returned ${signup.status}: ${signup.text}`);
    const signupCookie = header(signup.headers, "set-cookie");
    const signupUser = signup.json().user;
    if (signupUser.role !== "Owner" || signupUser.tenantRole !== "Owner" || !signupUser.tenantId) fail("signup did not create Owner tenant session");
    const signupTenantId = signupUser.tenantId;
    const newTenantSettings = db.settings.filter(row => row.tenant_id === signupTenantId);
    if (!newTenantSettings.some(row => row.key === "businessName" && row.value === "New Pilot Co")) fail("signup did not initialize tenant businessName");
    if (db.tenant_memberships.filter(row => row.tenant_id === signupTenantId && row.role === "Owner").length !== 1) fail("signup created duplicate Owner membership");

    const duplicateSubmit = await request("/api/signup", { method: "POST", body: JSON.stringify(signupPayload) });
    if (duplicateSubmit.status !== 200) fail(`duplicate idempotent signup returned ${duplicateSubmit.status}: ${duplicateSubmit.text}`);
    if (db.tenants.filter(row => row.name === "New Pilot Co").length !== 1) fail("duplicate signup created another tenant");
    if (db.tenant_memberships.filter(row => row.tenant_id === signupTenantId && row.role === "Owner").length !== 1) fail("duplicate signup created another Owner");

    const validPromo = await request("/api/signup/promotion-code", {
      method: "POST",
      body: JSON.stringify({ promotionCode: " GROWUP20 ", selectedPlan: "business", selectedBilling: "monthly" })
    });
    if (validPromo.status !== 200) fail(`valid promo returned ${validPromo.status}: ${validPromo.text}`);
    const validPromoBody = validPromo.json().promotion;
    if (validPromoBody.code !== "GROWUP20" || validPromoBody.benefitDescription !== "ลด 20%") fail(`valid promo returned unsafe body: ${validPromo.text}`);
    if (JSON.stringify(validPromoBody).includes("promo_valid") || JSON.stringify(validPromoBody).includes("max_redemptions")) fail(`promo validation leaked internals: ${validPromo.text}`);

    for (const [promotionCode, selectedPlan, selectedBilling, expectedDescription] of [
      ["fixed300", "business", "monthly", "ลด ฿300"],
      ["month1", "enterprise", "yearly", "ใช้ฟรีเพิ่ม 1 เดือน"]
    ]) {
      const benefitTypePromo = await request("/api/signup/promotion-code", {
        method: "POST",
        body: JSON.stringify({ promotionCode, selectedPlan, selectedBilling })
      });
      if (benefitTypePromo.status !== 200 || benefitTypePromo.json().promotion.benefitDescription !== expectedDescription) {
        fail(`benefit type ${promotionCode} returned wrong description: ${benefitTypePromo.text}`);
      }
    }

    const extraTrialPromo = await request("/api/signup/promotion-code", {
      method: "POST",
      body: JSON.stringify({ promotionCode: "trial30", selectedPlan: "starter", selectedBilling: "monthly" })
    });
    if (extraTrialPromo.status !== 400 || extraTrialPromo.json().code !== "PROMOTION_CODE_INVALID") {
      fail(`extra-trial promo must not extend the exact 30-day contract: ${extraTrialPromo.text}`);
    }

    const invalidPromo = await request("/api/signup/promotion-code", {
      method: "POST",
      body: JSON.stringify({ promotionCode: "missing", selectedPlan: "business", selectedBilling: "monthly" })
    });
    if (invalidPromo.status !== 400 || invalidPromo.json().code !== "PROMOTION_CODE_INVALID") fail(`invalid promo was not rejected safely: ${invalidPromo.text}`);

    const expiredPromo = await request("/api/signup/promotion-code", {
      method: "POST",
      body: JSON.stringify({ promotionCode: "expired", selectedPlan: "starter", selectedBilling: "monthly" })
    });
    if (expiredPromo.status !== 400 || expiredPromo.json().code !== "PROMOTION_CODE_EXPIRED" || !expiredPromo.text.includes("หมดอายุ")) fail(`expired promo returned wrong response: ${expiredPromo.text}`);

    const inactivePromo = await request("/api/signup/promotion-code", {
      method: "POST",
      body: JSON.stringify({ promotionCode: "inactive", selectedPlan: "starter", selectedBilling: "monthly" })
    });
    if (inactivePromo.status !== 400 || inactivePromo.json().code !== "PROMOTION_CODE_INVALID") fail(`inactive promo returned wrong response: ${inactivePromo.text}`);

    const wrongPlanPromo = await request("/api/signup/promotion-code", {
      method: "POST",
      body: JSON.stringify({ promotionCode: "growup20", selectedPlan: "starter", selectedBilling: "monthly" })
    });
    if (wrongPlanPromo.status !== 400 || wrongPlanPromo.json().code !== "PROMOTION_CODE_INVALID") fail(`wrong plan promo returned wrong response: ${wrongPlanPromo.text}`);

    const wrongBillingPromo = await request("/api/signup/promotion-code", {
      method: "POST",
      body: JSON.stringify({ promotionCode: "growup20", selectedPlan: "business", selectedBilling: "yearly" })
    });
    if (wrongBillingPromo.status !== 400 || wrongBillingPromo.json().code !== "PROMOTION_CODE_INVALID") fail(`wrong billing promo returned wrong response: ${wrongBillingPromo.text}`);

    const maxedPromo = await request("/api/signup/promotion-code", {
      method: "POST",
      body: JSON.stringify({ promotionCode: "maxed", selectedPlan: "starter", selectedBilling: "monthly" })
    });
    if (maxedPromo.status !== 400 || maxedPromo.json().code !== "PROMOTION_CODE_EXHAUSTED") fail(`maxed promo returned wrong response: ${maxedPromo.text}`);

    const perTenantRpc = await global.fetch("https://signup-login-test.supabase.co/rest/v1/rpc/growup_validate_promotion_code", {
      method: "POST",
      body: JSON.stringify({
        p_code: "tenantonce",
        p_selected_plan: "starter",
        p_selected_billing: "monthly",
        p_tenant_id: "11111111-1111-4111-8111-111111111111"
      })
    });
    const perTenantBody = (await perTenantRpc.json())[0];
    if (perTenantBody.valid !== false || perTenantBody.reason !== "PROMOTION_CODE_EXHAUSTED") fail(`per-tenant promo rule was not enforceable: ${JSON.stringify(perTenantBody)}`);

    const beforePromoSignupCounts = signupCounts();
    const promoSignupPayload = {
      username: "promo_owner",
      password: "promopass123",
      businessName: "Promo Pilot Co",
      displayName: "Promo Owner",
      landingSelectedPlan: "business",
      landingSelectedBilling: "monthly",
      promotionCode: "growup20",
      clientDiscountValue: 999999,
      signupRequestId: "signup-test-promo-1"
    };
    const promoSignup = await request("/api/signup", { method: "POST", body: JSON.stringify(promoSignupPayload) });
    if (promoSignup.status !== 200) fail(`promo signup returned ${promoSignup.status}: ${promoSignup.text}`);
    const promoTenantId = promoSignup.json().user.tenantId;
    const promoRedemptions = db.promotion_redemptions.filter(row => row.tenant_id === promoTenantId);
    if (promoRedemptions.length !== 1) fail(`promo signup recorded ${promoRedemptions.length} redemptions`);
    if (promoRedemptions[0].benefit_value !== 20 || promoRedemptions[0].benefit_description !== "ลด 20%") fail("promo signup trusted browser-supplied discount instead of server rule");
    const promoDuplicateSubmit = await request("/api/signup", { method: "POST", body: JSON.stringify(promoSignupPayload) });
    if (promoDuplicateSubmit.status !== 200) fail(`promo idempotent retry returned ${promoDuplicateSubmit.status}: ${promoDuplicateSubmit.text}`);
    if (db.promotion_redemptions.filter(row => row.tenant_id === promoTenantId).length !== 1) fail("promo idempotent retry double-redeemed");
    if (signupCounts().redemptions !== beforePromoSignupCounts.redemptions + 1) fail("promo signup did not increment redemption count exactly once");

    const beforeFailedPromoSignupCounts = signupCounts();
    const failedPromoSignup = await request("/api/signup", {
      method: "POST",
      body: JSON.stringify({
        ...promoSignupPayload,
        username: "owner@example.com",
        businessName: "Failed Promo Co",
        signupRequestId: "signup-test-promo-fail"
      })
    });
    if (failedPromoSignup.status !== 409) fail(`failed promo duplicate signup returned ${failedPromoSignup.status}: ${failedPromoSignup.text}`);
    assertCountsUnchanged(beforeFailedPromoSignupCounts, "failed promo signup");

    const concurrentPromoPayloads = ["a", "b"].map(suffix => ({
      username: `last_promo_${suffix}`,
      password: "lastpass123",
      businessName: `Last Promo ${suffix}`,
      displayName: `Last Promo Owner ${suffix}`,
      landingSelectedPlan: "business",
      landingSelectedBilling: "monthly",
      promotionCode: "lastone",
      signupRequestId: `signup-test-last-promo-${suffix}`
    }));
    const beforeLastPromoCounts = signupCounts();
    const lastPromoResults = await Promise.all(concurrentPromoPayloads.map(payload =>
      request("/api/signup", { method: "POST", body: JSON.stringify(payload) })
    ));
    const lastPromoSuccesses = lastPromoResults.filter(result => result.status === 200);
    const lastPromoRejected = lastPromoResults.filter(result => result.status === 400 && result.json().code === "PROMOTION_CODE_EXHAUSTED");
    if (lastPromoSuccesses.length !== 1 || lastPromoRejected.length !== 1) {
      fail(`last redemption race expected one success and one exhausted promo: ${lastPromoResults.map(result => `${result.status}:${result.text}`).join(" | ")}`);
    }
    const afterLastPromoCounts = signupCounts();
    if (afterLastPromoCounts.users !== beforeLastPromoCounts.users + 1 || afterLastPromoCounts.tenants !== beforeLastPromoCounts.tenants + 1 || afterLastPromoCounts.redemptions !== beforeLastPromoCounts.redemptions + 1) {
      fail("last redemption race left partial signup or duplicate redemption data");
    }

    const beforeDuplicateCounts = signupCounts();
    const existingAccount = await request("/api/signup", {
      method: "POST",
      body: JSON.stringify({ ...signupPayload, signupRequestId: "signup-test-2" })
    });
    if (existingAccount.status !== 409) fail(`existing account signup returned ${existingAccount.status}`);
    const existingBody = existingAccount.json();
    if (existingBody.code !== "DUPLICATE_USERNAME") fail(`duplicate signup returned wrong code: ${existingAccount.text}`);
    if (existingBody.field !== "username") fail(`duplicate signup returned wrong field: ${existingAccount.text}`);
    if (existingBody.error !== "ชื่อผู้ใช้งานนี้ถูกใช้แล้ว กรุณาใช้ชื่ออื่น") fail(`duplicate signup returned wrong error: ${existingAccount.text}`);
    assertCountsUnchanged(beforeDuplicateCounts, "duplicate username signup");

    const beforeCaseDuplicateCounts = signupCounts();
    const caseDuplicate = await request("/api/signup", {
      method: "POST",
      body: JSON.stringify({
        ...signupPayload,
        username: "New_Owner",
        businessName: "Case Duplicate Co",
        displayName: "Case Duplicate",
        signupRequestId: "signup-test-case-duplicate"
      })
    });
    if (caseDuplicate.status !== 409) fail(`case duplicate signup returned ${caseDuplicate.status}: ${caseDuplicate.text}`);
    if (caseDuplicate.json().error !== "ชื่อผู้ใช้งานนี้ถูกใช้แล้ว กรุณาใช้ชื่ออื่น") fail(`case duplicate signup returned wrong error: ${caseDuplicate.text}`);
    assertCountsUnchanged(beforeCaseDuplicateCounts, "case-normalized duplicate username signup");

    const concurrentPayloads = ["a", "b"].map(suffix => ({
      username: "race_owner",
      password: "racepass123",
      businessName: `Race Pilot ${suffix}`,
      displayName: `Race Owner ${suffix}`,
      signupRequestId: `signup-test-race-${suffix}`
    }));
    const beforeConcurrentCounts = signupCounts();
    const concurrentResults = await Promise.all(concurrentPayloads.map(payload =>
      request("/api/signup", { method: "POST", body: JSON.stringify(payload) })
    ));
    const concurrentSuccesses = concurrentResults.filter(result => result.status === 200);
    const concurrentDuplicates = concurrentResults.filter(result => result.status === 409);
    if (concurrentSuccesses.length !== 1 || concurrentDuplicates.length !== 1) {
      fail(`concurrent duplicate signup expected one success and one duplicate: ${concurrentResults.map(result => `${result.status}:${result.text}`).join(" | ")}`);
    }
    if (concurrentDuplicates[0].json().error !== "ชื่อผู้ใช้งานนี้ถูกใช้แล้ว กรุณาใช้ชื่ออื่น") fail(`concurrent duplicate returned wrong error: ${concurrentDuplicates[0].text}`);
    const afterConcurrentCounts = signupCounts();
    if (afterConcurrentCounts.users !== beforeConcurrentCounts.users + 1) fail("concurrent duplicate created an unexpected user count");
    if (afterConcurrentCounts.tenants !== beforeConcurrentCounts.tenants + 1) fail("concurrent duplicate created an unexpected tenant count");
    if (afterConcurrentCounts.memberships !== beforeConcurrentCounts.memberships + 1) fail("concurrent duplicate created an unexpected membership count");
    if (afterConcurrentCounts.bootstraps !== beforeConcurrentCounts.bootstraps + 1) fail("concurrent duplicate created an unexpected bootstrap count");

    const newState = (await request("/api/state", { headers: { cookie: signupCookie } })).json();
    if (newState.settings?.businessName !== "New Pilot Co") fail("new signup session did not enter new tenant state");
    if ((newState.orders || []).some(order => ["o_a", "o_b"].includes(order.id))) fail("new tenant can see another tenant order");
    const tenantBAfterSignup = (await request("/api/state", { headers: { cookie: ownerB.cookie } })).json();
    if ((tenantBAfterSignup.users || []).some(user => user.username === "new-owner@example.com")) fail("tenant B can see new tenant user");

    const badSignup = await request("/api/signup", {
      method: "POST",
      body: JSON.stringify({ username: "bad", password: "short", businessName: "" })
    });
    if (badSignup.status !== 400) fail(`invalid signup returned ${badSignup.status}`);

    const logout = await request("/api/logout", { method: "POST", headers: { cookie: signupCookie } });
    if (logout.status !== 200 || !header(logout.headers, "set-cookie").includes("Expires=Thu, 01 Jan 1970")) fail("logout did not clear cookie");
    const privateState = await request("/api/state");
    if (privateState.status !== 401) fail(`private state returned ${privateState.status}: ${privateState.text}`);
    const privateRoute = await request("/dashboard");
    if (privateRoute.status !== 302 || header(privateRoute.headers, "location") !== "/login") fail("private route was accessible after logout without cookie");
    const usernameLogin = await login("new_owner", "newpass123");
    const usernameState = (await request("/api/state", { headers: { cookie: usernameLogin.cookie } })).json();
    if (usernameState.settings?.businessName !== "New Pilot Co") fail("username signup login did not enter bootstrapped tenant state");
    if (usernameLogin.body.user.username !== "new_owner") fail("username signup login returned the wrong user");

    console.log("Signup/Login flow security test passed.");
  } finally {}
})().catch(error => {
  console.error(error);
  process.exit(1);
});
