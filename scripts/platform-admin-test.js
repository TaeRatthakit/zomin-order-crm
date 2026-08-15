"use strict";

process.env.NODE_ENV = "test";
process.env.DATABASE_PROVIDER = "supabase";
process.env.SUPABASE_URL = "https://platform-admin-test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.SESSION_SECRET = "platform-admin-test-session-secret";
process.env.AUTH_RATE_LIMIT_MAX = "500";

const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const crypto = require("crypto");
const { hashPassword } = require("../lib/auth");

const ROOT = path.join(__dirname, "..");
const migration = fs.readFileSync(path.join(ROOT, "supabase", "migrations", "20260814020000_platform_admin.sql"), "utf8");

const db = {
  tenants: [{ id: "11111111-1111-4111-8111-111111111111", name: "Tenant A", status: "active", created_at: "2026-08-14T00:00:00.000Z" }],
  users: [
    { id: "u_owner", username: "owner@example.com", password_hash: hashPassword("pass12345"), name: "Owner", role: "Owner", phone: "", is_active: true },
    { id: "u_platform", username: "platform@example.com", password_hash: hashPassword("pass12345"), name: "Platform", role: "Owner", phone: "", is_active: true },
    { id: "u_support", username: "support@example.com", password_hash: hashPassword("pass12345"), name: "Support", role: "Owner", phone: "", is_active: true }
  ],
  tenant_memberships: [
    { id: "m_owner", tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u_owner", role: "Owner", is_active: true },
    { id: "m_platform", tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u_platform", role: "Owner", is_active: true },
    { id: "m_support", tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u_support", role: "Owner", is_active: true }
  ],
  platform_admin_memberships: [
    { id: "pam_platform", user_id: "u_platform", role: "super_admin", active: true },
    { id: "pam_support", user_id: "u_support", role: "support", active: true }
  ],
  platform_admin_audit_log: [],
  subscriptions: [{ id: "sub_a", tenant_id: "11111111-1111-4111-8111-111111111111", is_initial: true, plan: "starter", billing_interval: "monthly", status: "trialing", amount_due_minor: 49000 }],
  payments: [],
  promotion_codes: [],
  promotion_redemptions: [],
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

function applyFilters(rows, params) {
  let out = [...rows];
  for (const [key, value] of params.entries()) {
    if (["select", "limit", "order", "on_conflict"].includes(key)) continue;
    if (value.startsWith("eq.")) out = out.filter(row => String(row[key]) === parseValue(value.slice(3)));
  }
  const limit = Number(params.get("limit") || 0);
  return limit ? out.slice(0, limit) : out;
}

function rpcError(message) {
  return new Response(JSON.stringify({ message }), { status: 400 });
}

function platformRole(userId) {
  return db.platform_admin_memberships.find(row => row.user_id === userId && row.active)?.role || "";
}

function requirePlatform(payload) {
  const role = platformRole(String(payload.p_user_id || ""));
  if (!role) return null;
  return role;
}

function platformRpc(name, payload = {}) {
  const role = requirePlatform(payload);
  if (!role) return rpcError("PLATFORM_ADMIN_REQUIRED");
  if (name === "growup_platform_admin_overview") {
    return new Response(JSON.stringify({ role, tenants: { total: db.tenants.length, active: 1 }, subscriptions: { active: 0, pending_payment: 0, trialing: 1, expired: 0 }, payments: { pending: 0, paid: 0, failed: 0 } }), { status: 200 });
  }
  if (name === "growup_platform_admin_tenants") return new Response(JSON.stringify({ role, items: db.tenants.map(tenant => ({ ...tenant, plan: "starter", billing_interval: "monthly", subscription_status: "trialing", active_users: 3 })) }), { status: 200 });
  if (name === "growup_platform_admin_payments") return new Response(JSON.stringify({ role, items: [] }), { status: 200 });
  if (name === "growup_platform_admin_promotion_codes") return new Response(JSON.stringify({ role, items: db.promotion_codes.map(code => ({ ...code, redemptions: 0 })) }), { status: 200 });
  if (name === "growup_platform_admin_upsert_promotion_code") {
    if (!["super_admin", "admin"].includes(role)) return rpcError("PLATFORM_ADMIN_WRITE_FORBIDDEN");
    const input = payload.p_input || {};
    if (!input.code || !input.benefit_type || Number(input.benefit_value || 0) <= 0) return rpcError("INVALID_PROMOTION_CODE");
    const row = {
      id: input.id || crypto.randomUUID(),
      code: String(input.code).trim().toUpperCase(),
      active: input.active !== false,
      benefit_type: input.benefit_type,
      benefit_value: Number(input.benefit_value),
      applicable_plans: input.applicable_plans || ["starter", "business", "enterprise"],
      applicable_billing: input.applicable_billing || ["monthly", "yearly"]
    };
    db.promotion_codes.push(row);
    db.platform_admin_audit_log.push({ actor_user_id: payload.p_user_id, action: "promotion_code.create", target_type: "promotion_code", target_id: row.id });
    return new Response(JSON.stringify({ role, promotion: row }), { status: 200 });
  }
  return rpcError("unknown rpc");
}

global.fetch = async function mockFetch(input, options = {}) {
  const url = new URL(String(input));
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.at(-2) === "rpc") return platformRpc(parts.at(-1), JSON.parse(options.body || "{}"));
  const table = parts.at(-1);
  if (!Object.prototype.hasOwnProperty.call(db, table)) return new Response(JSON.stringify({ message: `unknown table ${table}` }), { status: 404 });
  return new Response(JSON.stringify(applyFilters(db[table], url.searchParams)), { status: 200 });
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
    "create table if not exists public.platform_admin_memberships",
    "platform_admin_audit_log",
    "growup_require_platform_admin",
    "growup_platform_admin_overview",
    "growup_platform_admin_upsert_promotion_code",
    "PLATFORM_ADMIN_WRITE_FORBIDDEN"
  ]) {
    if (!migration.includes(token)) fail(`platform admin migration missing ${token}`);
  }

  const loggedOut = await request("/api/platform-admin/overview");
  if (loggedOut.status !== 401) fail(`logged-out platform admin API was not blocked: ${loggedOut.status} ${loggedOut.text}`);

  const ownerCookie = await login("owner@example.com");
  const denied = await request("/api/platform-admin/overview", { headers: { cookie: ownerCookie } });
  if (denied.status !== 403 || denied.json().code !== "PLATFORM_ADMIN_REQUIRED") fail(`tenant Owner was not blocked from platform admin: ${denied.status} ${denied.text}`);

  const supportCookie = await login("support@example.com");
  const supportWrite = await request("/api/platform-admin/promotions", {
    method: "POST",
    headers: { cookie: supportCookie },
    body: JSON.stringify({ code: "SUPPORT", benefit_type: "percent_discount", benefit_value: 10 })
  });
  if (supportWrite.status !== 403 || supportWrite.json().code !== "PLATFORM_ADMIN_WRITE_FORBIDDEN") fail(`support write was not blocked: ${supportWrite.status} ${supportWrite.text}`);

  const platformCookie = await login("platform@example.com");
  const overview = await request("/api/platform-admin/overview", { headers: { cookie: platformCookie } });
  if (overview.status !== 200 || overview.json().overview.role !== "super_admin") fail(`platform overview failed: ${overview.status} ${overview.text}`);
  const createPromo = await request("/api/platform-admin/promotions", {
    method: "POST",
    headers: { cookie: platformCookie },
    body: JSON.stringify({ code: "growup25", benefit_type: "percent_discount", benefit_value: 25, active: true, applicable_plans: ["business"], applicable_billing: ["monthly"] })
  });
  if (createPromo.status !== 200 || createPromo.json().result.promotion.code !== "GROWUP25") fail(`platform promo create failed: ${createPromo.status} ${createPromo.text}`);
  if (db.platform_admin_audit_log.length !== 1 || db.platform_admin_audit_log[0].actor_user_id !== "u_platform") fail("platform admin write did not append audit log");

  const shell = await request("/platform-admin", { headers: { cookie: platformCookie } });
  if (shell.status !== 200 || !shell.text.includes("app.js")) fail(`platform admin route did not serve app shell: ${shell.status}`);

  console.log("Platform Admin checks passed.");
})().catch(error => {
  console.error(error);
  process.exit(1);
});
