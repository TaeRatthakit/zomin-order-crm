"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { findUserForLogin } = require("./db");
const { authenticateExistingUser } = require("./existing-auth");
const { hashPassword, verifyPassword } = require("./auth");

const PLATFORM_ADMIN_COOKIE = "growup_platform_admin_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const TIME_ZONE = "Asia/Bangkok";
const ROOT = path.join(__dirname, "..");
const JSON_DB_FILE = process.env.JSON_DB_PATH || path.join(ROOT, "data", "db.json");
const PREVIEW_SUPABASE_HOST = "enwabsfsmwwcwwirdwok.supabase.co";
const PRODUCTION_SUPABASE_HOST = "mjnpzdmrqweugdnvlqwq.supabase.co";

const PLATFORM_ADMIN_SOURCE_SELECTS = {
  tenants: "select=id,name,status,metadata,created_at,updated_at",
  tenant_memberships: "select=id,tenant_id,user_id,role,is_active,created_at,updated_at",
  users: "select=id,username,password_hash,name,role,phone,is_active,created_at,updated_at",
  customers: "select=id,tenant_id,created_at",
  orders: "select=id,tenant_id,order_date,created_at,amount",
  line_messages: "select=id,tenant_id,created_at",
  signup_bootstraps: "select=idempotency_key,user_id,tenant_id,status,created_at,updated_at",
  payments: "select=id,tenant_id,subscription_id,status,amount_minor,created_at,paid_at,plan,billing_interval,provider,provider_payment_reference",
  payment_transactions: "select=*",
  subscriptions: "select=id,tenant_id,status,plan,billing_interval,base_amount_minor,amount_due_minor,trial_ends_at,created_at,updated_at",
  tenant_subscriptions: "select=*",
  activity_logs: "select=*",
  user_activity: "select=*",
  system_health_events: "select=*"
};

function isSupabaseMode() {
  const configured = String(process.env.DATABASE_PROVIDER || "").trim().toLowerCase();
  return configured ? ["supabase", "postgres"].includes(configured) : process.env.NODE_ENV === "production";
}

const OPTIONAL_TABLES = [
  "tenants",
  "tenant_memberships",
  "signup_bootstraps",
  "payments",
  "payment_transactions",
  "subscriptions",
  "tenant_subscriptions",
  "activity_logs",
  "user_activity",
  "system_health_events",
  "platform_admin_memberships"
];

const PLATFORM_ADMIN_PROMO_RPCS = new Set([
  "growup_platform_admin_promo_list",
  "growup_platform_admin_promo_audit",
  "growup_platform_admin_save_promotion_code",
  "growup_platform_admin_set_promotion_status"
]);

function sessionSecret() {
  const configured = String(process.env.PLATFORM_ADMIN_SESSION_SECRET || "").trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "preview") throw new Error("PLATFORM_ADMIN_SESSION_SECRET is required");
  return "platform-admin-preview-secret-change-me";
}

function sign(value) {
  return crypto.createHmac("sha256", sessionSecret()).update(value).digest("base64url");
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decode(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "")
    .split(";")
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const index = part.indexOf("=");
      return index === -1
        ? [part, ""]
        : [part.slice(0, index), (() => {
          try { return decodeURIComponent(part.slice(index + 1)); }
          catch { return ""; }
        })()];
    }));
}

function passwordBinding(passwordHash) {
  return passwordHash
    ? crypto.createHmac("sha256", sessionSecret()).update(String(passwordHash)).digest("base64url")
    : "";
}

function createPlatformAdminSession(user) {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = encode({
    sub: String(user.id),
    username: String(user.username),
    role: "super_admin",
    authBinding: passwordBinding(user.passwordHash || user.password_hash),
    exp: Math.floor(exp / 1000),
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomBytes(12).toString("hex")
  });
  const unsigned = `v1.${payload}`;
  return { token: `${unsigned}.${sign(unsigned)}`, expiresAt: exp };
}

function getPlatformAdminSession(req) {
  const token = parseCookies(req)[PLATFORM_ADMIN_COOKIE];
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const unsigned = `${parts[0]}.${parts[1]}`;
  let expected;
  try {
    expected = sign(unsigned);
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2]))) return null;
    const payload = decode(parts[1]);
    if (!payload.exp || payload.exp * 1000 < Date.now() || payload.role !== "super_admin") return null;
    return { token, expiresAt: payload.exp * 1000, userId: String(payload.sub || ""), username: String(payload.username || ""), authBinding: String(payload.authBinding || "") };
  } catch {
    return null;
  }
}

function platformAdminCookie(token, expiresAt) {
  const secure = process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "preview" ? "Secure; " : "";
  return `${PLATFORM_ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; ${secure}Expires=${new Date(expiresAt).toUTCString()}`;
}

function clearPlatformAdminCookie() {
  const secure = process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "preview" ? "Secure; " : "";
  return `${PLATFORM_ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; ${secure}Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

function membershipFromRecord(user, memberships = []) {
  const direct = user.platformAdminMembership || user.platform_admin_membership || {};
  const directRole = String(user.platformAdminRole || user.platform_admin_role || direct.role || "").toLowerCase();
  const directActive = direct.active !== false && direct.is_active !== false;
  if ((user.platformAdmin === true || user.platform_admin === true || directRole === "super_admin") && directActive) {
    return { active: true, role: "super_admin" };
  }
  const membership = memberships.find(item => String(item.user_id || item.userId || "") === String(user.id || ""));
  const membershipActive = membership && membership.active !== false && membership.is_active !== false;
  if (membership && membershipActive && String(membership.role || "").toLowerCase() === "super_admin") {
    return { active: true, role: "super_admin" };
  }
  return null;
}

function publicPlatformAdmin(user) {
  return {
    id: String(user.id || ""),
    username: String(user.username || ""),
    name: String(user.name || ""),
    role: "super_admin"
  };
}

function readRawJsonDb() {
  try {
    return JSON.parse(fs.readFileSync(JSON_DB_FILE, "utf8"));
  } catch {
    return {};
  }
}

function jsonUserForLogin(identifier) {
  const value = String(identifier || "").trim();
  const db = readRawJsonDb();
  return {
    user: (db.users || []).find(item => item.active !== false && (item.username === value || item.id === value)) || null,
    memberships: []
  };
}

function supabaseConfigured() {
  return String(process.env.SUPABASE_URL || "").trim() && String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
}

async function supabaseRows(table, query = "select=*") {
  if (!supabaseConfigured()) throw new Error("Supabase is not configured");
  if (!OPTIONAL_TABLES.includes(table) && !["users", "customers", "orders", "line_messages"].includes(table)) {
    throw new Error("Table is not allowed");
  }
  const base = new URL(process.env.SUPABASE_URL);
  const url = new URL(`${base.origin}/rest/v1/${table}?${query}`);
  const response = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: "application/json"
    }
  });
  if (!response.ok) {
    const error = new Error(`Supabase ${table} unavailable (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function platformAdminPromoRpc(name, payload = {}) {
  if (!PLATFORM_ADMIN_PROMO_RPCS.has(name)) throw new Error("Platform Admin Promo RPC is not allowed");
  if (!supabaseConfigured()) throw new Error("Supabase is not configured");
  const base = new URL(process.env.SUPABASE_URL);
  const response = await fetch(new URL(`${base.origin}/rest/v1/rpc/${name}`), {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let result = null;
  try { result = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    const error = new Error(String(result?.message || result?.hint || `Promo datasource unavailable (${response.status})`));
    error.status = response.status;
    error.code = String(result?.code || "");
    throw error;
  }
  return Array.isArray(result) && result.length === 1 ? result[0] : result;
}

function promoWriteGate(input = {}) {
  const environment = String(input.environment ?? process.env.VERCEL_ENV ?? "").trim().toLowerCase();
  const datasourceUrl = String(input.datasourceUrl ?? process.env.SUPABASE_URL ?? "").trim();
  const userId = String(input.userId ?? "").trim();
  const authorizedIdentity = String(input.authorizedIdentity ?? "").trim();
  let datasourceHost = "";
  try { datasourceHost = new URL(datasourceUrl).hostname.toLowerCase(); } catch {}

  if (!userId || !authorizedIdentity || userId !== authorizedIdentity) {
    return { allowed: false, reason: "identity_denied", environment, datasourceHost };
  }
  if (environment === "preview") {
    const enabled = String(input.previewWriteFlag ?? process.env.PLATFORM_ADMIN_PROMO_WRITES_ENABLED ?? "").trim().toLowerCase() === "true";
    return {
      allowed: enabled && datasourceHost === PREVIEW_SUPABASE_HOST,
      reason: !enabled ? "preview_flag_disabled" : datasourceHost === PREVIEW_SUPABASE_HOST ? "allowed" : "preview_datasource_mismatch",
      environment,
      datasourceHost
    };
  }
  if (environment === "production") {
    const enabled = String(input.productionWriteFlag ?? process.env.PLATFORM_ADMIN_PROMO_PRODUCTION_WRITES_ENABLED ?? "").trim().toLowerCase() === "true";
    return {
      allowed: enabled && datasourceHost === PRODUCTION_SUPABASE_HOST,
      reason: !enabled ? "production_flag_disabled" : datasourceHost === PRODUCTION_SUPABASE_HOST ? "allowed" : "production_datasource_mismatch",
      environment,
      datasourceHost
    };
  }
  return { allowed: false, reason: "environment_denied", environment, datasourceHost };
}

async function assertPlatformAdminPromoWriteAccess(userId) {
  const authorizedIdentity = await resolveAuthorizedIdentity();
  const decision = promoWriteGate({ userId, authorizedIdentity });
  if (!decision.allowed) {
    const error = new Error("PLATFORM_ADMIN_PROMO_WRITE_DENIED");
    error.status = 403;
    error.code = decision.reason;
    throw error;
  }
  return decision;
}

function platformAdminPromoStorageLabel() {
  const environment = String(process.env.VERCEL_ENV || "").trim().toLowerCase();
  let datasourceHost = "";
  try { datasourceHost = new URL(process.env.SUPABASE_URL).hostname.toLowerCase(); } catch {}
  if (environment === "preview" && datasourceHost === PREVIEW_SUPABASE_HOST) return "preview-supabase";
  if (environment === "production" && datasourceHost === PRODUCTION_SUPABASE_HOST) return "production-supabase";
  return "unavailable";
}

function platformAdminPromoWriteStatus(userId) {
  const decision = promoWriteGate({ userId, authorizedIdentity: userId });
  return { enabled: decision.allowed, reason: decision.reason };
}

function promotionTypeForUi(value) {
  return ({
    percent_discount: "percentage",
    fixed_amount_discount: "fixed_thb",
    extra_trial_days: "free_days",
    service_days: "free_days",
    free_months: "free_months"
  })[String(value || "")] || "";
}

function promotionTypeForDatabase(value) {
  return ({
    percentage: "percent_discount",
    fixed_thb: "fixed_amount_discount",
    free_days: "service_days",
    free_months: "free_months"
  })[String(value || "")] || "";
}

function promoDateBoundary(value, endOfDay = false) {
  const date = String(value || "").trim();
  if (!date) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("วันที่ Promo ไม่ถูกต้อง");
  return `${date}T${endOfDay ? "23:59:59.999" : "00:00:00"}+07:00`;
}

function positiveLimit(value, fieldName) {
  const text = String(value ?? "").trim();
  if (!text || text.toLowerCase() === "unlimited") return null;
  const number = Number(text);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${fieldName} ต้องเป็นจำนวนเต็มมากกว่า 0 หรือ Unlimited`);
  return number;
}

function normalizePromoInput(input = {}, existingId = "") {
  const code = String(input.code || "").trim().toUpperCase();
  const benefitType = promotionTypeForDatabase(input.type || input.benefitType || input.benefit_type);
  const benefitValue = Number(input.value ?? input.benefitValue ?? input.benefit_value);
  const plans = Array.isArray(input.plans) ? [...new Set(input.plans.map(value => String(value).trim().toLowerCase()).filter(Boolean))] : ["starter", "business", "enterprise"];
  const noExpiry = input.noExpiry === true || String(input.noExpiry || "").toLowerCase() === "true";
  if (code.length < 2 || code.length > 64 || !/^[A-Z0-9][A-Z0-9_-]*$/.test(code)) throw new Error("Code ต้องมี 2–64 ตัวอักษร และใช้ A-Z, 0-9, _ หรือ -");
  if (!benefitType) throw new Error("ประเภท Promo ไม่ถูกต้อง");
  if (benefitType === "percent_discount" && (!Number.isFinite(benefitValue) || benefitValue <= 0 || benefitValue > 100)) throw new Error("กรุณาระบุส่วนลดมากกว่า 0 และไม่เกิน 100%");
  if (benefitType === "fixed_amount_discount" && (!Number.isFinite(benefitValue) || benefitValue <= 0)) throw new Error("กรุณาระบุจำนวนเงินมากกว่า 0 บาท");
  if (benefitType === "service_days" && (!Number.isFinite(benefitValue) || !Number.isInteger(benefitValue) || benefitValue <= 0)) throw new Error("กรุณาระบุจำนวนวันเป็นจำนวนเต็มอย่างน้อย 1 วัน");
  if (benefitType === "free_months" && (!Number.isFinite(benefitValue) || !Number.isInteger(benefitValue) || benefitValue <= 0)) throw new Error("กรุณาระบุจำนวนเดือนเป็นจำนวนเต็มอย่างน้อย 1 เดือน");
  if (!plans.length || plans.some(plan => !["starter", "business", "enterprise"].includes(plan))) throw new Error("แพ็กเกจที่เลือกไม่ถูกต้อง");
  const startsAt = promoDateBoundary(input.startsAt || input.starts_at, false);
  const endsAt = noExpiry ? null : promoDateBoundary(input.expiresAt || input.endsAt || input.ends_at, true);
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) throw new Error("วันหมดอายุต้องอยู่หลังวันเริ่มต้น");
  return {
    id: String(existingId || input.id || "").trim() || null,
    code,
    description: String(input.description || "").trim().slice(0, 500),
    benefit_type: benefitType,
    benefit_value: benefitValue,
    active: input.active !== false && String(input.active || "").toLowerCase() !== "false",
    starts_at: startsAt,
    ends_at: endsAt,
    max_redemptions: positiveLimit(input.usageLimit ?? input.maxRedemptions ?? input.max_redemptions, "จำนวนใช้รวม"),
    max_redemptions_per_tenant: positiveLimit(input.usagePerCompany ?? input.maxRedemptionsPerTenant ?? input.max_redemptions_per_tenant, "จำนวนใช้ต่อบริษัท"),
    new_customer_only: input.newCustomersOnly === true || String(input.newCustomersOnly || "").toLowerCase() === "true",
    applicable_plans: plans,
    applicable_billing: ["monthly", "yearly"]
  };
}

function promoForUi(row = {}) {
  return {
    id: String(row.id || ""),
    code: String(row.code || ""),
    description: String(row.description || ""),
    type: promotionTypeForUi(row.benefit_type),
    value: Number(row.benefit_value),
    status: String(row.status || (row.active ? "active" : "disabled")),
    active: row.active === true,
    startsAt: row.starts_at || "",
    expiresAt: row.ends_at || "",
    noExpiry: !row.ends_at,
    usageLimit: row.max_redemptions === null || row.max_redemptions === undefined ? null : Number(row.max_redemptions),
    usagePerCompany: row.max_redemptions_per_tenant === null || row.max_redemptions_per_tenant === undefined ? null : Number(row.max_redemptions_per_tenant),
    newCustomersOnly: row.new_customer_only === true,
    plans: Array.isArray(row.applicable_plans) ? row.applicable_plans : [],
    usedCount: Number(row.redemptions || 0),
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || "",
    createdBy: String(row.created_by_user_id || ""),
    updatedBy: String(row.updated_by_user_id || "")
  };
}

async function platformAdminPromoList(userId, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 25, 1), 200);
  const offset = Math.max(Number(options.offset) || 0, 0);
  const result = await platformAdminPromoRpc("growup_platform_admin_promo_list", { p_user_id: String(userId || ""), p_limit: limit, p_offset: offset });
  const promos = Array.isArray(result?.items) ? result.items.map(promoForUi) : [];
  const total = Number(result?.kpis?.total);
  return {
    promos,
    kpis: result?.kpis && typeof result.kpis === "object" ? result.kpis : { active: 0, used: 0, total: 0 },
    pagination: { limit, offset, total: Number.isFinite(total) ? total : null, hasMore: Number.isFinite(total) ? offset + promos.length < total : promos.length === limit }
  };
}

async function platformAdminPromoAudit(userId, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 100);
  const offset = Math.max(Number(options.offset) || 0, 0);
  const result = await platformAdminPromoRpc("growup_platform_admin_promo_audit", { p_user_id: String(userId || ""), p_limit: limit, p_offset: offset });
  const auditLog = Array.isArray(result?.items) ? result.items.map(row => ({
    id: String(row.id || ""),
    action: String(row.action || ""),
    promoId: String(row.target_id || ""),
    code: String(row.code || row.details?.code || ""),
    actor: String(row.actor_username || row.actor_name || row.actor_user_id || "ระบบ"),
    changedFields: Array.isArray(row.details?.changed_fields) ? row.details.changed_fields.map(String) : [],
    at: row.created_at || ""
  })) : [];
  return { auditLog, pagination: { limit, offset, hasMore: auditLog.length === limit } };
}

async function platformAdminSavePromo(userId, input = {}, existingId = "") {
  await assertPlatformAdminPromoWriteAccess(userId);
  const normalized = normalizePromoInput(input, existingId);
  const result = await platformAdminPromoRpc("growup_platform_admin_save_promotion_code", {
    p_user_id: String(userId || ""),
    p_input: normalized
  });
  return promoForUi(result?.promotion || {});
}

async function platformAdminSetPromoActive(userId, promoId, active) {
  await assertPlatformAdminPromoWriteAccess(userId);
  const id = String(promoId || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) throw new Error("Promo ID ไม่ถูกต้อง");
  const result = await platformAdminPromoRpc("growup_platform_admin_set_promotion_status", {
    p_user_id: String(userId || ""),
    p_promotion_id: id,
    p_active: active === true
  });
  return promoForUi(result?.promotion || {});
}

async function supabasePlatformMembershipRows(filter = "") {
  let lastError;
  for (const selection of ["user_id,role,active,is_active", "user_id,role,active", "user_id,role,is_active"]) {
    try {
      return await supabaseRows("platform_admin_memberships", `select=${selection}${filter ? `&${filter}` : ""}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Platform Admin membership source unavailable");
}

async function resolveAuthorizedIdentity() {
  if (isSupabaseMode()) {
    let memberships = [];
    let queryFailed = false;
    try {
      memberships = await supabasePlatformMembershipRows();
    } catch {
      queryFailed = true;
    }
    const activeSuperAdminMemberships = memberships.filter(item => {
      const roleMatches = String(item.role || "").toLowerCase() === "super_admin";
      const activeMatches = (item.active === true || item.is_active === true) && item.active !== false && item.is_active !== false;
      return roleMatches && activeMatches;
    });
    const membershipIds = activeSuperAdminMemberships.map(item => String(item.user_id || "").trim()).filter(Boolean);
    if (queryFailed || activeSuperAdminMemberships.length !== 1 || membershipIds.length !== 1) return null;
    return membershipIds[0];
  }
  const memberships = readRawJsonDb().platform_admin_memberships || readRawJsonDb().platformAdminMemberships || [];
  const activeSuperAdminMemberships = memberships.filter(item => {
    const roleMatches = String(item.role || "").toLowerCase() === "super_admin";
    const activeMatches = (item.active === true || item.is_active === true) && item.active !== false && item.is_active !== false;
    return roleMatches && activeMatches;
  });
  const markedIds = [...new Set(activeSuperAdminMemberships.map(item => String(item.user_id || item.userId || "").trim()).filter(Boolean))];
  return activeSuperAdminMemberships.length === 1 && markedIds.length === 1 ? markedIds[0] : null;
}

async function loadPlatformAdmin(identifier, authenticatedUserOverride = null) {
  const authenticatedUser = authenticatedUserOverride || await Promise.resolve(findUserForLogin(identifier)).catch(() => null);
  if (!authenticatedUser || authenticatedUser.active === false) {
    return null;
  }
  const user = authenticatedUser;
  if (user.is_active === false || user.active === false) {
    return null;
  }
  const normalized = {
    ...authenticatedUser,
    ...user,
    id: user.id,
    username: user.username,
    passwordHash: user.passwordHash || user.password_hash
  };
  const authorizedIdentity = await resolveAuthorizedIdentity();
  if (!authorizedIdentity || String(normalized.id) !== authorizedIdentity) return null;
  return normalized;
}

async function authorizePlatformAdmin(req) {
  const session = getPlatformAdminSession(req);
  if (!session) return null;
  const user = await loadPlatformAdmin(session.username || session.userId);
  if (!user || String(user.id) !== session.userId || !session.authBinding || session.authBinding !== passwordBinding(user.passwordHash || user.password_hash)) {
    return null;
  }
  return publicPlatformAdmin(user);
}

function dateOnlyInBangkok(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.filter(item => item.type !== "literal").map(item => [item.type, item.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function todayBangkok() {
  return dateOnlyInBangkok(new Date());
}

function shiftDate(date, days) {
  const result = new Date(`${date}T12:00:00+07:00`);
  result.setUTCDate(result.getUTCDate() + days);
  return dateOnlyInBangkok(result);
}

function defaultRange() {
  const end = todayBangkok();
  const start = `${end.slice(0, 8)}01`;
  return { start, end };
}

function normalizeRange(query = {}) {
  const fallback = defaultRange();
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(query.start || "")) ? String(query.start) : fallback.start;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(String(query.end || "")) ? String(query.end) : fallback.end;
  return start <= end ? { start, end } : { start: end, end: start };
}

function inRange(value, range) {
  const date = dateOnlyInBangkok(value);
  return Boolean(date && date >= range.start && date <= range.end);
}

function amountOf(row = {}) {
  for (const key of ["amount", "amount_total", "total", "value", "paid_amount", "amountTHB"]) {
    const number = Number(row[key]);
    if (Number.isFinite(number)) return number;
  }
  const minor = Number(row.amount_minor);
  if (Number.isFinite(minor)) return minor / 100;
  return null;
}

function refundAmountOf(row = {}) {
  const major = Number(row.refund_amount);
  if (Number.isFinite(major) && major > 0) return major;
  const minor = Number(row.refund_amount_minor);
  return Number.isFinite(minor) && minor > 0 ? minor / 100 : null;
}

function paymentTimestamp(row = {}) {
  return row.paid_at || row.payment_at || row.transaction_at || row.created_at || row.timestamp || row.date || row.payment_date || "";
}

function paymentStatus(row = {}) {
  return String(row.status || row.payment_status || row.state || "").toLowerCase().trim();
}

function isSuccessfulPayment(row) {
  return ["paid", "succeeded", "success", "successful", "completed", "complete", "ชำระแล้ว"].includes(paymentStatus(row));
}

function isFailedPayment(row) {
  return ["failed", "failure", "payment_failed", "declined", "cancelled", "canceled", "ไม่สำเร็จ"].includes(paymentStatus(row));
}

function isPendingPayment(row) {
  return ["pending", "processing", "requires_action", "รอดำเนินการ"].includes(paymentStatus(row));
}

function isRefund(row) {
  return ["refund", "refunded", "partially_refunded"].includes(paymentStatus(row)) || Boolean(refundAmountOf(row));
}

function stablePaymentKey(row) {
  return String(row.id || row.transaction_id || row.payment_intent_id || row.stripe_payment_intent_id || [row.tenant_id, paymentTimestamp(row), amountOf(row)].join("|") || crypto.createHash("sha1").update(JSON.stringify(row)).digest("hex"));
}

function uniquePayments(rows = []) {
  const seen = new Set();
  return rows.filter(row => {
    const key = stablePaymentKey(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function subscriptionMrrOf(row = {}) {
  const status = String(row.status || "").toLowerCase();
  if (!["active", "trialing", "past_due"].includes(status)) return null;
  const amount = Number.isFinite(Number(row.mrr))
    ? Number(row.mrr)
    : Number.isFinite(Number(row.monthly_amount))
      ? Number(row.monthly_amount)
      : amountOf({ amount: row.amount, amount_minor: row.amount_due_minor ?? row.base_amount_minor });
  if (!Number.isFinite(amount)) return null;
  return /year/i.test(String(row.billing_interval || "")) ? amount / 12 : amount;
}

function normalizeCompany(row = {}, aggregates = {}) {
  const id = String(row.id || row.tenant_id || row.tenantId || "");
  return {
    id,
    name: String(row.name || row.company_name || row.companyName || "—"),
    owner: String(row.owner_name || row.owner || "—"),
    signupDate: dateOnlyInBangkok(row.created_at || row.createdAt || row.signup_date || ""),
    plan: String(row.plan || row.plan_name || "—"),
    subscriptionStatus: String(row.subscription_status || row.subscriptionStatus || row.status || "—"),
    trialEnd: dateOnlyInBangkok(row.trial_end || row.trialEnd || ""),
    userCount: aggregates.userCount ?? null,
    orders: aggregates.orders ?? null,
    lastActive: dateOnlyInBangkok(row.last_active || row.lastActive || ""),
    lineStatus: String(row.line_status || row.lineStatus || "ไม่มีข้อมูล"),
    paymentStatus: String(row.payment_status || row.paymentStatus || "ไม่มีข้อมูล")
  };
}

async function loadSourceData() {
  if (!isSupabaseMode()) {
    const db = readRawJsonDb();
    return {
      provider: "json",
      db,
      tenants: [],
      memberships: [],
      users: db.users || [],
      customers: db.customers || [],
      orders: db.orders || [],
      lineMessages: db.lineMessages || [],
      payments: [],
      subscriptions: [],
      activity: [],
      health: [],
      availability: {
        companies: "legacy local JSON has no tenant/company source",
        payments: "no authoritative payment table is present",
        subscriptions: "no authoritative subscription table is present",
        activity: "no activity/login event source is present",
        health: "no system health event source is present"
      }
    };
  }

  const availability = {};
  const optional = async (table, key) => {
    const preferredQuery = PLATFORM_ADMIN_SOURCE_SELECTS[table] || "select=*";
    try {
      const rows = await supabaseRows(table, preferredQuery);
      availability[key] = "available";
      return rows;
    } catch (error) {
      if (preferredQuery === "select=*") {
        availability[key] = error.message;
        return [];
      }
      try {
        const rows = await supabaseRows(table);
        availability[key] = "available";
        return rows;
      } catch (fallbackError) {
        availability[key] = fallbackError.message;
        return [];
      }
    }
  };
  const [tenants, memberships, users, customers, orders, lineMessages, signupBootstraps] = await Promise.all([
    optional("tenants", "companies"),
    optional("tenant_memberships", "memberships"),
    optional("users", "users"),
    optional("customers", "customers"),
    optional("orders", "orders"),
    optional("line_messages", "lineMessages"),
    optional("signup_bootstraps", "signupBootstraps")
  ]);
  const configuredPaymentTable = String(process.env.PLATFORM_ADMIN_PAYMENT_TABLE || "").trim();
  const configuredSubscriptionTable = String(process.env.PLATFORM_ADMIN_SUBSCRIPTION_TABLE || "").trim();
  const firstAvailable = async (tables, key) => {
    let rows = [];
    for (const table of tables.filter(Boolean)) {
      rows = await optional(table, key);
      if (rows.length || availability[key] === "available") break;
    }
    return rows;
  };
  const [payments, subscriptions, activity, health] = await Promise.all([
    firstAvailable([configuredPaymentTable, "payments", "payment_transactions"], "payments"),
    firstAvailable([configuredSubscriptionTable, "subscriptions", "tenant_subscriptions"], "subscriptions"),
    firstAvailable(["activity_logs", "user_activity"], "activity"),
    optional("system_health_events", "health")
  ]);
  return {
    provider: "supabase",
    tenants,
    memberships,
    users,
    customers,
    orders,
    lineMessages,
    signupBootstraps,
    payments: uniquePayments(payments),
    subscriptions,
    activity,
    health,
    availability
  };
}

function companyRows(source) {
  if (!source.tenants.length) return [];
  const tenantIdOf = row => String(row.tenant_id || row.tenantId || "").trim();
  const metadataOf = tenant => {
    if (!tenant) return {};
    if (typeof tenant.metadata === "object" && !Array.isArray(tenant.metadata)) return tenant.metadata;
    if (typeof tenant.metadata === "string") {
      try {
        const parsed = JSON.parse(tenant.metadata);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      } catch {}
    }
    return {};
  };
  const isNonCustomerTenant = tenant => {
    const metadata = metadataOf(tenant);
    const sourceMarker = String(metadata.source || metadata.origin || metadata.kind || metadata.type || "").trim().toLowerCase();
    const environmentMarker = String(metadata.environment || metadata.env || metadata.mode || "").trim().toLowerCase();
    const searchable = [tenant.name, sourceMarker, environmentMarker, metadata.label, metadata.description]
      .map(value => String(value || "").trim().toLowerCase())
      .join(" ");
    if (metadata.is_test === true || metadata.test === true || metadata.fixture === true || metadata.migration === true || metadata.internal === true || metadata.platform_admin === true) return true;
    if (["test", "fixture", "migration", "development", "dev", "staging", "preview", "internal", "system", "platform_admin", "platform-admin"].includes(sourceMarker)) return true;
    if (["test", "fixture", "migration", "legacy", "development", "dev", "staging", "preview", "internal", "system"].includes(environmentMarker)) return true;
    return /(^|[^a-z])(test|fixture|demo|staging|preview|development|dev|migration|internal|system|qa|codex|gate|phase\d+|e2e)([^a-z]|$)/i.test(searchable)
      || /(^|[^a-z])(usage[ _-]+a|landing[ _-]+qa|fresh[ _-]+customer|platform[ _-]+candidate)([^a-z]|$)/i.test(searchable)
      || /(^|[^a-z])legacy[ _-]+(test|fixture|dev|development|staging)([^a-z]|$)/i.test(searchable);
  };
  const isActiveUser = user => user && user.is_active !== false && user.active !== false;
  const isOwner = value => String(value || "").trim().toLowerCase() === "owner";
  const memberships = Array.isArray(source.memberships) ? source.memberships : [];
  const users = Array.isArray(source.users) ? source.users : [];
  const signupBootstraps = Array.isArray(source.signupBootstraps) ? source.signupBootstraps : [];
  const subscriptions = Array.isArray(source.subscriptions) ? source.subscriptions : [];
  const customers = Array.isArray(source.customers) ? source.customers : [];
  const orders = Array.isArray(source.orders) ? source.orders : [];
  const lineMessages = Array.isArray(source.lineMessages) ? source.lineMessages : [];
  const usersById = new Map(users.map(user => [String(user.id || ""), user]));
  const membershipsByTenant = new Map();
  for (const membership of memberships) {
    const tenantId = tenantIdOf(membership);
    if (!tenantId) continue;
    const rows = membershipsByTenant.get(tenantId) || [];
    rows.push(membership);
    membershipsByTenant.set(tenantId, rows);
  }
  const tenantIdsWithSignupProvenance = new Set(signupBootstraps.map(tenantIdOf).filter(Boolean));
  const tenantIdsWithSubscriptions = new Set(subscriptions.map(tenantIdOf).filter(Boolean));
  const tenantIdsWithCustomers = new Set(customers.map(tenantIdOf).filter(Boolean));
  const tenantIdsWithOrders = new Set(orders.map(tenantIdOf).filter(Boolean));
  const tenantIdsWithLineMessages = new Set(lineMessages.map(tenantIdOf).filter(Boolean));
  const realCustomerTenant = tenant => {
    if (String(tenant.status || "").trim().toLowerCase() !== "active" || isNonCustomerTenant(tenant)) return false;
    const id = String(tenant.id || "").trim();
    const ownerMemberships = (membershipsByTenant.get(id) || []).filter(item => item.is_active !== false && isOwner(item.role));
    const hasActiveOwner = ownerMemberships.some(item => {
      const user = usersById.get(String(item.user_id || item.userId || ""));
      return isActiveUser(user) && isOwner(user.role);
    });
    if (!hasActiveOwner) return false;
    const metadata = metadataOf(tenant);
    const hasPublicSignupSource = String(metadata.source || "").trim().toLowerCase() === "public_signup";
    const hasSignupProvenance = tenantIdsWithSignupProvenance.has(id);
    const hasSubscription = tenantIdsWithSubscriptions.has(id);
    const hasCustomerRecords = tenantIdsWithCustomers.has(id)
      || tenantIdsWithOrders.has(id)
      || tenantIdsWithLineMessages.has(id);
    return hasPublicSignupSource || hasSignupProvenance || hasSubscription || hasCustomerRecords;
  };
  const customerTenants = source.tenants.filter(realCustomerTenant);
  const userCount = new Map();
  for (const membership of memberships) {
    if (membership.is_active === false) continue;
    const tenantId = String(membership.tenant_id || membership.tenantId || "");
    if (tenantId) userCount.set(tenantId, (userCount.get(tenantId) || 0) + 1);
  }
  const orderCount = new Map();
  for (const order of orders) {
    const tenantId = tenantIdOf(order);
    if (tenantId) orderCount.set(tenantId, (orderCount.get(tenantId) || 0) + 1);
  }
  const result = customerTenants.map(tenant => {
    const id = String(tenant.id || "");
    const ownerMembership = (membershipsByTenant.get(id) || []).find(item => isOwner(item.role));
    const owner = usersById.get(String(ownerMembership?.user_id || ownerMembership?.userId || ""));
    const company = normalizeCompany(tenant, {
      userCount: userCount.get(id) || 0,
      orders: orderCount.get(id) || 0
    });
    return { ...company, owner: owner?.name || owner?.username || company.owner };
  });
  return result;
}

function buildSnapshot(source, range) {
  const companies = companyRows(source);
  const today = todayBangkok();
  const rangePayments = [];
  const successful = [];
  const refunds = [];
  let rangeFailedCount = 0;
  let rangePendingCount = 0;
  let allFailedCount = 0;
  for (const row of source.payments) {
    if (isFailedPayment(row)) allFailedCount += 1;
    if (!inRange(paymentTimestamp(row), range)) continue;
    rangePayments.push(row);
    if (isSuccessfulPayment(row)) successful.push(row);
    if (isRefund(row)) refunds.push(row);
    if (isFailedPayment(row)) rangeFailedCount += 1;
    if (isPendingPayment(row)) rangePendingCount += 1;
  }
  const gross = successful.reduce((total, row) => total + (amountOf(row) || 0), 0);
  const refundTotal = refunds.reduce((total, row) => total + (refundAmountOf(row) || amountOf(row) || 0), 0);
  const activeTenantIds = new Set();
  const activeUserIds = new Set();
  for (const row of source.activity) {
    const rowDate = dateOnlyInBangkok(row.occurred_at || row.created_at || row.timestamp || row.date);
    if (rowDate !== today) continue;
    const tenantId = String(row.tenant_id || row.tenantId || "").trim();
    const userId = String(row.user_id || row.userId || "").trim();
    if (tenantId) activeTenantIds.add(tenantId);
    if (userId) activeUserIds.add(userId);
  }
  const activeCompanies = source.activity.length ? activeTenantIds.size : null;
  let ordersToday = null;
  if (source.orders.length) {
    ordersToday = 0;
    for (const row of source.orders) {
      if (dateOnlyInBangkok(row.order_date || row.date || row.created_at) === today) ordersToday += 1;
    }
  }
  const planCounts = { Starter: 0, Business: 0, Enterprise: 0 };
  let activeCompanyCount = 0;
  let trialCompanyCount = 0;
  const inactiveCompanies = [];
  let trialExpiringCount = 0;
  let lineDisconnectedCount = 0;
  const inactiveCutoff = shiftDate(today, -14);
  const trialExpiryLimit = shiftDate(today, 7);
  for (const company of companies) {
    const plan = company.plan.toLowerCase();
    if (plan === "starter") planCounts.Starter += 1;
    if (plan === "business") planCounts.Business += 1;
    if (plan === "enterprise") planCounts.Enterprise += 1;
    const subscriptionStatus = company.subscriptionStatus.toLowerCase();
    if (subscriptionStatus === "active") activeCompanyCount += 1;
    if (subscriptionStatus === "trial") trialCompanyCount += 1;
    if (company.lastActive && inactiveCutoff > company.lastActive) inactiveCompanies.push(company);
    if (company.trialEnd && company.trialEnd >= today && company.trialEnd <= trialExpiryLimit) trialExpiringCount += 1;
    if (/disconnect|ไม่เชื่อม/i.test(company.lineStatus)) lineDisconnectedCount += 1;
  }
  const mrrValues = source.subscriptions.map(subscriptionMrrOf).filter(value => Number.isFinite(value));
  const mrr = mrrValues.length ? mrrValues.reduce((total, value) => total + value, 0) : null;
  const transactions = rangePayments.map(row => ({
    id: String(row.id || row.transaction_id || row.payment_intent_id || "—"),
    company: String(row.company_name || row.tenant_name || row.tenant_id || "—"),
    plan: String(row.plan || row.package || "—"),
    amount: amountOf(row),
    method: String(row.payment_method || row.method || "—"),
    status: String(row.status || row.payment_status || "ไม่มีข้อมูล"),
    timestamp: paymentTimestamp(row)
  }));
  const snapshot = {
    generatedAt: new Date().toISOString(),
    timezone: TIME_ZONE,
    range,
    home: {
      revenue: { today: null, month: null, total: null },
      plans: planCounts,
      payments: { mrr, failed: source.payments.length ? allFailedCount : null, billingToday: null },
      usage: { activeCompanies, ordersToday, inactiveCompanies: companies.length ? inactiveCompanies.length : null },
      companies: { total: companies.length || null, active: activeCompanyCount || null, trial: trialCompanyCount || null },
      health: { line: source.lineMessages.length ? "ควรตรวจสอบ" : "ไม่มีข้อมูล", stripe: source.payments.length ? "ควรตรวจสอบ" : "ไม่มีข้อมูล", supabase: source.provider === "supabase" ? "ควรตรวจสอบ" : "ไม่มีข้อมูล" },
      promos: { active: null, used: null, remaining: null },
      actions: { paymentFailed: source.payments.length ? allFailedCount : null, trialExpiring: trialExpiringCount || null, lineDisconnected: lineDisconnectedCount || null, inactive: companies.length ? inactiveCompanies.length : null }
    },
    revenue: { gross: successful.length ? gross : null, refunds: refunds.length ? refundTotal : null, net: successful.length ? gross - refundTotal : null, successfulPayments: source.payments.length ? successful.length : null, payingCompanies: source.payments.length ? new Set(successful.map(row => String(row.tenant_id || row.tenantId || row.company_id || "").trim()).filter(Boolean)).size : null, mrrSnapshot: mrr, transactions },
    payments: { successful: source.payments.length ? successful.length : null, failed: source.payments.length ? rangeFailedCount : null, pending: source.payments.length ? rangePendingCount : null, refunds: source.payments.length ? refunds.length : null, collected: successful.length ? gross - refundTotal : null, transactions },
    plans: { counts: planCounts, total: companies.length || null, companies },
    usage: { activeCompanies, activeUsers: source.activity.length ? activeUserIds.size : null, loginsToday: null, ordersToday, inactiveCompanies },
    companies,
    health: source.health.slice(-20).reverse().map(row => ({ service: String(row.service || row.name || "ระบบ"), status: String(row.status || "ไม่มีข้อมูล"), checkedAt: row.checked_at || row.created_at || "" })),
    actions: [],
    availability: source.availability
  };
  return snapshot;
}

function assertSameOrigin(req) {
  const origin = String(req.headers.origin || "").trim();
  if (!origin) return true;
  try {
    return new URL(origin).host === String(req.headers.host || "").trim();
  } catch {
    return false;
  }
}

async function platformAdminSnapshot(query = {}) {
  const source = await loadSourceData();
  return buildSnapshot(source, normalizeRange(query));
}

async function platformAdminLoginResult(identifier, password) {
  const authentication = await authenticateExistingUser(identifier, password);
  if (!authentication.user) return null;
  const user = await loadPlatformAdmin(authentication.user.username || identifier, authentication.user);
  if (!user) return null;
  return { user: publicPlatformAdmin(user), session: createPlatformAdminSession(user) };
}

async function platformAdminLogin(identifier, password) {
  const result = await platformAdminLoginResult(identifier, password);
  return result?.session || null;
}

async function changePlatformAdminPassword(userId, currentPassword, newPassword, confirmation) {
  if (!isSupabaseMode() || !supabaseConfigured()) return { ok: false, status: 403, error: "ไม่พบแหล่งข้อมูล Supabase ที่ปลอดภัยสำหรับการเปลี่ยนรหัสผ่าน" };
  let host = "";
  try { host = new URL(process.env.SUPABASE_URL).hostname; } catch {}
  const environment = String(process.env.VERCEL_ENV || "").toLowerCase();
  if (environment === "preview" && host !== PREVIEW_SUPABASE_HOST) return { ok: false, status: 403, error: "แหล่งข้อมูลไม่ใช่ Preview Supabase ที่ได้รับอนุญาต" };
  if (environment === "production" && host !== PRODUCTION_SUPABASE_HOST) return { ok: false, status: 403, error: "แหล่งข้อมูลไม่ใช่ Production Supabase ที่ได้รับอนุญาต" };
  if (!(["preview", "production"].includes(environment))) return { ok: false, status: 403, error: "การเปลี่ยนรหัสผ่านเปิดเฉพาะ environment ที่ได้รับอนุญาต" };
  const id = String(userId || "").trim();
  if (!id || (environment === "production" && id !== "u_admin")) return { ok: false, status: 403, error: "บัญชีนี้ไม่ได้รับอนุญาตให้เปลี่ยนรหัสผ่าน Platform Admin" };
  const nextPassword = String(newPassword || "");
  if (nextPassword !== String(confirmation || "")) {
    return { ok: false, status: 400, error: "รหัสผ่านใหม่และการยืนยันไม่ตรงกัน" };
  }
  if (nextPassword.length < 12) {
    return { ok: false, status: 400, error: "รหัสผ่านใหม่ต้องมีอย่างน้อย 12 ตัวอักษร" };
  }
  const rows = await supabaseRows("users", `select=id,username,password_hash,is_active&id=eq.${encodeURIComponent(id)}&limit=1`);
  const stored = rows[0];
  if (!stored || stored.is_active === false || !verifyPassword(currentPassword, stored.password_hash)) {
    return { ok: false, status: 401, error: "รหัสผ่านปัจจุบันไม่ถูกต้อง" };
  }
  const nextHash = hashPassword(nextPassword);
  if (!verifyPassword(nextPassword, nextHash)) {
    return { ok: false, status: 500, error: "ไม่สามารถยืนยันรหัสผ่านใหม่ในหน่วยความจำได้" };
  }
  const base = new URL(process.env.SUPABASE_URL);
  const url = new URL(`${base.origin}/rest/v1/users?id=eq.${encodeURIComponent(id)}`);
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({ password_hash: nextHash })
  });
  if (!response.ok) return { ok: false, status: 502, error: "ไม่สามารถบันทึกรหัสผ่านใน environment นี้ได้" };
  const after = await supabaseRows("users", `select=id,username,password_hash,is_active&id=eq.${encodeURIComponent(id)}&limit=1`);
  if (!after[0] || !verifyPassword(nextPassword, after[0].password_hash)) {
    return { ok: false, status: 502, error: "ตรวจสอบรหัสผ่านหลังบันทึกไม่สำเร็จ" };
  }
  return { ok: true, userId: String(after[0].id), username: String(after[0].username || "") };
}

module.exports = {
  PLATFORM_ADMIN_COOKIE,
  assertSameOrigin,
  authorizePlatformAdmin,
  clearPlatformAdminCookie,
  createPlatformAdminSession,
  getPlatformAdminSession,
  loadPlatformAdmin,
  normalizeRange,
  platformAdminCookie,
  platformAdminLogin,
  platformAdminLoginResult,
  changePlatformAdminPassword,
  platformAdminSnapshot,
  platformAdminPromoAudit,
  platformAdminPromoList,
  platformAdminPromoStorageLabel,
  platformAdminPromoWriteStatus,
  platformAdminSavePromo,
  platformAdminSetPromoActive,
  normalizePromoInput,
  promoWriteGate,
  publicPlatformAdmin,
  TIME_ZONE
};
