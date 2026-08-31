"use strict";

process.env.NODE_ENV = "test";
process.env.VERCEL_ENV = "preview";
process.env.DATABASE_PROVIDER = "supabase";
process.env.SUPABASE_URL = "https://enwabsfsmwwcwwirdwok.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "preview-test-service-key";
process.env.PLATFORM_ADMIN_SESSION_SECRET = "platform-admin-promo-test-session-secret-32-bytes";
process.env.PLATFORM_ADMIN_PROMO_WRITES_ENABLED = "true";
process.env.AUTH_RATE_LIMIT_MAX = "500";

const crypto = require("crypto");
const { Readable } = require("stream");
const { hashPassword } = require("../lib/auth");

const db = {
  tenants: [{ id: "11111111-1111-4111-8111-111111111111", name: "Preview", status: "active" }],
  users: [
    { id: "u_admin", username: "Nada", password_hash: hashPassword("preview-pass-12345"), name: "Nada", role: "Owner", is_active: true },
    { id: "u_owner", username: "owner", password_hash: hashPassword("owner-pass-12345"), name: "Owner", role: "Owner", is_active: true },
    { id: "u_customer_admin", username: "customer-admin", password_hash: hashPassword("admin-pass-12345"), name: "Admin", role: "Admin", is_active: true },
    { id: "u_staff", username: "staff", password_hash: hashPassword("staff-pass-12345"), name: "Staff", role: "Staff", is_active: true }
  ],
  tenant_memberships: [
    { tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u_admin", role: "Owner", is_active: true },
    { tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u_owner", role: "Owner", is_active: true },
    { tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u_customer_admin", role: "Admin", is_active: true },
    { tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u_staff", role: "Staff", is_active: true }
  ],
  platform_admin_memberships: [{ user_id: "u_admin", role: "super_admin", active: true }],
  promotions: [],
  redemptions: [],
  audit: []
};

function filters(rows, params) {
  let result = [...rows];
  for (const [key, value] of params) {
    if (["select", "limit", "order"].includes(key) || key === "or") continue;
    if (value.startsWith("eq.")) result = result.filter(row => String(row[key]) === decodeURIComponent(value.slice(3)));
  }
  const limit = Number(params.get("limit") || 0);
  return limit ? result.slice(0, limit) : result;
}

function requireSuperAdmin(userId) {
  const active = db.platform_admin_memberships.filter(row => row.active && row.role === "super_admin");
  return active.length === 1 && active[0].user_id === userId && db.users.some(user => user.id === userId && user.is_active);
}

function promoStatus(row) {
  if (!row.active) return "disabled";
  if (row.ends_at && new Date(row.ends_at) < new Date()) return "expired";
  return "active";
}

function rpc(name, payload) {
  if (!requireSuperAdmin(String(payload.p_user_id || ""))) return new Response(JSON.stringify({ message: "PLATFORM_ADMIN_SUPER_ADMIN_REQUIRED" }), { status: 400 });
  if (name === "growup_platform_admin_promo_list") {
    const limit = Math.min(Math.max(Number(payload.p_limit) || 25, 1), 200);
    const offset = Math.max(Number(payload.p_offset) || 0, 0);
    const items = db.promotions.slice(offset, offset + limit);
    return new Response(JSON.stringify({
      role: "super_admin",
      kpis: { active: db.promotions.filter(row => promoStatus(row) === "active").length, used: db.redemptions.length, total: db.promotions.length },
      items: items.map(row => ({ ...row, status: promoStatus(row), redemptions: db.redemptions.filter(redemption => redemption.promotion_code_id === row.id).length }))
    }), { status: 200 });
  }
  if (name === "growup_platform_admin_promo_audit") {
    const limit = Math.min(Math.max(Number(payload.p_limit) || 20, 1), 100);
    const offset = Math.max(Number(payload.p_offset) || 0, 0);
    return new Response(JSON.stringify({ role: "super_admin", items: [...db.audit].reverse().slice(offset, offset + limit) }), { status: 200 });
  }
  if (name === "growup_platform_admin_save_promotion_code") {
    const input = payload.p_input || {};
    const duplicate = db.promotions.find(row => row.code === input.code && row.id !== input.id);
    if (duplicate) return new Response(JSON.stringify({ code: "23505", message: "PROMOTION_CODE_EXISTS" }), { status: 409 });
    let row = db.promotions.find(item => item.id === input.id);
    const action = row ? "promotion_code.update" : "promotion_code.create";
    if (row) Object.assign(row, input, { updated_at: new Date().toISOString(), updated_by_user_id: payload.p_user_id });
    else {
      row = { ...input, id: crypto.randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), created_by_user_id: payload.p_user_id, updated_by_user_id: payload.p_user_id };
      db.promotions.push(row);
    }
    db.audit.push({ id: crypto.randomUUID(), actor_user_id: payload.p_user_id, actor_username: "Nada", action, target_type: "promotion_code", target_id: row.id, code: row.code, details: { code: row.code, changed_fields: ["code"] }, created_at: new Date().toISOString() });
    return new Response(JSON.stringify({ role: "super_admin", promotion: row }), { status: 200 });
  }
  if (name === "growup_platform_admin_set_promotion_status") {
    const row = db.promotions.find(item => item.id === payload.p_promotion_id);
    if (!row) return new Response(JSON.stringify({ message: "PROMOTION_CODE_NOT_FOUND" }), { status: 400 });
    row.active = payload.p_active;
    row.updated_at = new Date().toISOString();
    row.updated_by_user_id = payload.p_user_id;
    db.audit.push({ id: crypto.randomUUID(), actor_user_id: payload.p_user_id, actor_username: "Nada", action: payload.p_active ? "promotion_code.reenable" : "promotion_code.disable", target_type: "promotion_code", target_id: row.id, code: row.code, details: { code: row.code, changed_fields: ["active"] }, created_at: new Date().toISOString() });
    return new Response(JSON.stringify({ role: "super_admin", promotion: row }), { status: 200 });
  }
  return new Response(JSON.stringify({ message: `unknown rpc ${name}` }), { status: 404 });
}

global.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.at(-2) === "rpc") return rpc(parts.at(-1), JSON.parse(options.body || "{}"));
  const table = parts.at(-1);
  if (table === "users") return new Response(JSON.stringify(filters(db.users, url.searchParams)), { status: 200 });
  if (table === "platform_admin_memberships") return new Response(JSON.stringify(filters(db.platform_admin_memberships, url.searchParams)), { status: 200 });
  if (table === "tenants") return new Response(JSON.stringify(filters(db.tenants, url.searchParams)), { status: 200 });
  if (table === "tenant_memberships") return new Response(JSON.stringify(filters(db.tenant_memberships, url.searchParams)), { status: 200 });
  if (["settings", "customers", "orders", "line_messages", "signup_bootstraps", "payments", "subscriptions", "activity_logs", "system_health_events"].includes(table)) return new Response("[]", { status: 200 });
  return new Response(JSON.stringify({ message: `unknown table ${table}` }), { status: 404 });
};

const handler = require("../server");

function request(pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(options.body ? [options.body] : []);
    req.method = options.method || "GET";
    req.url = pathname;
    req.headers = { host: "127.0.0.1", "content-type": "application/json", ...(options.headers || {}) };
    const result = { status: 200, headers: {}, body: "" };
    const res = {
      writeHead(status, headers = {}) { result.status = status; result.headers = headers; },
      end(body = "") { result.body = String(body); resolve({ ...result, json: () => result.body ? JSON.parse(result.body) : {} }); }
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

function cookieOf(response) {
  return Object.entries(response.headers).find(([key]) => key.toLowerCase() === "set-cookie")?.[1] || "";
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  const loggedOut = await request("/api/platform-admin/promos");
  assert(loggedOut.status === 401, `unauthenticated list must be denied, got ${loggedOut.status}`);
  const loggedOutWrite = await request("/api/platform-admin/promos", { method: "POST", body: JSON.stringify({ code: "NOSESSION", type: "percentage", value: 10, noExpiry: true, plans: ["starter"] }) });
  assert(loggedOutWrite.status === 401, `unauthenticated write must be denied, got ${loggedOutWrite.status}`);
  const invalidCookie = await request("/api/platform-admin/promos", { headers: { cookie: "growup_platform_admin_session=invalid" } });
  assert(invalidCookie.status === 401, `invalid session must be denied, got ${invalidCookie.status}`);

  const ownerLogin = await request("/api/platform-admin/login", { method: "POST", body: JSON.stringify({ username: "owner", password: "owner-pass-12345" }) });
  assert(ownerLogin.status === 401, "customer Owner must not receive Platform Admin access");
  const adminLogin = await request("/api/platform-admin/login", { method: "POST", body: JSON.stringify({ username: "customer-admin", password: "admin-pass-12345" }) });
  assert(adminLogin.status === 401, "customer Admin must not receive Platform Admin access");
  const staffLogin = await request("/api/platform-admin/login", { method: "POST", body: JSON.stringify({ username: "staff", password: "staff-pass-12345" }) });
  assert(staffLogin.status === 401, "customer Staff must not receive Platform Admin access");

  const login = await request("/api/platform-admin/login", { method: "POST", body: JSON.stringify({ username: "Nada", password: "preview-pass-12345" }) });
  assert(login.status === 200, `authorized Platform Admin login failed: ${login.status}`);
  const cookie = cookieOf(login);
  assert(cookie.includes("growup_platform_admin_session=") && cookie.includes("HttpOnly") && cookie.includes("SameSite=Lax"), "secure Platform Admin session cookie missing");
  const headers = { cookie, origin: "http://127.0.0.1" };

  const invalidPercent = await request("/api/platform-admin/promos", { method: "POST", headers, body: JSON.stringify({ code: "OVER100", type: "percentage", value: 101, noExpiry: true, plans: ["starter"] }) });
  assert(invalidPercent.status === 400 && invalidPercent.json().error === "กรุณาระบุส่วนลดมากกว่า 0 และไม่เกิน 100%", `percentage >100 must fail clearly, got ${invalidPercent.status}`);
  const invalidFixed = await request("/api/platform-admin/promos", { method: "POST", headers, body: JSON.stringify({ code: "FIXEDZERO", type: "fixed_thb", value: 0, noExpiry: true, plans: ["starter"] }) });
  assert(invalidFixed.status === 400 && invalidFixed.json().error === "กรุณาระบุจำนวนเงินมากกว่า 0 บาท", "fixed THB zero must fail clearly");
  const invalidDays = await request("/api/platform-admin/promos", { method: "POST", headers, body: JSON.stringify({ code: "DAYDECIMAL", type: "free_days", value: 1.5, noExpiry: true, plans: ["starter"] }) });
  assert(invalidDays.status === 400 && invalidDays.json().error === "กรุณาระบุจำนวนวันเป็นจำนวนเต็มอย่างน้อย 1 วัน", "decimal free days must fail clearly");
  const invalidMonths = await request("/api/platform-admin/promos", { method: "POST", headers, body: JSON.stringify({ code: "MONTHDECIMAL", type: "free_months", value: 0.5, noExpiry: true, plans: ["starter"] }) });
  assert(invalidMonths.status === 400 && invalidMonths.json().error === "กรุณาระบุจำนวนเดือนเป็นจำนวนเต็มอย่างน้อย 1 เดือน", "decimal free months must fail clearly");

  const create = await request("/api/platform-admin/promos", { method: "POST", headers, body: JSON.stringify({ code: " preview10 ", description: "Preview only", type: "percentage", value: 10, usageLimit: 2, usagePerCompany: 1, noExpiry: true, newCustomersOnly: true, plans: ["starter", "business"] }) });
  assert(create.status === 201 && create.json().promo.code === "PREVIEW10", `create failed: ${create.status} ${create.body}`);
  const id = create.json().promo.id;

  const duplicate = await request("/api/platform-admin/promos", { method: "POST", headers, body: JSON.stringify({ code: "preview10", type: "fixed_thb", value: 100, noExpiry: true, plans: ["starter"] }) });
  assert(duplicate.status === 409, `duplicate normalized code must fail, got ${duplicate.status}`);

  const edit = await request(`/api/platform-admin/promos/${id}`, { method: "PUT", headers, body: JSON.stringify({ code: "PREVIEW10", description: "Updated", type: "fixed_thb", value: 250, usageLimit: 3, usagePerCompany: 1, noExpiry: true, newCustomersOnly: false, plans: ["business"] }) });
  assert(edit.status === 200 && edit.json().promo.value === 250, `edit failed: ${edit.status}`);

  const disable = await request(`/api/platform-admin/promos/${id}/status`, { method: "PUT", headers, body: JSON.stringify({ active: false }) });
  assert(disable.status === 200 && disable.json().promo.active === false, "disable failed");
  const reenable = await request(`/api/platform-admin/promos/${id}/status`, { method: "PUT", headers, body: JSON.stringify({ active: true }) });
  assert(reenable.status === 200 && reenable.json().promo.active === true, "re-enable failed");

  const firstPage = await request("/api/platform-admin/promos?limit=1&offset=0", { headers });
  assert(firstPage.status === 200 && firstPage.json().pagination.limit === 1 && firstPage.json().promos.length === 1, "server-side Promo pagination failed");
  const emptyPage = await request("/api/platform-admin/promos?limit=1&offset=1", { headers });
  assert(emptyPage.status === 200 && emptyPage.json().promos.length === 0 && emptyPage.json().pagination.hasMore === false, "Promo pagination boundary failed");
  const auditPage = await request("/api/platform-admin/promos/audit?limit=2&offset=0", { headers });
  assert(auditPage.status === 200 && auditPage.json().pagination.limit === 2, "server-side Audit pagination failed");

  const list = await request("/api/platform-admin/promos", { headers });
  assert(list.status === 200 && list.json().storage === "preview-supabase" && list.json().promos.length === 1, "real Promo list failed");
  const audit = await request("/api/platform-admin/promos/audit", { headers });
  assert(audit.status === 200 && audit.json().auditLog.length === 4, "persistent audit list failed");

  const crossOrigin = await request("/api/platform-admin/promos", { method: "POST", headers: { cookie, origin: "https://evil.example" }, body: JSON.stringify({ code: "BLOCKED", type: "percentage", value: 10, noExpiry: true, plans: ["starter"] }) });
  assert(crossOrigin.status === 403, "cross-origin write must be denied");

  process.env.VERCEL_ENV = "production";
  process.env.SUPABASE_URL = "https://mjnpzdmrqweugdnvlqwq.supabase.co";
  process.env.PLATFORM_ADMIN_PROMO_PRODUCTION_WRITES_ENABLED = "true";
  const productionWrite = await request("/api/platform-admin/promos", { method: "POST", headers, body: JSON.stringify({ code: "PRODMOCK", type: "percentage", value: 10, noExpiry: true, plans: ["starter"] }) });
  assert(productionWrite.status === 201, `authorized mocked Production write must pass, got ${productionWrite.status}`);
  const productionList = await request("/api/platform-admin/promos", { headers });
  assert(productionList.status === 200 && productionList.json().storage === "production-supabase", "Production datasource label mismatch");

  process.env.PLATFORM_ADMIN_PROMO_PRODUCTION_WRITES_ENABLED = "false";
  const productionFlagOff = await request("/api/platform-admin/promos", { method: "POST", headers, body: JSON.stringify({ code: "PRODBLOCK1", type: "percentage", value: 10, noExpiry: true, plans: ["starter"] }) });
  assert(productionFlagOff.status === 403, "Production write flag=false must fail closed");
  delete process.env.PLATFORM_ADMIN_PROMO_PRODUCTION_WRITES_ENABLED;
  const productionFlagMissing = await request("/api/platform-admin/promos", { method: "POST", headers, body: JSON.stringify({ code: "PRODBLOCK2", type: "percentage", value: 10, noExpiry: true, plans: ["starter"] }) });
  assert(productionFlagMissing.status === 403, "missing Production write flag must fail closed");

  process.env.PLATFORM_ADMIN_PROMO_PRODUCTION_WRITES_ENABLED = "true";
  process.env.SUPABASE_URL = "https://enwabsfsmwwcwwirdwok.supabase.co";
  const productionPreviewDatasource = await request("/api/platform-admin/promos", { method: "POST", headers, body: JSON.stringify({ code: "PRODBLOCK3", type: "percentage", value: 10, noExpiry: true, plans: ["starter"] }) });
  assert(productionPreviewDatasource.status === 403, "Production with Preview datasource must fail closed");

  process.env.VERCEL_ENV = "preview";
  process.env.SUPABASE_URL = "https://mjnpzdmrqweugdnvlqwq.supabase.co";
  const previewProductionDatasource = await request("/api/platform-admin/promos", { method: "POST", headers, body: JSON.stringify({ code: "PREVIEWBLOCK1", type: "percentage", value: 10, noExpiry: true, plans: ["starter"] }) });
  assert(previewProductionDatasource.status === 403, "Preview with Production datasource must fail closed");

  process.env.SUPABASE_URL = "https://enwabsfsmwwcwwirdwok.supabase.co";
  process.env.PLATFORM_ADMIN_PROMO_WRITES_ENABLED = "false";
  const previewFlagOff = await request("/api/platform-admin/promos", { method: "POST", headers, body: JSON.stringify({ code: "PREVIEWBLOCK2", type: "percentage", value: 10, noExpiry: true, plans: ["starter"] }) });
  assert(previewFlagOff.status === 403, "Preview write flag=false must fail closed");

  process.env.PLATFORM_ADMIN_PROMO_WRITES_ENABLED = "true";
  process.env.VERCEL_ENV = "development";
  const unknownEnvironment = await request("/api/platform-admin/promos", { method: "POST", headers, body: JSON.stringify({ code: "UNKNOWNBLOCK", type: "percentage", value: 10, noExpiry: true, plans: ["starter"] }) });
  assert(unknownEnvironment.status === 403, "unknown environment must fail closed");

  process.env.VERCEL_ENV = "preview";
  const savedMemberships = [...db.platform_admin_memberships];
  db.platform_admin_memberships.push({ user_id: "u_owner", role: "super_admin", active: true });
  const duplicateMembership = await request("/api/platform-admin/promos", { method: "POST", headers, body: JSON.stringify({ code: "DUPMEMBER", type: "percentage", value: 10, noExpiry: true, plans: ["starter"] }) });
  assert(duplicateMembership.status === 401, "multiple active super_admin memberships must invalidate the session");
  db.platform_admin_memberships.splice(0, db.platform_admin_memberships.length);
  const missingMembership = await request("/api/platform-admin/promos", { method: "POST", headers, body: JSON.stringify({ code: "NOMEMBERSHIP", type: "percentage", value: 10, noExpiry: true, plans: ["starter"] }) });
  assert(missingMembership.status === 401, "missing Platform Admin membership must invalidate the session");
  db.platform_admin_memberships.push(...savedMemberships);

  console.log("Platform Admin Preview Promo security/CRUD test passed.");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
