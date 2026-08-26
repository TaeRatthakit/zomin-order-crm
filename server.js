const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("./lib/env").loadEnv();
const {
  provider: dbProvider,
  readDb,
  findUserForLogin,
  readUserById,
  createSignupTenantAccount,
  writeDb,
  deleteUser,
  deleteOrder,
  deleteCustomer,
  getImportJob,
  getActiveImportJob,
  getLatestImportJob,
  previewLatestImportCleanup,
  cleanupImportJob,
  saveImportJob,
  importOrdersBatch,
  verifyCustomerSync,
  persistOrderMutation,
  persistOrderProfitSnapshots,
  createContactLogFast,
  persistUserProfile,
  persistUserThemePreference,
  persistSettingsPatch,
  readSettingsPatch,
  readNotificationReadIds,
  persistNotificationReadIds,
  validatePromotionCode,
  beginSubscriptionPayment,
  beginSubscriptionUpgrade,
  setPaymentProviderReference,
  recordProviderPaymentSuccess,
  recordProviderPaymentStatus,
  recordSubscriptionUpgradeSuccess,
  recordSubscriptionUpgradeStatus,
  activateZeroAmountSubscriptionPayment,
  readPaymentByProviderReference,
  readPendingSubscriptionUpgrades,
  closeTerminalSubscriptionUpgradeAttempt,
  platformAdminOverview,
  platformAdminTenants,
  platformAdminTenantDetail,
  platformAdminPayments,
  platformAdminPromotionCodes,
  platformAdminUpsertPromotionCode,
  withTenantContext,
  resolveTenantForUser,
  resolveTenantForLineWebhook,
  diagnoseLineWebhookTenantRejection,
  uploadProductImageObject,
  productImagePublicBaseUrl,
  verifyPublicProductImageUrl
} = require("./lib/db");
const {
  hashPassword,
  verifyPassword,
  createSession,
  getSession,
  destroySession,
  sessionCookie,
  clearSessionCookie
} = require("./lib/auth");
const { synchronizeCustomers } = require("./lib/customer-sync");
const {
  normalizeAdPlatforms,
  normalizeAdCostRecords,
  marketingPerformance
} = require("./lib/advertising");
const {
  STRIPE_PROVIDER,
  stripePromptPayConfig,
  createPromptPayPaymentIntent,
  retrievePaymentIntent,
  findPaymentIntentByPaymentId,
  verifyStripeWebhookPayload,
  stripePaymentStatus
} = require("./lib/stripe-promptpay");
const { handlePlatformAdminRequest } = require("./lib/platform-admin-http");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const AUTH_RATE_LIMIT_MAX = Number(process.env.AUTH_RATE_LIMIT_MAX || 20);
const KNOWN_PRODUCTION_SUPABASE_REF = "mjnpzdmrqweugdnvlqwq";
const SIGNUP_PLAN_IDS = new Set(["starter", "business", "enterprise"]);
const SIGNUP_BILLING_IDS = new Set(["monthly", "yearly"]);
const PLAN_ENTITLEMENTS = {
  starter: {
    maxUsers: 3,
    features: ["orders", "customers", "dashboard", "import"]
  },
  business: {
    maxUsers: 10,
    features: ["orders", "customers", "dashboard", "import", "reports", "team", "permissions", "marketing"]
  },
  enterprise: {
    maxUsers: null,
    features: ["orders", "customers", "dashboard", "import", "reports", "team", "permissions", "marketing", "priority_support"]
  }
};
const authRateBuckets = new Map();

function sanitizeNotificationIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : [])
    .map(id => String(id || "").trim())
    .filter(id => id && id.length <= 240 && !/[\u0000-\u001f\u007f]/.test(id)))];
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};

const PERMISSION_GROUPS = [
  {
    id: "orders",
    label: "ออเดอร์",
    icon: "clipboard",
    permissions: [
      ["orders.view", "ดูออเดอร์", "ดูรายการออเดอร์ทั้งหมดและรายละเอียดออเดอร์"],
      ["orders.create", "เพิ่มออเดอร์", "สร้างออเดอร์ใหม่"],
      ["orders.edit", "แก้ไขออเดอร์", "แก้ไขข้อมูลออเดอร์"],
      ["orders.delete", "ลบออเดอร์", "ลบออเดอร์"],
      ["orders.status", "เปลี่ยนสถานะออเดอร์", "เปลี่ยนสถานะและข้อมูลจัดส่งของออเดอร์"],
      ["orders.export", "Export ออเดอร์", "ส่งออกรายชื่อออเดอร์"]
    ]
  },
  {
    id: "customers",
    label: "ลูกค้า",
    icon: "users",
    permissions: [
      ["customers.view", "ดูข้อมูลลูกค้า", "ดูข้อมูลลูกค้าทั้งหมด"],
      ["customers.edit", "เพิ่ม / แก้ไขลูกค้า", "เพิ่มหรือแก้ไขข้อมูลลูกค้า"],
      ["customers.delete", "ลบลูกค้า", "ลบข้อมูลลูกค้า"],
      ["customers.export", "Export ลูกค้า", "ส่งออกข้อมูลลูกค้า"],
      ["customers.import", "Import ลูกค้า", "นำเข้าข้อมูลลูกค้า/ออเดอร์"]
    ]
  },
  {
    id: "products",
    label: "สินค้า",
    icon: "box",
    permissions: [
      ["products.view", "ดูสินค้า", "ดูรายการสินค้าและสต็อก"],
      ["products.edit", "เพิ่ม / แก้ไขสินค้า", "เพิ่มหรือแก้ไขสินค้า"],
      ["products.delete", "ลบสินค้า", "ลบหรือเก็บถาวรสินค้า"],
      ["products.stock", "ปรับสต็อกสินค้า", "ปรับจำนวนสต็อกสินค้า"]
    ]
  },
  {
    id: "reports",
    label: "รายงาน & การเงิน",
    icon: "chart",
    permissions: [
      ["reports.sales", "ดูยอดขาย / รายงาน", "ดูยอดขายและรายงานภาพรวม"],
      ["reports.costs", "ดูต้นทุนสินค้า", "ดูต้นทุนสินค้าและค่าใช้จ่าย"],
      ["reports.profit", "ดูกำไร", "ดูกำไรและผลประกอบการ"],
      ["reports.finance", "ดูรายงานการเงิน", "ดูข้อมูลการเงินเชิงลึก"],
      ["reports.export", "Export รายงาน", "ส่งออกรายงาน"]
    ]
  },
  {
    id: "system",
    label: "ระบบ",
    icon: "settings",
    permissions: [
      ["system.users", "จัดการผู้ใช้งาน", "เพิ่ม / ลบ / แก้ไขผู้ใช้งาน"],
      ["system.permissions", "กำหนดสิทธิ์การเข้าถึง", "กำหนดสิทธิ์ผู้ใช้งาน"],
      ["system.business", "ตั้งค่าธุรกิจ", "ตั้งค่าข้อมูลร้าน"],
      ["system.integrations", "ตั้งค่าระบบ / การเชื่อมต่อ", "ตั้งค่าระบบและการเชื่อมต่อ"],
      ["system.danger", "ลบข้อมูลสำคัญ", "ลบข้อมูลหรือสำรอง/กู้คืนข้อมูลสำคัญ"]
    ]
  }
];

const PERMISSION_KEYS = PERMISSION_GROUPS.flatMap(group => group.permissions.map(([key]) => key));
const FULL_PERMISSIONS = Object.fromEntries(PERMISSION_KEYS.map(key => [key, true]));
const RECOMMENDED_ROLE_PERMISSIONS = {
  Admin: {
    "orders.view": true,
    "orders.create": true,
    "orders.edit": true,
    "orders.delete": false,
    "orders.status": true,
    "orders.export": true,
    "customers.view": true,
    "customers.edit": true,
    "customers.delete": false,
    "customers.export": true,
    "customers.import": true,
    "products.view": true,
    "products.edit": true,
    "products.delete": false,
    "products.stock": true,
    "reports.sales": true,
    "reports.costs": true,
    "reports.profit": false,
    "reports.finance": false,
    "reports.export": true,
    "system.users": false,
    "system.permissions": false,
    "system.business": true,
    "system.integrations": true,
    "system.danger": false
  },
  Staff: {
    "orders.view": true,
    "orders.create": true,
    "orders.edit": false,
    "orders.delete": false,
    "orders.status": true,
    "orders.export": false,
    "customers.view": true,
    "customers.edit": false,
    "customers.delete": false,
    "customers.export": false,
    "customers.import": false,
    "products.view": true,
    "products.edit": false,
    "products.delete": false,
    "products.stock": false,
    "reports.sales": false,
    "reports.costs": false,
    "reports.profit": false,
    "reports.finance": false,
    "reports.export": false,
    "system.users": false,
    "system.permissions": false,
    "system.business": false,
    "system.integrations": false,
    "system.danger": false
  }
};

function normalizedRolePermissions(settings = {}) {
  const stored = settings.rolePermissions && typeof settings.rolePermissions === "object"
    ? settings.rolePermissions
    : {};
  return {
    Owner: { ...FULL_PERMISSIONS },
    Admin: { ...RECOMMENDED_ROLE_PERMISSIONS.Admin, ...(stored.Admin || {}) },
    Staff: { ...RECOMMENDED_ROLE_PERMISSIONS.Staff, ...(stored.Staff || {}) }
  };
}

function sanitizeRolePermissions(input = {}) {
  const normalized = normalizedRolePermissions({ rolePermissions: input });
  return {
    Owner: { ...FULL_PERMISSIONS },
    Admin: Object.fromEntries(PERMISSION_KEYS.map(key => [key, Boolean(normalized.Admin[key])])),
    Staff: Object.fromEntries(PERMISSION_KEYS.map(key => [key, Boolean(normalized.Staff[key])]))
  };
}

function permissionPayloadForRole(role, settings = {}) {
  if (role === "Owner") return { ...FULL_PERMISSIONS };
  const matrix = normalizedRolePermissions(settings);
  return { ...(matrix[role] || matrix.Staff) };
}

function json(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

function timingHeaderValue(timings = {}) {
  return Object.entries(timings)
    .filter(([, value]) => Number.isFinite(Number(value)))
    .map(([key, value]) => `${key.replace(/Ms$/, "").toLowerCase()};dur=${Math.max(0, Number(value))}`)
    .join(", ");
}

function timingDebugHeader(value = {}) {
  try {
    return encodeURIComponent(JSON.stringify(value));
  } catch {
    return "";
  }
}

function orderSaveHeaders(timings = {}, detail = {}) {
  return {
    "Server-Timing": timingHeaderValue(timings),
    "X-Order-Save-Timings": timingDebugHeader({ ...timings, detail })
  };
}

function text(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

function staticCacheHeaders(filePath) {
  const ext = path.extname(filePath);
  if (ext === ".html" || path.basename(filePath) === "service-worker.js") {
    return { "Cache-Control": "no-store" };
  }
  if (ext === ".webp") {
    return { "Cache-Control": "public, max-age=31536000, immutable" };
  }
  return { "Cache-Control": "public, max-age=0, must-revalidate" };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 10_000_000) {
        req.destroy();
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      if (!body) return resolve({ _rawBody: "" });
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === "object") {
          Object.defineProperty(parsed, "_rawBody", { value: body, enumerable: false });
        }
        resolve(parsed);
      } catch {
        resolve({ content: body, _rawBody: body });
      }
    });
    req.on("error", reject);
  });
}

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function normalizePhone(value = "") {
  return String(value).replace(/[^\d]/g, "");
}

function toDateOnly(date = new Date()) {
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(d);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const y = values.year;
  const m = values.month;
  const day = values.day;
  return `${y}-${m}-${day}`;
}

function bangkokTime(date = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(date);
}

function addDays(dateOnly, days) {
  if (!dateOnly) return "";
  const d = new Date(`${dateOnly}T00:00:00`);
  d.setDate(d.getDate() + Number(days || 0));
  return toDateOnly(d);
}

function diffDays(fromDateOnly, toDateOnlyValue) {
  if (!fromDateOnly || !toDateOnlyValue) return 0;
  const from = new Date(`${fromDateOnly}T00:00:00`);
  const to = new Date(`${toDateOnlyValue}T00:00:00`);
  return Math.floor((to - from) / 86_400_000);
}

function compareDate(a, b) {
  return String(a || "").localeCompare(String(b || ""));
}

function splitTags(input) {
  if (Array.isArray(input)) return input.map(String).map(t => t.trim()).filter(Boolean);
  return String(input || "")
    .split(/[,\n|/]+/)
    .map(t => t.trim())
    .filter(Boolean);
}

function normalizeImportText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeProductNameForMatching(value) {
  let textValue = normalizeImportText(value);
  if (!textValue) return "";
  const productLabelPattern = /^(?:สินค้า|ชื่อสินค้า|product)\s*[:：-]\s*/i;
  while (productLabelPattern.test(textValue)) {
    textValue = normalizeImportText(textValue.replace(productLabelPattern, ""));
  }
  return textValue;
}

function normalizedProductNameKey(value) {
  return normalizeProductNameForMatching(value).toLocaleLowerCase("th-TH");
}

function normalizeImportDate(value) {
  const textValue = normalizeImportText(value);
  if (!textValue) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(textValue)) return textValue;
  const match = textValue.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (!match) return toDateOnly(textValue);
  const first = Number(match[1]);
  const second = Number(match[2]);
  let year = Number(match[3]);
  if (year < 100) year = year >= 50 ? year + 2500 : year + 2000;
  if (year > 2400) year -= 543;
  const isMonthFirst = first <= 12 && second > 12;
  const day = isMonthFirst ? second : first;
  const month = isMonthFirst ? first : second;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function publicUser(user) {
  const { pin, password, passwordHash, ...safeUser } = user;
  return {
    ...safeUser,
    themePreference: normalizeThemePreference(user.themePreference)
  };
}

function normalizeThemePreference(value) {
  return ["dark", "light", "system"].includes(value) ? value : "system";
}

function sanitizeAvatarDataUrl(value) {
  const textValue = String(value || "").trim();
  if (!textValue) return "";
  if (!/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,/i.test(textValue)) {
    throw new Error("รองรับเฉพาะไฟล์รูปภาพ PNG, JPG, WebP หรือ GIF");
  }
  if (Buffer.byteLength(textValue, "utf8") > 2_500_000) {
    throw new Error("รูปโปรไฟล์มีขนาดใหญ่เกินไป");
  }
  return textValue;
}

function booleanEnv(value, fallback = false) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function effectiveSettings(settings = {}) {
  return {
    ...settings,
    lineChannelId: process.env.LINE_CHANNEL_ID || settings.lineChannelId || "",
    lineChannelSecret: process.env.LINE_CHANNEL_SECRET || settings.lineChannelSecret || "",
    lineChannelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || settings.lineChannelAccessToken || "",
    lineGroupId: process.env.LINE_GROUP_ID || settings.lineGroupId || "",
    openaiApiKey: process.env.OPENAI_API_KEY || settings.openaiApiKey || "",
    openaiModel: process.env.OPENAI_MODEL || settings.openaiModel || "gpt-4.1-mini",
    lineWebhookEnabled: booleanEnv(process.env.LINE_WEBHOOK_ENABLED, Boolean(settings.lineWebhookEnabled))
  };
}

function cleanText(value, fallback = "") {
  const textValue = String(value ?? "").trim();
  if (!textValue || textValue.toLowerCase() === "undefined" || textValue.toLowerCase() === "null") return fallback;
  return textValue;
}

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket?.remoteAddress || "local";
}

function rateLimitKey(req, scope, identity = "") {
  return `${scope}:${clientIp(req)}:${String(identity || "").toLowerCase()}`;
}

function checkAuthRateLimit(req, scope, identity = "") {
  const key = rateLimitKey(req, scope, identity);
  const now = Date.now();
  const bucket = authRateBuckets.get(key) || { count: 0, resetAt: now + AUTH_RATE_LIMIT_WINDOW_MS };
  if (bucket.resetAt <= now) {
    bucket.count = 0;
    bucket.resetAt = now + AUTH_RATE_LIMIT_WINDOW_MS;
  }
  bucket.count += 1;
  authRateBuckets.set(key, bucket);
  if (bucket.count <= AUTH_RATE_LIMIT_MAX) return null;
  return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
}

function normalizeSignupUsername(value = "") {
  return String(value || "").trim().toLowerCase();
}

function isValidSignupUsername(value = "") {
  const username = normalizeSignupUsername(value);
  if (username.length < 3 || username.length > 120) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username) || /^[a-z0-9._-]{3,60}$/.test(username);
}

function signupDefaults(businessName) {
  return {
    settings: {
      businessName,
      defaultJarPrice: 750,
      vipThresholds: { vip: 5000, vvip: 10000, superVip: 20000 },
      messageTemplates: {
        normal: "สวัสดีค่ะ {{name}} จาก {{businessName}} นะคะ ถึงรอบดูแลต่อเนื่องแล้ว ต้องการให้จัดส่งเพิ่มไหมคะ",
        vip: "สวัสดีค่ะ {{name}} จาก {{businessName}} นะคะ ทีมงานเตรียมโปรพิเศษสำหรับลูกค้า VIP ไว้ให้ค่ะ"
      },
      lineChannelId: "",
      lineChannelSecret: "",
      lineChannelAccessToken: "",
      lineWebhookEnabled: false,
      staffCanExport: false,
      products: [],
      productCosts: [],
      additionalCosts: [],
      rolePermissions: sanitizeRolePermissions({})
    },
    followUpRules: [
      { jars: 1, days: 15 },
      { jars: 2, days: 30 },
      { jars: 3, days: 45 },
      { jars: 6, days: 90 },
      { jars: 13, days: 180 },
      { jars: 30, days: 365 }
    ]
  };
}

function validateSignupBody(body = {}) {
  const username = normalizeSignupUsername(body.username || body.email || body.userId);
  const password = String(body.password || "");
  const businessName = cleanText(body.businessName, "").slice(0, 120);
  const displayName = cleanText(body.name || body.displayName, "") || businessName || username;
  const idempotencyKey = String(body.idempotencyKey || body.signupRequestId || crypto.randomUUID()).trim();
  const rawSelectedPlan = firstPresentSignupValue(body, ["landingSelectedPlan", "selectedPlan", "plan"]);
  const rawSelectedBilling = firstPresentSignupValue(body, ["landingSelectedBilling", "selectedBilling", "billing"]);
  const selectedPlan = rawSelectedPlan ? normalizeSignupPlan(rawSelectedPlan) : "starter";
  const selectedBilling = rawSelectedBilling ? normalizeSignupBilling(rawSelectedBilling) : "monthly";
  const promotionCode = normalizePromotionCodeInput(body.promotionCode || body.promoCode || "");
  if (!isValidSignupUsername(username)) return { error: "กรุณากรอกอีเมลหรือชื่อผู้ใช้งานให้ถูกต้อง" };
  if (password.length < 8 || password.length > 128) return { error: "รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร" };
  if (!businessName || businessName.length < 2) return { error: "กรุณากรอกชื่อธุรกิจ" };
  if (!idempotencyKey || idempotencyKey.length > 120 || /[\u0000-\u001f\u007f]/.test(idempotencyKey)) {
    return { error: "คำขอสมัครไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง" };
  }
  if (rawSelectedPlan && !selectedPlan) {
    return { error: "แพ็กเกจที่เลือกไม่ถูกต้อง", code: "INVALID_SIGNUP_PLAN" };
  }
  if (rawSelectedBilling && !selectedBilling) {
    return { error: "รอบบิลที่เลือกไม่ถูกต้อง", code: "INVALID_SIGNUP_BILLING" };
  }
  return { username, password, businessName, displayName, idempotencyKey, selectedPlan, selectedBilling, promotionCode };
}

function firstPresentSignupValue(body = {}, keys = []) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const value = String(body[key] || "").trim();
    if (value) return value;
  }
  return "";
}

function normalizeSignupPlan(value = "") {
  const plan = String(value || "").trim().toLowerCase();
  return SIGNUP_PLAN_IDS.has(plan) ? plan : "";
}

function normalizeSignupBilling(value = "") {
  const billing = String(value || "").trim().toLowerCase();
  return SIGNUP_BILLING_IDS.has(billing) ? billing : "";
}

function normalizePromotionCodeInput(value = "") {
  return String(value || "").trim().slice(0, 64);
}

function safePromotionError(code = "") {
  if (code === "PROMOTION_CODE_EXPIRED") return "โค้ดโปรโมชั่นนี้หมดอายุแล้ว";
  if (code === "PROMOTION_CODE_EXHAUSTED") return "โค้ดโปรโมชั่นนี้ถูกใช้ครบจำนวนแล้ว";
  return "โค้ดโปรโมชั่นไม่ถูกต้องหรือไม่สามารถใช้กับแพ็กเกจนี้ได้";
}

function runtimeSupabaseInfo() {
  const rawUrl = process.env.SUPABASE_URL || "";
  let host = "";
  let ref = "";
  try {
    host = new URL(rawUrl).host;
    ref = host.split(".")[0] || "";
  } catch {}
  return {
    provider: dbProvider,
    vercelEnv: process.env.VERCEL_ENV || "",
    supabaseHost: host,
    supabaseRef: ref,
    isKnownProductionSupabase: ref === KNOWN_PRODUCTION_SUPABASE_REF,
    payment: safePaymentRuntimeInfo()
  };
}

function normalizedSubscription(subscription = null) {
  if (!subscription) return null;
  return {
    id: subscription.id || "",
    tenantId: subscription.tenantId || subscription.tenant_id || "",
    plan: String(subscription.plan || "starter").toLowerCase(),
    billingInterval: String(subscription.billingInterval || subscription.billing_interval || "monthly").toLowerCase(),
    status: String(subscription.status || "").toLowerCase(),
    currency: subscription.currency || "THB",
    baseAmountMinor: Number(subscription.baseAmountMinor ?? subscription.base_amount_minor ?? 0),
    discountAmountMinor: Number(subscription.discountAmountMinor ?? subscription.discount_amount_minor ?? 0),
    amountDueMinor: Number(subscription.amountDueMinor ?? subscription.amount_due_minor ?? 0),
    trialEndsAt: subscription.trialEndsAt || subscription.trial_ends_at || "",
    currentPeriodEndsAt: subscription.currentPeriodEndsAt || subscription.current_period_ends_at || "",
    nextRenewalAt: subscription.nextRenewalAt || subscription.next_renewal_at || "",
    paymentDueAt: subscription.paymentDueAt || subscription.payment_due_at || "",
    promotionCode: subscription.promotionCode || subscription.promotion_code || "",
    promotionBenefitDescription: subscription.promotionBenefitDescription || subscription.promotion_benefit_description || "",
    createdAt: subscription.createdAt || subscription.created_at || "",
    updatedAt: subscription.updatedAt || subscription.updated_at || ""
  };
}

function currentSubscription(db = {}) {
  return normalizedSubscription((db.subscriptions || []).find(item => item.isInitial !== false && item.is_initial !== false) || (db.subscriptions || [])[0] || null);
}

function planEntitlement(plan = "starter") {
  const key = String(plan || "starter").toLowerCase();
  return PLAN_ENTITLEMENTS[key] || PLAN_ENTITLEMENTS.starter;
}

function activeTenantUserCount(db = {}) {
  return (db.users || []).filter(user => user.active !== false).length;
}

function subscriptionAccess(subscription = null, now = new Date()) {
  if (!subscription) return { allowed: true, reason: "legacy_no_subscription", requiresPayment: false };
  const status = String(subscription.status || "").toLowerCase();
  const trialEnds = subscription.trialEndsAt ? new Date(subscription.trialEndsAt).getTime() : 0;
  const periodEnds = subscription.currentPeriodEndsAt ? new Date(subscription.currentPeriodEndsAt).getTime() : 0;
  const nowMs = now.getTime();
  if (status === "active" && (!periodEnds || periodEnds >= nowMs)) return { allowed: true, reason: "active", requiresPayment: false };
  if (status === "trialing" && trialEnds && trialEnds >= nowMs) return { allowed: true, reason: "trialing", requiresPayment: false };
  return {
    allowed: false,
    reason: status === "pending_payment" ? "pending_payment" : (status || "subscription_inactive"),
    requiresPayment: true
  };
}

function publicPayment(payment = {}) {
  const providerMetadata = payment.providerMetadata || payment.provider_metadata || {};
  const operation = payment.operation || payment.checkout_metadata?.operation || "";
  const lastProviderStatus = String(providerMetadata.last_provider_status || "").toLowerCase();
  const observedProviderStatus = String(providerMetadata.stripe_status || "").toLowerCase();
  const localStatus = String(payment.status || "").toLowerCase();
  // A generic/local paid flag is not payment proof for subscription upgrades.
  // The upgrade success RPC records last_provider_status=succeeded only after
  // the verified webhook atomically activates the target subscription.
  const providerStatus = lastProviderStatus
    || (localStatus === "paid" ? (observedProviderStatus && observedProviderStatus !== "succeeded" ? observedProviderStatus : "pending") : observedProviderStatus)
    || localStatus;
  const verifiedSuccess = operation === "subscription_upgrade"
    ? localStatus === "paid" && lastProviderStatus === "succeeded" && Boolean(payment.paidAt || payment.paid_at)
    : localStatus === "paid" && (lastProviderStatus === "succeeded" || observedProviderStatus === "succeeded");
  return {
    id: payment.id || "",
    subscriptionId: payment.subscriptionId || payment.subscription_id || "",
    provider: payment.provider || "",
    status: payment.status || "",
    providerStatus,
    verifiedSuccess,
    currency: payment.currency || "THB",
    amountMinor: Number(payment.amountMinor ?? payment.amount_minor ?? 0),
    plan: payment.plan || "",
    currentPlan: payment.currentPlan || payment.current_plan || "",
    targetPlan: payment.targetPlan || payment.target_plan || payment.plan || "",
    operation,
    billingInterval: payment.billingInterval || payment.billing_interval || "",
    billingPeriodStartedAt: payment.billingPeriodStartedAt || payment.billing_period_started_at || "",
    billingPeriodEndsAt: payment.billingPeriodEndsAt || payment.billing_period_ends_at || "",
    paidAt: payment.paidAt || payment.paid_at || "",
    failedAt: payment.failedAt || payment.failed_at || "",
    expiredAt: payment.expiredAt || payment.expired_at || "",
    createdAt: payment.createdAt || payment.created_at || ""
  };
}

const RESUMABLE_UPGRADE_PAYMENT_STATUSES = new Set([
  "pending",
  "processing",
  "requires_action",
  "requires_payment_method",
  "requires_confirmation",
  "requires_capture",
  "open",
  "awaiting_payment"
]);

function pendingUpgradePaymentFor(db = {}, currentUser = {}, pendingUpgrades = []) {
  const tenantId = String(currentUser.tenantId || "");
  const payments = (db.payments || [])
    .filter(payment => String(payment.tenantId || payment.tenant_id || tenantId) === tenantId);
  const paymentById = new Map(payments.map(payment => [String(payment.id || ""), payment]));
  const attempts = (pendingUpgrades || [])
    .filter(attempt => String(attempt.tenantId || "") === tenantId)
    .filter(attempt => ["pending", "processing"].includes(String(attempt.status || "").toLowerCase()));
  const candidates = attempts.map(attempt => ({
    attempt,
    payment: paymentById.get(String(attempt.paymentId || "")) || null
  }));
  const upgradePayments = payments.filter(payment => {
    if (!RESUMABLE_UPGRADE_PAYMENT_STATUSES.has(String(payment.status || "").toLowerCase())) return false;
    const metadata = payment.checkoutMetadata || payment.checkout_metadata || {};
    const operation = String(payment.operation || metadata.operation || "").toLowerCase();
    return operation === "subscription_upgrade"
      || Boolean(payment.targetPlan || payment.target_plan || metadata.target_plan);
  });
  candidates.push(...upgradePayments.map(payment => ({
    attempt: attempts.find(item => String(item.paymentId || "") === String(payment.id || "")) || null,
    payment
  })));
  return candidates.find(candidate => candidate.payment || candidate.attempt) || null;
}

const MAX_SUBSCRIPTION_QR_PROXY_BYTES = 1024 * 1024;

function stripeQrImageSource(promptpay = {}) {
  const qr = promptpay.promptpay || promptpay.qr || promptpay;
  return String(
    qr.imageUrlPng
      || qr.image_url_png
      || qr.imageUrlSvg
      || qr.image_url_svg
      || qr.pngUrl
      || qr.svgUrl
      || promptpay.qr?.pngUrl
      || promptpay.qr?.svgUrl
      || ""
  ).trim();
}

function stripeQrHostedInstructions(promptpay = {}) {
  const qr = promptpay.promptpay || promptpay.qr || promptpay;
  return String(qr.hostedInstructionsUrl || qr.hosted_instructions_url || "").trim();
}

function stripeQrImageContentType(source = "", upstreamContentType = "") {
  const contentType = String(upstreamContentType || "").split(";")[0].trim().toLowerCase();
  if (contentType === "image/png" || contentType === "image/svg+xml") return contentType;
  if (/\.svg(?:$|[?#])/i.test(source)) return "image/svg+xml";
  if (/\.png(?:$|[?#])/i.test(source)) return "image/png";
  return "";
}

function stripeQrDataUri(source = "") {
  const match = String(source || "").match(/^data:(image\/(?:png|svg\+xml));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) return null;
  return {
    contentType: match[1].toLowerCase() === "image/svg+xml" ? "image/svg+xml" : "image/png",
    bytes: Buffer.from(match[2].replace(/\s+/g, ""), "base64")
  };
}

async function serveSubscriptionQrImage(req, res, db, currentUser) {
  if (currentUser.role !== "Owner") {
    return json(res, 403, { ok: false, code: "UPGRADE_OWNER_REQUIRED", error: "ต้องใช้สิทธิ์ Owner เพื่อดู QR Code" });
  }
  let pendingUpgradeAttempts = [];
  try {
    pendingUpgradeAttempts = await readPendingSubscriptionUpgrades(currentUser.tenantId);
  } catch {
    pendingUpgradeAttempts = [];
  }
  const pendingCandidate = pendingUpgradePaymentFor(db, currentUser, pendingUpgradeAttempts);
  const pendingPayment = pendingCandidate?.payment || {};
  let paymentReference = String(
    pendingPayment.providerPaymentReference
      || pendingPayment.provider_payment_reference
      || pendingCandidate?.attempt?.providerPaymentReference
      || pendingCandidate?.attempt?.provider_payment_reference
      || ""
  ).trim();
  let recoveredPromptpay = null;
  try {
    if (!paymentReference) {
      const recovered = await recoverPendingUpgradePaymentReference(pendingPayment, currentUser);
      if (recovered) {
        recoveredPromptpay = recovered.promptpay;
        paymentReference = recovered.payment.providerPaymentReference;
      }
    }
    if (!paymentReference) {
      return json(res, 404, { ok: false, code: "QR_NOT_AVAILABLE", error: "ยังไม่มี QR Code สำหรับรายการนี้" });
    }
    const promptpay = recoveredPromptpay || await retrievePaymentIntent(paymentReference);
    const source = stripeQrImageSource(promptpay);
    if (!source) {
      return json(res, 404, { ok: false, code: "QR_NOT_AVAILABLE", error: "Stripe ยังไม่ส่ง QR Code สำหรับรายการนี้" });
    }

    const dataUri = stripeQrDataUri(source);
    if (dataUri) {
      if (!dataUri.bytes.length || dataUri.bytes.length > MAX_SUBSCRIPTION_QR_PROXY_BYTES) {
        return json(res, 502, { ok: false, code: "QR_IMAGE_INVALID", error: "ไม่สามารถโหลด QR Code ได้" });
      }
      res.writeHead(200, {
        "Content-Type": dataUri.contentType,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff"
      });
      return res.end(dataUri.bytes);
    }

    const sourceUrl = new URL(source);
    const trustedHost = sourceUrl.protocol === "https:"
      && (sourceUrl.hostname === "stripe.com" || sourceUrl.hostname.endsWith(".stripe.com"));
    if (!trustedHost) {
      return json(res, 502, { ok: false, code: "QR_SOURCE_INVALID", error: "ไม่สามารถโหลด QR Code ได้" });
    }
    const upstream = await fetch(sourceUrl, { method: "GET", redirect: "error" });
    if (!upstream.ok) {
      return json(res, 502, { ok: false, code: "QR_SOURCE_UNAVAILABLE", error: "ไม่สามารถโหลด QR Code ได้" });
    }
    const contentType = stripeQrImageContentType(source, upstream.headers.get("content-type"));
    if (!contentType) {
      return json(res, 502, { ok: false, code: "QR_IMAGE_TYPE_INVALID", error: "ไม่สามารถโหลด QR Code ได้" });
    }
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_SUBSCRIPTION_QR_PROXY_BYTES) {
      return json(res, 502, { ok: false, code: "QR_IMAGE_INVALID", error: "ไม่สามารถโหลด QR Code ได้" });
    }
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff"
    });
    return res.end(bytes);
  } catch (error) {
    console.warn("Subscription QR retrieval failed", JSON.stringify({
      code: error.code || "QR_RETRIEVAL_FAILED",
      status: error.status || 0
    }));
    return json(res, 502, { ok: false, code: "QR_RETRIEVAL_FAILED", error: "ไม่สามารถโหลด QR Code ได้" });
  }
}

function upgradePaymentView({ payment = {}, attempt = null, currentPlan = "", targetPlan = "" } = {}) {
  const metadata = payment.checkoutMetadata || payment.checkout_metadata || {};
  const providerPaymentReference = String(
    payment.providerPaymentReference
      || payment.provider_payment_reference
      || attempt?.providerPaymentReference
      || ""
  );
  const normalizedTarget = String(targetPlan || payment.targetPlan || payment.target_plan || payment.plan || attempt?.targetPlan || "").toLowerCase();
  const normalizedCurrent = String(currentPlan || payment.currentPlan || payment.current_plan || attempt?.currentPlan || "").toLowerCase();
  return {
    id: payment.id || attempt?.paymentId || "",
    tenantId: payment.tenantId || payment.tenant_id || attempt?.tenantId || "",
    subscriptionId: payment.subscriptionId || payment.subscription_id || attempt?.subscriptionId || "",
    provider: payment.provider || attempt?.provider || STRIPE_PROVIDER,
    status: payment.status || attempt?.status || "pending",
    currency: payment.currency || attempt?.currency || "THB",
    amountMinor: Number(payment.amountMinor ?? payment.amount_minor ?? attempt?.amountMinor ?? 0),
    plan: normalizedTarget,
    currentPlan: normalizedCurrent || String(metadata.current_plan || "").toLowerCase(),
    targetPlan: normalizedTarget || String(metadata.target_plan || "").toLowerCase(),
    operation: "subscription_upgrade",
    billingInterval: payment.billingInterval || payment.billing_interval || attempt?.billingInterval || "monthly",
    idempotencyKey: payment.idempotencyKey || payment.idempotency_key || attempt?.idempotencyKey || "",
    providerPaymentReference,
    billingPeriodStartedAt: payment.billingPeriodStartedAt || payment.billing_period_started_at || attempt?.billingPeriodStartedAt || "",
    billingPeriodEndsAt: payment.billingPeriodEndsAt || payment.billing_period_ends_at || attempt?.billingPeriodEndsAt || "",
    createdAt: payment.createdAt || payment.created_at || attempt?.createdAt || ""
  };
}

function upgradeViewFromPayment(payment, upgradePayment) {
  return {
    id: payment.id || payment.upgradeId || "",
    upgradeId: payment.id || payment.upgradeId || "",
    paymentId: upgradePayment.id,
    tenantId: upgradePayment.tenantId,
    subscriptionId: upgradePayment.subscriptionId,
    currentPlan: upgradePayment.currentPlan,
    targetPlan: upgradePayment.targetPlan,
    provider: upgradePayment.provider,
    status: upgradePayment.status,
    currency: upgradePayment.currency,
    amountMinor: upgradePayment.amountMinor,
    billingInterval: upgradePayment.billingInterval,
    idempotencyKey: upgradePayment.idempotencyKey,
    providerPaymentReference: upgradePayment.providerPaymentReference,
    billingPeriodStartedAt: upgradePayment.billingPeriodStartedAt,
    billingPeriodEndsAt: upgradePayment.billingPeriodEndsAt,
    createdAt: upgradePayment.createdAt
  };
}

async function recoverPendingUpgradePaymentReference(payment, currentUser) {
  const paymentReference = String(
    payment?.providerPaymentReference
      || payment?.provider_payment_reference
      || ""
  ).trim();
  if (paymentReference || !payment?.id || typeof findPaymentIntentByPaymentId !== "function") return null;

  const promptpay = await findPaymentIntentByPaymentId(payment.id);
  if (!promptpay || !["pending", "processing"].includes(String(promptpay.localStatus || "").toLowerCase())) return null;
  if (typeof setPaymentProviderReference !== "function") {
    const error = new Error("STRIPE_PAYMENT_RPC_REQUIRED");
    error.code = "STRIPE_PAYMENT_RPC_REQUIRED";
    throw error;
  }

  const nextPayment = await setPaymentProviderReference({
    paymentId: payment.id,
    tenantId: currentUser.tenantId,
    provider: STRIPE_PROVIDER,
    providerPaymentReference: promptpay.paymentIntentId,
    status: promptpay.status === "processing" ? "processing" : "pending",
    providerMetadata: {
      stripe_status: promptpay.status,
      promptpay_has_qr: Boolean(stripeQrImageSource(promptpay)),
      hosted_instructions_url: stripeQrHostedInstructions(promptpay),
      operation: "subscription_upgrade",
      recovery: "stripe_metadata_lookup"
    }
  });
  if (!nextPayment?.providerPaymentReference) {
    const error = new Error("STRIPE_PAYMENT_REFERENCE_PERSIST_FAILED");
    error.code = "STRIPE_PAYMENT_REFERENCE_PERSIST_FAILED";
    throw error;
  }
  return {
    promptpay,
    payment: { ...payment, ...nextPayment }
  };
}

async function reconcileResumablePayment(payment, attempt, promptpay, currentUser) {
  const providerStatus = String(promptpay.status || "").toLowerCase();
  const localStatus = String(promptpay.localStatus || "pending").toLowerCase();
  const storedPaymentStatus = String(payment?.status || "").toLowerCase();
  const eventId = `resume-${String(payment.id || attempt?.paymentId || "payment")}-${providerStatus || localStatus}`.slice(0, 160);
  // A checkout resume is read-only. Only a verified Stripe webhook may
  // activate a subscription, even when a retrieved PaymentIntent is already
  // succeeded. This keeps resume separate from success reconciliation.
  if (localStatus === "paid") {
    return "paid";
  }
  // A terminal local payment is historical evidence, not a resumable attempt.
  // Do not send a second status event for it: the status RPC intentionally
  // rejects rows that are no longer pending/processing. The caller will fall
  // through to the normal upgrade RPC, which creates a fresh idempotent
  // payment attempt without mutating the terminal row.
  if (["failed", "cancelled", "expired", "paid"].includes(storedPaymentStatus)) {
    return storedPaymentStatus;
  }
  if (!["failed", "cancelled", "expired"].includes(localStatus)) return localStatus;
  const input = {
    provider: STRIPE_PROVIDER,
    providerEventId: eventId,
    paymentId: payment.id || attempt?.paymentId,
    providerPaymentReference: promptpay.paymentIntentId,
    amountMinor: promptpay.amountMinor,
    currency: promptpay.currency,
    status: localStatus,
    rawEvent: { source: "subscription_upgrade_resume", stripeStatus: promptpay.status }
  };
  if (attempt && typeof recordSubscriptionUpgradeStatus === "function") await recordSubscriptionUpgradeStatus(input);
  else if (typeof recordProviderPaymentStatus === "function") await recordProviderPaymentStatus(input);
  return localStatus;
}

function paymentProviderConfig() {
  const provider = String(process.env.PAYMENT_PROVIDER || "").trim().toLowerCase();
  const enabled = booleanEnv(process.env.PAYMENT_PROVIDER_ENABLED, false);
  if (enabled && ["stripe", "stripe_promptpay", "promptpay"].includes(provider)) {
    const stripe = stripePromptPayConfig();
    return {
      configured: stripe.checkoutConfigured && stripe.modeConfigured,
      provider: STRIPE_PROVIDER,
      stripe
    };
  }
  const configured = enabled && provider && !["none", "off", "disabled", "provider_required"].includes(provider);
  return {
    configured,
    provider: configured ? provider : "provider_required",
    stripe: stripePromptPayConfig()
  };
}

function safePaymentRuntimeInfo() {
  const config = paymentProviderConfig();
  return {
    provider: config.provider,
    configured: Boolean(config.configured),
    stripe: {
      mode: config.stripe?.mode || "test",
      testMode: Boolean(config.stripe?.testMode),
      liveMode: Boolean(config.stripe?.liveMode),
      modeConfigured: Boolean(config.stripe?.modeConfigured),
      checkoutConfigured: Boolean(config.stripe?.checkoutConfigured),
      webhookConfigured: Boolean(config.stripe?.webhookConfigured),
      secretKeyConfigured: Boolean(config.stripe?.secretKeyConfigured),
      publishableKeyConfigured: Boolean(config.stripe?.publishableKeyConfigured)
    }
  };
}

function subscriptionBillingPayload(db = {}) {
  const subscription = currentSubscription(db);
  const latestPayments = (db.payments || [])
    .map(publicPayment)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, 10);
  return {
    subscription,
    access: subscriptionAccess(subscription),
    entitlement: planEntitlement(subscription?.plan),
    activeUsers: activeTenantUserCount(db),
    latestPayments,
    paymentProvider: {
      ...safePaymentRuntimeInfo()
    }
  };
}

function requestOrigin(req) {
  const proto = req.headers["x-forwarded-proto"] || (process.env.VERCEL_URL ? "https" : "http");
  const host = req.headers["x-forwarded-host"] || req.headers.host || process.env.VERCEL_URL || "";
  return host ? `${proto}://${host}` : "";
}

function receiptEmailForUser(user = {}) {
  const value = String(user.username || "").trim();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ? value : "";
}

function safeStripeEventForStorage(event = {}) {
  const object = event.data?.object || {};
  return {
    id: event.id || "",
    type: event.type || "",
    created: event.created || null,
    livemode: Boolean(event.livemode),
    data: {
      object: {
        id: object.id || "",
        object: object.object || "",
        status: object.status || "",
        amount: Number(object.amount || 0),
        currency: object.currency || "",
        payment_method_types: Array.isArray(object.payment_method_types) ? object.payment_method_types : [],
        metadata: {
          growup_payment_id: object.metadata?.growup_payment_id || "",
          growup_tenant_id: object.metadata?.growup_tenant_id || "",
          growup_subscription_id: object.metadata?.growup_subscription_id || "",
          growup_plan: object.metadata?.growup_plan || "",
          growup_billing_interval: object.metadata?.growup_billing_interval || ""
        }
      }
    }
  };
}

function isBillingApiPath(pathname = "") {
  return pathname === "/api/billing/subscription"
    || pathname === "/api/billing/checkout"
    || pathname === "/api/billing/upgrade"
    || pathname === "/api/billing/upgrade/qr";
}

function isPlatformAdminApiPath(pathname = "") {
  return pathname === "/api/platform-admin" || pathname.startsWith("/api/platform-admin/");
}

function isSubscriptionAccessExempt(pathname = "") {
  return isBillingApiPath(pathname)
    || isPlatformAdminApiPath(pathname)
    || ["/api/session", "/api/logout", "/api/verify/runtime"].includes(pathname);
}

function subscriptionBlockedResponse(res, db = {}) {
  return json(res, 402, {
    ok: false,
    code: "SUBSCRIPTION_PAYMENT_REQUIRED",
    error: "แพ็กเกจนี้ยังรอการชำระเงินหรือหมดอายุ กรุณาจัดการแพ็กเกจเพื่อเข้าใช้งานต่อ",
    billing: subscriptionBillingPayload(db)
  });
}

function safePlatformAdminError(res, error) {
  const detail = String(error.detail || error.message || "");
  if (detail.includes("PLATFORM_ADMIN_REQUIRED")) {
    return json(res, 403, { ok: false, code: "PLATFORM_ADMIN_REQUIRED", error: "ต้องใช้สิทธิ์ Platform Admin" });
  }
  if (detail.includes("PLATFORM_ADMIN_WRITE_FORBIDDEN")) {
    return json(res, 403, { ok: false, code: "PLATFORM_ADMIN_WRITE_FORBIDDEN", error: "ไม่มีสิทธิ์แก้ไขข้อมูล Platform Admin" });
  }
  if (detail.includes("INVALID_PROMOTION_CODE")) {
    return json(res, 400, { ok: false, code: "INVALID_PROMOTION_CODE", error: "ข้อมูลโค้ดโปรโมชั่นไม่ถูกต้อง" });
  }
  throw error;
}

function optionalTextPatch(value, fallback = "") {
  if (value === undefined) return fallback;
  return cleanText(value, fallback);
}

function normalizeBusinessProfile(settings = {}) {
  const profile = settings.businessProfile || {};
  return {
    name: cleanText(profile.name, cleanText(settings.businessName, "")),
    type: cleanText(profile.type, cleanText(settings.businessType, "")),
    address: cleanText(profile.address, cleanText(settings.businessAddress, "")),
    phone: cleanText(profile.phone, cleanText(settings.businessPhone, "")),
    email: cleanText(profile.email, cleanText(settings.businessEmail, "")),
    logoUrl: cleanText(profile.logoUrl, cleanText(settings.businessLogoUrl, ""))
  };
}

function normalizeBusinessGoals(goals = {}) {
  return {
    monthlyRevenue: Math.max(0, Number(goals.monthlyRevenue || 0)),
    monthlyProfit: Math.max(0, Number(goals.monthlyProfit || 0)),
    monthlyOrderCount: Math.max(0, Math.round(Number(goals.monthlyOrderCount || 0))),
    monthlyNewCustomerCount: Math.max(0, Math.round(Number(goals.monthlyNewCustomerCount || 0)))
  };
}

function normalizeAiPreferences(preferences = {}) {
  return {
    businessAnalysis: preferences.businessAnalysis !== false,
    recommendations: preferences.recommendations !== false,
    intelligentAlerts: preferences.intelligentAlerts !== false,
    customerInsights: preferences.customerInsights !== false
  };
}

function normalizeNotificationPreferences(preferences = {}) {
  const channelDefaults = { inApp: true, email: false, line: false };
  const categoryDefaults = {
    orderReview: true,
    customerFollowUp: true,
    vipReminder: true,
    lowStock: true,
    salesOpportunity: true
  };
  return {
    channels: {
      inApp: preferences.channels?.inApp !== false,
      email: Boolean(preferences.channels?.email ?? channelDefaults.email),
      line: Boolean(preferences.channels?.line ?? channelDefaults.line)
    },
    categories: {
      orderReview: preferences.categories?.orderReview !== false,
      customerFollowUp: preferences.categories?.customerFollowUp !== false,
      vipReminder: preferences.categories?.vipReminder !== false,
      lowStock: preferences.categories?.lowStock !== false,
      salesOpportunity: preferences.categories?.salesOpportunity !== false
    }
  };
}

function normalizeDisplayPreferences(preferences = {}) {
  const allowedThemes = new Set(["dark", "light", "system"]);
  const allowedLanguages = new Set(["th"]);
  const allowedDateFormats = new Set(["DD/MM/YYYY", "YYYY-MM-DD", "DD MMM YYYY"]);
  const allowedNumberFormats = new Set(["1,234.56", "1.234,56", "1234.56"]);
  const allowedCurrencies = new Set(["THB", "USD"]);
  return {
    theme: allowedThemes.has(preferences.theme) ? preferences.theme : "system",
    language: allowedLanguages.has(preferences.language) ? preferences.language : "th",
    dateFormat: allowedDateFormats.has(preferences.dateFormat) ? preferences.dateFormat : "DD/MM/YYYY",
    numberFormat: allowedNumberFormats.has(preferences.numberFormat) ? preferences.numberFormat : "1,234.56",
    currency: allowedCurrencies.has(preferences.currency) ? preferences.currency : "THB"
  };
}

function normalizeIntegrationSettings(settings = {}) {
  const integrations = settings.integrations || {};
  return {
    googleDrive: {
      connected: false,
      account: cleanText(integrations.googleDrive?.account, ""),
      error: cleanText(integrations.googleDrive?.error, process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? "" : "ยังไม่ได้ตั้งค่าข้อมูลอนุญาต Google Drive")
    },
    facebook: {
      connected: false,
      account: cleanText(integrations.facebook?.account, ""),
      error: cleanText(integrations.facebook?.error, process.env.META_CLIENT_ID && process.env.META_CLIENT_SECRET ? "" : "ยังไม่ได้ตั้งค่าข้อมูลอนุญาต Facebook")
    }
  };
}

function normalizeSettingsCostRows(rows = [], fieldName) {
  const allowedAdditionalCostTypes = new Set(["fixed_per_order", "per_item", "percent_sales"]);
  return (Array.isArray(rows) ? rows : [])
    .map((row, index) => {
      const normalized = {
        id: String(row?.id || `${fieldName}_${index + 1}`),
        name: String(row?.name || "").trim(),
        [fieldName]: Math.max(0, Number(row?.[fieldName] || 0)),
        enabled: row?.enabled !== false
      };
      if (fieldName === "amount") {
        normalized.type = allowedAdditionalCostTypes.has(row?.type) ? row.type : "fixed_per_order";
      }
      return normalized;
    })
    .filter(row => row.name);
}

function normalizePackageExpenses(expenses = []) {
  return (Array.isArray(expenses) ? expenses : [])
    .map((expense, index) => ({
      id: String(expense?.id || `expense_${index + 1}`),
      name: String(expense?.name || "").trim(),
      amount: Math.max(0, Number(expense?.amount || 0)),
      enabled: expense?.enabled !== false
    }))
    .filter(expense => expense.name);
}

const PROFIT_SNAPSHOT_VERSION = 1;
const PROFIT_SNAPSHOT_FIELDS = [
  "revenueSnapshot",
  "productCostSnapshot",
  "packageExpenseSnapshot",
  "globalExpenseSnapshot",
  "profitBeforeAdsSnapshot",
  "profitAfterAdsSnapshot"
];

function snapshotMoney(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(6)) : 0;
}

function hasOrderProfitSnapshot(order = {}) {
  return Number(order.profitSnapshotVersion || 0) >= PROFIT_SNAPSHOT_VERSION
    && PROFIT_SNAPSHOT_FIELDS.every(field => Number.isFinite(Number(order[field])));
}

function productCostForOrderSnapshot(order = {}, settings = {}) {
  const productName = normalizeProductNameForMatching(order.items || "Growup Formula");
  const productNameKey = normalizedProductNameKey(productName);
  const productConfig = normalizeSettingsCostRows(settings.productCosts, "costPerJar")
    .find(item => normalizedProductNameKey(item.name) === productNameKey);
  if (!productConfig?.enabled) return 0;
  const salesPackage = salesPackageForOrder(settings, order);
  const quantity = salesPackage
    ? Number(order.totalQuantityShipped || salesPackage.totalQuantityShipped || order.jars || 0)
    : Number(order.jars || 0);
  return quantity * Number(productConfig.costPerJar || 0);
}

function moneyMatches(left, right) {
  return Math.abs(Number(left || 0) - Number(right || 0)) < 0.000001;
}

function salesPackageForOrder(settings = {}, order = {}) {
  const productId = String(order.productId || order.product_id || "").trim();
  const productNameKey = normalizedProductNameKey(order.items || order.product || order.productName || "");
  const product = normalizeProductRecords(settings.products).find(item =>
    (productId && String(item.id || "") === productId) ||
    (productNameKey && normalizedProductNameKey(item.name) === productNameKey)
  );
  if (!product) return null;
  const packages = normalizeSalesPackages(product.salesPackages);
  const packageId = String(order.packageId || order.package_id || "").trim();
  if (packageId) return packages.find(item => item.id === packageId) || null;
  const revenue = Number(order.amount || order.revenueSnapshot || 0);
  const shipped = Number(order.totalQuantityShipped || order.jars || 0);
  if (!revenue || !shipped) return null;
  const matches = packages.filter(item =>
    item.enabled !== false &&
    moneyMatches(item.salePrice, revenue) &&
    moneyMatches(item.totalQuantityShipped, shipped)
  );
  return matches.length === 1 ? matches[0] : null;
}

function packageExpensesForOrder(order = {}, settings = {}) {
  const explicitExpenses = normalizePackageExpenses(order.packageExpenses);
  if (explicitExpenses.length) return explicitExpenses;
  const salesPackage = salesPackageForOrder(settings, order);
  return salesPackage ? normalizePackageExpenses(salesPackage.expenses) : [];
}

function packageExpenseForOrderSnapshot(order = {}, settings = {}) {
  return packageExpensesForOrder(order, settings)
    .filter(expense => expense.enabled)
    .reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
}

function globalExpenseForOrderSnapshot(order = {}, settings = {}) {
  const revenue = Number(order.amount || 0);
  const itemCount = Number(order.jars || 0);
  return normalizeSettingsCostRows(settings.additionalCosts, "amount")
    .filter(expense => expense.enabled)
    .reduce((sum, expense) => {
      if (expense.type === "percent_sales") return sum + (revenue * Number(expense.amount || 0) / 100);
      if (expense.type === "per_item") return sum + (itemCount * Number(expense.amount || 0));
      return sum + Number(expense.amount || 0);
    }, 0);
}

function calculateOrderProfitSnapshot(order = {}, settings = {}, {
  source = "created",
  timestamp = new Date().toISOString(),
  createdAt = ""
} = {}) {
  const revenueSnapshot = snapshotMoney(order.amount);
  const productCostSnapshot = snapshotMoney(productCostForOrderSnapshot(order, settings));
  const packageExpenseSnapshot = snapshotMoney(packageExpenseForOrderSnapshot(order, settings));
  const globalExpenseSnapshot = snapshotMoney(globalExpenseForOrderSnapshot(order, settings));
  const profitBeforeAdsSnapshot = snapshotMoney(
    revenueSnapshot - productCostSnapshot - packageExpenseSnapshot - globalExpenseSnapshot
  );
  return {
    revenueSnapshot,
    productCostSnapshot,
    packageExpenseSnapshot,
    globalExpenseSnapshot,
    profitBeforeAdsSnapshot,
    profitAfterAdsSnapshot: profitBeforeAdsSnapshot,
    profitSnapshotVersion: PROFIT_SNAPSHOT_VERSION,
    profitSnapshotCreatedAt: String(createdAt || timestamp),
    profitSnapshotUpdatedAt: timestamp,
    profitSnapshotSource: source
  };
}

function effectiveOrderProfitSnapshot(order = {}, settings = {}) {
  if (!hasOrderProfitSnapshot(order)) {
    return calculateOrderProfitSnapshot(order, settings, { source: "fallback" });
  }
  const snapshotPackageExpense = Number(order.packageExpenseSnapshot || 0);
  const inferredPackageExpense = packageExpenseForOrderSnapshot(order, settings);
  const packageExpenseSnapshot = snapshotPackageExpense > 0
    ? snapshotPackageExpense
    : inferredPackageExpense;
  const packageExpenseAdjustment = Math.max(0, packageExpenseSnapshot - snapshotPackageExpense);
  const profitBeforeAdsSnapshot = snapshotMoney(Number(order.profitBeforeAdsSnapshot || 0) - packageExpenseAdjustment);
  const profitAfterAdsSnapshot = snapshotMoney(
    Number.isFinite(Number(order.profitAfterAdsSnapshot))
      ? Number(order.profitAfterAdsSnapshot || 0) - packageExpenseAdjustment
      : profitBeforeAdsSnapshot
  );
  return {
    revenueSnapshot: Number(order.revenueSnapshot || 0),
    productCostSnapshot: Number(order.productCostSnapshot || 0),
    packageExpenseSnapshot,
    globalExpenseSnapshot: Number(order.globalExpenseSnapshot || 0),
    profitBeforeAdsSnapshot,
    profitAfterAdsSnapshot,
    profitSnapshotVersion: Number(order.profitSnapshotVersion || 0),
    profitSnapshotCreatedAt: order.profitSnapshotCreatedAt || "",
    profitSnapshotUpdatedAt: order.profitSnapshotUpdatedAt || "",
    profitSnapshotSource: order.profitSnapshotSource || "snapshot"
  };
}

function applyOrderProfitSnapshot(order, settings, source) {
  const timestamp = new Date().toISOString();
  Object.assign(order, calculateOrderProfitSnapshot(order, settings, {
    source,
    timestamp,
    createdAt: source === "edited" ? order.profitSnapshotCreatedAt : ""
  }));
  return order;
}

function backfillMissingOrderProfitSnapshots(db) {
  const backfilled = [];
  for (const order of db.orders || []) {
    if (hasOrderProfitSnapshot(order)) continue;
    applyOrderProfitSnapshot(order, db.settings || {}, "backfilled");
    backfilled.push(order);
  }
  return backfilled;
}

function normalizeSalesPackages(packages = []) {
  return (Array.isArray(packages) ? packages : []).map((item, index) => {
    const paidQuantity = Math.max(0, Number(item?.paidQuantity || 0));
    const freeQuantity = Math.max(0, Number(item?.freeQuantity || 0));
    return {
      id: String(item?.id || `package_${index + 1}`),
      name: String(item?.name || `แพ็กเกจ ${index + 1}`).trim() || `แพ็กเกจ ${index + 1}`,
      paidQuantity,
      freeQuantity,
      totalQuantityShipped: Math.max(0, Number(item?.totalQuantityShipped ?? paidQuantity + freeQuantity)),
      salePrice: Math.max(0, Number(item?.salePrice || 0)),
      enabled: item?.enabled !== false,
      expenses: normalizePackageExpenses(item?.expenses)
    };
  });
}

function normalizeProductRecords(products = []) {
  const normalized = (Array.isArray(products) ? products : [])
    .map((product, index) => ({
      id: String(product?.id || `product_${index + 1}`),
      image: String(product?.image || "").trim(),
      name: normalizeProductNameForMatching(product?.name || ""),
      sku: String(product?.sku || "").trim(),
      description: String(product?.description || "").trim(),
      salePrice: Math.max(0, Number(product?.salePrice || 0)),
      costPerItem: Math.max(0, Number(product?.costPerItem || 0)),
      stockQuantity: Math.max(0, Number(product?.stockQuantity || 0)),
      lowStockAlert: Math.max(0, Number(product?.lowStockAlert || 0)),
      status: String(product?.status || "พร้อมขาย").trim() || "พร้อมขาย",
      followUpEnabled: product?.followUpEnabled !== false,
      followUpDays: Math.max(1, Number(product?.followUpDays || 15)),
      followUpRule: String(product?.followUpRule || "1 ชิ้น = 15 วัน").trim() || "1 ชิ้น = 15 วัน",
      archived: Boolean(product?.archived),
      createdAt: String(product?.createdAt || "").trim(),
      updatedAt: String(product?.updatedAt || "").trim(),
      salesPackages: normalizeSalesPackages(product?.salesPackages)
    }))
    .filter(product => product.name);
  const unique = new Map();
  for (const product of normalized) {
    const key = `${String(product.sku || "").trim().toLowerCase()}|${normalizedProductNameKey(product.name)}`;
    const existing = unique.get(key);
    if (!existing || (existing.archived && !product.archived)) unique.set(key, product);
  }
  return [...unique.values()];
}

function isHttpImageUrl(value = "") {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function parseProductImageDataUrl(value = "") {
  const image = String(value || "").trim();
  const match = image.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (!bytes.length) return null;
  return { mimeType, bytes };
}

function productImageExtension(mimeType = "") {
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") return "jpg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/gif") return "gif";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/svg+xml") return "svg";
  return "bin";
}

function storageSafeSegment(value = "") {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "product";
}

function productImageStoragePlan(product = {}) {
  const parsed = parseProductImageDataUrl(product.image);
  if (!parsed) return null;
  const hash = crypto.createHash("sha256").update(parsed.bytes).digest("hex");
  const extension = productImageExtension(parsed.mimeType);
  const productId = storageSafeSegment(product.id || hash.slice(0, 16));
  return {
    productId: product.id,
    productName: product.name,
    sku: product.sku,
    mimeType: parsed.mimeType,
    bytes: parsed.bytes,
    byteLength: parsed.bytes.length,
    hash,
    objectPath: `products/${productId}/${hash}.${extension}`
  };
}

function businessLogoStoragePlan(image = "") {
  const parsed = parseProductImageDataUrl(image);
  if (!parsed) return null;
  const hash = crypto.createHash("sha256").update(parsed.bytes).digest("hex");
  const extension = productImageExtension(parsed.mimeType);
  return {
    mimeType: parsed.mimeType,
    bytes: parsed.bytes,
    byteLength: parsed.bytes.length,
    hash,
    objectPath: `business-logo/${hash}.${extension}`
  };
}

async function storeBusinessLogoForSave(image = "") {
  const current = String(image || "").trim();
  if (!current) return "";
  if (/^https?:\/\//i.test(current)) return current;
  const plan = businessLogoStoragePlan(current);
  if (!plan) throw new Error("รูปโลโก้ไม่ถูกต้อง");
  if (typeof uploadProductImageObject !== "function") {
    throw new Error("ยังไม่ได้ตั้งค่า image storage สำหรับอัปโหลดโลโก้");
  }
  const url = await uploadProductImageObject(plan.objectPath, plan.bytes, plan.mimeType);
  if (typeof verifyPublicProductImageUrl === "function") {
    const verified = await verifyPublicProductImageUrl(url);
    if (!verified) throw new Error("Uploaded business logo is not publicly accessible");
  }
  return url;
}

function productImageMigrationSummary(products = []) {
  const storageBaseUrl = typeof productImagePublicBaseUrl === "function" ? productImagePublicBaseUrl() : "";
  return normalizeProductRecords(products).map(product => {
    const dataPlan = productImageStoragePlan(product);
    if (dataPlan) {
      return {
        id: product.id,
        name: product.name,
        sku: product.sku,
        action: "migrate",
        bytes: dataPlan.byteLength,
        mimeType: dataPlan.mimeType,
        objectPath: dataPlan.objectPath
      };
    }
    const image = String(product.image || "").trim();
    const storageUrl = storageBaseUrl && image.startsWith(storageBaseUrl);
    return {
      id: product.id,
      name: product.name,
      sku: product.sku,
      action: "skip",
      reason: image ? (isHttpImageUrl(image) ? (storageUrl ? "already-storage-url" : "external-url") : "unsupported-image-format") : "no-image",
      bytes: image.length
    };
  });
}

async function storeProductImageForSave(productId, image = "") {
  const plan = productImageStoragePlan({ id: productId, image });
  if (!plan || typeof uploadProductImageObject !== "function") return String(image || "").trim();
  const url = await uploadProductImageObject(plan.objectPath, plan.bytes, plan.mimeType);
  if (typeof verifyPublicProductImageUrl === "function") {
    const verified = await verifyPublicProductImageUrl(url);
    if (!verified) throw new Error("Uploaded product image is not publicly accessible");
  }
  return url;
}

function normalizedProductIdentity(product = {}) {
  return {
    sku: String(product?.sku || "").trim().toLowerCase(),
    name: normalizedProductNameKey(product?.name)
  };
}

function canonicalProductNameForOrder(settings = {}, value) {
  const normalizedName = normalizeProductNameForMatching(value);
  const normalizedKey = normalizedProductNameKey(normalizedName);
  if (!normalizedKey) return "";
  const products = normalizeProductRecords(settings.products)
    .map(product => ({
      ...product,
      nameKey: normalizedProductNameKey(product.name)
    }))
    .filter(product => product.nameKey);
  const exact = products.find(product => product.nameKey === normalizedKey);
  if (exact) return exact.name;
  const containsMatches = products
    .filter(product => normalizedKey.includes(product.nameKey))
    .sort((a, b) => b.nameKey.length - a.nameKey.length || a.name.localeCompare(b.name, "th"));
  return containsMatches[0]?.name || normalizedName;
}

const PRODUCT_RESOLUTION_ERROR = "ไม่พบสินค้า กรุณาเพิ่มสินค้าหรือจับคู่สินค้าให้ถูกต้องก่อนสร้างออเดอร์";

function activeProductsForOrders(settings = {}) {
  return normalizeProductRecords(settings.products).filter(product => !product.archived);
}

function resolveActiveProductForOrder(settings = {}, payload = {}, options = {}) {
  const products = activeProductsForOrders(settings);
  const productId = String(payload.productId || payload.product_id || "").trim();
  const productName = payload.items || payload.product || payload.productName || "";
  let product = productId
    ? products.find(item => String(item.id || "") === productId)
    : null;
  if (!product) {
    const normalizedKey = normalizedProductNameKey(normalizeProductNameForMatching(productName));
    product = products.find(item => normalizedProductNameKey(item.name) === normalizedKey) || null;
  }
  if (!product && options.allowContainsMatch) {
    const normalizedKey = normalizedProductNameKey(normalizeProductNameForMatching(productName));
    product = products
      .filter(item => normalizedKey && normalizedKey.includes(normalizedProductNameKey(item.name)))
      .sort((a, b) => normalizedProductNameKey(b.name).length - normalizedProductNameKey(a.name).length)[0] || null;
  }
  if (!product) {
    const error = new Error(PRODUCT_RESOLUTION_ERROR);
    error.code = "PRODUCT_NOT_FOUND";
    throw error;
  }
  const packageId = String(payload.packageId || payload.package_id || "").trim();
  const salesPackages = normalizeSalesPackages(product.salesPackages);
  let selectedPackage = packageId
    ? salesPackages.find(item => item.id === packageId && item.enabled !== false)
    : null;
  if (packageId && !selectedPackage) {
    const error = new Error(PRODUCT_RESOLUTION_ERROR);
    error.code = "PRODUCT_NOT_FOUND";
    throw error;
  }
  if (!selectedPackage) {
    selectedPackage = salesPackageForOrder({ products: [product] }, {
      ...payload,
      productId: product.id,
      items: product.name
    });
  }
  return { product, package: selectedPackage };
}

function resolveStoredProductForOrder(settings = {}, order = {}) {
  const products = normalizeProductRecords(settings.products);
  const productId = String(order.productId || order.product_id || "").trim();
  const productNameKey = normalizedProductNameKey(order.items || order.product || order.productName || "");
  const product = (productId ? products.find(item => String(item.id || "") === productId) : null)
    || products.find(item => productNameKey && normalizedProductNameKey(item.name) === productNameKey)
    || null;
  if (!product) {
    const error = new Error(PRODUCT_RESOLUTION_ERROR);
    error.code = "PRODUCT_NOT_FOUND";
    throw error;
  }
  const packageId = String(order.packageId || order.package_id || "").trim();
  const selectedPackage = packageId
    ? normalizeSalesPackages(product.salesPackages).find(item => item.id === packageId) || null
    : null;
  return { product, package: selectedPackage };
}

function applyResolvedProductToPayload(settings = {}, payload = {}, options = {}) {
  const resolved = resolveActiveProductForOrder(settings, payload, options);
  const preservePackageSnapshot = options.preservePackageSnapshot
    && Array.isArray(payload.packageExpenses)
    && String(payload.packageId || payload.package_id || "") === String(resolved.package?.id || "");
  return {
    ...payload,
    items: resolved.product.name,
    productId: resolved.product.id,
    packageId: resolved.package?.id || "",
    packageName: resolved.package?.name || "",
    paidQuantity: resolved.package ? Number(resolved.package.paidQuantity || 0) : Number(payload.paidQuantity || 0),
    freeQuantity: resolved.package ? Number(resolved.package.freeQuantity || 0) : Number(payload.freeQuantity || 0),
    totalQuantityShipped: resolved.package ? Number(resolved.package.totalQuantityShipped || 0) : Number(payload.totalQuantityShipped || 0),
    packageExpenses: preservePackageSnapshot
      ? normalizePackageExpenses(payload.packageExpenses)
      : resolved.package
      ? normalizePackageExpenses(resolved.package.expenses).map(expense => ({ ...expense }))
      : normalizePackageExpenses(payload.packageExpenses)
  };
}

function productReferenceReport(db = {}, product = {}) {
  const productId = String(product.id || "").trim();
  const productNameKey = normalizedProductNameKey(product.name);
  const packages = normalizeSalesPackages(product.salesPackages);
  const packageIds = new Set(packages.map(item => item.id));
  const matchesProduct = order => (
    (productId && String(order.productId || order.product_id || "") === productId) ||
    (productNameKey && normalizedProductNameKey(order.items || order.product || order.productName || "") === productNameKey)
  );
  const orders = (db.orders || []).filter(matchesProduct);
  const packageOrders = (db.orders || []).filter(order => packageIds.has(String(order.packageId || order.package_id || "")));
  const productCosts = normalizeSettingsCostRows(db.settings?.productCosts, "costPerJar").filter(item =>
    (productId && String(item.id || "") === productId) ||
    (productNameKey && normalizedProductNameKey(item.name) === productNameKey)
  );
  const adCostRecords = Array.isArray(db.settings?.adCostRecords)
    ? db.settings.adCostRecords.filter(record =>
        (productId && String(record.productId || "") === productId) ||
        (productNameKey && normalizedProductNameKey(record.productName || "") === productNameKey)
      )
    : [];
  const contactLogs = (db.contactLogs || []).filter(log => {
    const textValue = `${log.productId || ""} ${log.productName || ""} ${log.note || ""}`;
    return (productId && String(log.productId || "") === productId)
      || (productNameKey && normalizedProductNameKey(log.productName || "") === productNameKey)
      || (productNameKey && normalizedProductNameKey(textValue).includes(productNameKey));
  });
  return {
    orders,
    packageOrders,
    productCosts,
    adCostRecords,
    contactLogs,
    total: orders.length + packageOrders.length + productCosts.length + adCostRecords.length + contactLogs.length
  };
}

function orderInventoryQuantity(order = {}) {
  const shipped = Number(order.totalQuantityShipped || 0);
  if (Number.isFinite(shipped) && shipped > 0) return shipped;
  const jars = Number(order.jars ?? order.quantity ?? 0);
  return Number.isFinite(jars) ? Math.max(0, jars) : 0;
}

function findInventoryProductIndex(products = [], order = {}) {
  const productId = String(order.productId || order.product_id || "").trim();
  if (productId) {
    const idIndex = products.findIndex(product => String(product.id || "") === productId);
    if (idIndex >= 0) return idIndex;
  }
  const orderNameKey = normalizedProductNameKey(order.items || order.product || order.productName || "");
  if (!orderNameKey) return -1;
  return products.findIndex(product => normalizedProductNameKey(product.name) === orderNameKey);
}

function adjustInventoryForOrderChange(db, previousOrder = null, nextOrder = null) {
  const products = normalizeProductRecords(db.settings?.products);
  if (!products.length) return null;

  const adjustments = new Map();
  const addAdjustment = (order, direction) => {
    if (!order) return;
    const index = findInventoryProductIndex(products, order);
    if (index < 0) return;
    const quantity = orderInventoryQuantity(order);
    if (quantity <= 0) return;
    adjustments.set(index, (adjustments.get(index) || 0) + (direction * quantity));
  };

  addAdjustment(previousOrder, 1);
  addAdjustment(nextOrder, -1);
  if (!adjustments.size) return null;

  for (const [index, delta] of adjustments.entries()) {
    const product = products[index];
    const currentStock = Number(product.stockQuantity || 0);
    const nextStock = currentStock + delta;
    if (nextStock < 0) {
      const requested = -delta;
      const error = new Error(`สินค้า ${product.name} คงเหลือ ${currentStock} ชิ้น ไม่พอสำหรับออเดอร์ ${requested} ชิ้น`);
      error.code = "INSUFFICIENT_STOCK";
      error.product = product;
      error.availableStock = currentStock;
      error.requestedQuantity = requested;
      throw error;
    }
  }

  const now = new Date().toISOString();
  for (const [index, delta] of adjustments.entries()) {
    const product = products[index];
    products[index] = {
      ...product,
      stockQuantity: Math.max(0, Number(product.stockQuantity || 0) + delta),
      updatedAt: now
    };
  }
  db.settings = { ...(db.settings || {}), products };
  return products;
}

function newProductId(products = []) {
  const existingIds = new Set(products.map(product => String(product?.id || "")));
  let id = uid("product");
  while (existingIds.has(id)) id = uid("product");
  return id;
}

function productCostIndex(productCosts = [], productId = "", legacyNames = []) {
  const idIndex = productCosts.findIndex(item => String(item?.id || "") === String(productId || ""));
  if (idIndex >= 0) return idIndex;
  const names = new Set(legacyNames.map(normalizedProductNameKey).filter(Boolean));
  return productCosts.findIndex(item => names.has(normalizedProductNameKey(item?.name)));
}

function publicSettings(settings = {}) {
  const effective = effectiveSettings(settings);
  const publicBase = { ...effective };
  delete publicBase.openaiApiKey;
  delete publicBase.lineChannelSecret;
  delete publicBase.lineChannelAccessToken;
  delete publicBase.lineGroupId;
  const businessProfile = normalizeBusinessProfile(effective);
  const businessGoals = normalizeBusinessGoals(effective.businessGoals);
  const aiPreferences = normalizeAiPreferences(effective.aiPreferences);
  const notificationPreferences = normalizeNotificationPreferences(effective.notificationPreferences);
  const displayPreferences = normalizeDisplayPreferences(effective.displayPreferences);
  const integrations = normalizeIntegrationSettings(effective);
  return {
    ...publicBase,
    businessName: businessProfile.name,
    businessType: businessProfile.type,
    businessAddress: businessProfile.address,
    businessPhone: businessProfile.phone,
    businessEmail: businessProfile.email,
    businessLogoUrl: businessProfile.logoUrl,
    businessProfile,
    businessGoals,
    aiPreferences,
    notificationPreferences,
    displayPreferences,
    integrations,
    followUpDaysPerUnit: Number(effective.followUpDaysPerUnit || 15),
    products: normalizeProductRecords(effective.products),
    productCosts: normalizeSettingsCostRows(effective.productCosts, "costPerJar"),
    additionalCosts: normalizeSettingsCostRows(effective.additionalCosts, "amount"),
    customerSources: normalizeCustomerSources(effective.customerSources),
    adPlatforms: normalizeAdPlatforms(effective.adPlatforms, {
      useDefaults: effective.adPlatforms === undefined
    }),
    adCostRecords: normalizeAdCostRecords(effective.adCostRecords),
    lineChannelSecret: "",
    lineChannelAccessToken: "",
    lineGroupId: "",
    lineChannelSecretConfigured: Boolean(effective.lineChannelSecret),
    lineChannelAccessTokenConfigured: Boolean(effective.lineChannelAccessToken),
    openaiApiKeyConfigured: Boolean(effective.openaiApiKey),
    lineChannelIdFromEnv: Boolean(process.env.LINE_CHANNEL_ID),
    lineChannelSecretFromEnv: Boolean(process.env.LINE_CHANNEL_SECRET),
    lineChannelAccessTokenFromEnv: Boolean(process.env.LINE_CHANNEL_ACCESS_TOKEN),
    lineGroupIdFromEnv: Boolean(process.env.LINE_GROUP_ID),
    openaiApiKeyFromEnv: Boolean(process.env.OPENAI_API_KEY)
  };
}

function financeSettingsPayload(settings = {}) {
  return {
    productCosts: normalizeSettingsCostRows(settings.productCosts, "costPerJar"),
    additionalCosts: normalizeSettingsCostRows(settings.additionalCosts, "amount")
  };
}

function productSettingsPayload(settings = {}) {
  return {
    products: normalizeProductRecords(settings.products),
    productCosts: normalizeSettingsCostRows(settings.productCosts, "costPerJar")
  };
}

function customerSourcesSettingsPayload(settings = {}) {
  return {
    customerSources: normalizeCustomerSources(settings.customerSources)
  };
}

function productManagementCounts(settings = {}) {
  const products = normalizeProductRecords(settings.products);
  return products.reduce((counts, product) => {
    counts.total += 1;
    const status = product.archived
      ? "ปิดใช้งาน"
      : product.stockQuantity <= 0
        ? "ปิดการขาย"
        : product.stockQuantity <= Number(product.lowStockAlert || 0)
          ? "ใกล้หมด"
          : product.stockQuantity <= Math.max(Number(product.lowStockAlert || 0) * 2, 10)
            ? "เหลือน้อย"
            : product.status || "พร้อมขาย";
    if (status === "พร้อมขาย") counts.ready += 1;
    if (["ใกล้หมด", "เหลือน้อย"].includes(status)) counts.low += 1;
    return counts;
  }, { total: 0, ready: 0, low: 0 });
}

async function readProductSettingsForSave() {
  if (typeof readSettingsPatch === "function") {
    return readSettingsPatch(["products", "productCosts"]);
  }
  const db = await readDb();
  return {
    products: db.settings?.products,
    productCosts: db.settings?.productCosts
  };
}

function marketingPerformanceForDb(db, period = {}) {
  const orders = (db.orders || []).map(order => ({
    ...order,
    ...effectiveOrderProfitSnapshot(order, db.settings || {})
  }));
  return marketingPerformance({
    orders,
    records: db.settings?.adCostRecords || [],
    ...period,
    fallbackProfitForOrder: order => {
      const snapshot = calculateOrderProfitSnapshot(order, db.settings || {}, { source: "fallback" });
      return { profitBeforeAds: snapshot.profitBeforeAdsSnapshot };
    }
  });
}

function adPlatformById(settings, id) {
  return normalizeAdPlatforms(settings?.adPlatforms, {
    useDefaults: settings?.adPlatforms === undefined
  }).find(platform => platform.id === id);
}

function adProductSnapshot(db, productId, productName) {
  const products = normalizeProductRecords(db.settings?.products);
  const product = products.find(item => item.id === productId)
    || products.find(item => item.name === productName);
  return {
    productId: String(product?.id || productId || "").trim(),
    productName: String(product?.name || productName || "").trim()
  };
}

function normalizeAdCostInput(db, body = {}, existing = {}) {
  const product = adProductSnapshot(
    db,
    String(body.productId ?? existing.productId ?? "").trim(),
    String(body.productName ?? existing.productName ?? "").trim()
  );
  const platformId = String(body.platformId ?? existing.platformId ?? "").trim();
  const platform = adPlatformById(db.settings, platformId);
  return normalizeAdCostRecords([{
    ...existing,
    ...body,
    id: existing.id || uid("ad"),
    productId: product.productId,
    productName: product.productName,
    platformId,
    platformName: platform?.name || String(body.platformName ?? existing.platformName ?? "").trim(),
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }])[0];
}

function isPlaceholderChannel(value) {
  return /^manual(?:\s+import)?$/i.test(String(value || "").trim());
}

function orderChannel(order = {}) {
  const candidates = [order.sourceChannel, order.source_channel, order.source];
  const channel = candidates.map(value => String(value || "").trim()).find(value => value && !isPlaceholderChannel(value));
  return channel || "";
}

const OPPORTUNITY_CHAT_RESULT = "แชทหาลูกค้าแล้ว";
const OPPORTUNITY_CRM_RESULT = "CRMเรียบร้อยแล้ว";
const OPPORTUNITY_CYCLE_NOTE_RE = /\n?\[\[opportunityCycle:orderId=([^\]]+)\]\]/g;

function stripOpportunityCycleNote(note = "") {
  return String(note || "").replace(OPPORTUNITY_CYCLE_NOTE_RE, "").trim();
}

function opportunityCycleMarker(orderId = "") {
  return `[[opportunityCycle:orderId=${encodeURIComponent(String(orderId || "").trim())}]]`;
}

function opportunityLogOrderId(log = {}) {
  const direct = String(log.orderId || log.order_id || log.opportunityCycleId || "").trim();
  if (direct) return direct;
  OPPORTUNITY_CYCLE_NOTE_RE.lastIndex = 0;
  const match = OPPORTUNITY_CYCLE_NOTE_RE.exec(String(log.note || ""));
  OPPORTUNITY_CYCLE_NOTE_RE.lastIndex = 0;
  return match ? decodeURIComponent(match[1]) : "";
}

function opportunityOrdersForCustomer(db, customerId = "") {
  return (db.orders || [])
    .filter(order => order.customerId === customerId)
    .sort((a, b) => [
      String(a.date || ""),
      String(a.time || ""),
      String(a.id || "")
    ].join("|").localeCompare([
      String(b.date || ""),
      String(b.time || ""),
      String(b.id || "")
    ].join("|")));
}

function latestOpportunityOrderForCustomer(db, customerId = "") {
  const orders = opportunityOrdersForCustomer(db, customerId);
  return orders[orders.length - 1] || null;
}

function inferLegacyOpportunityLogOrderId(db, customerId = "", log = {}) {
  const direct = opportunityLogOrderId(log);
  if (direct) return direct;
  const orders = opportunityOrdersForCustomer(db, customerId);
  if (orders.length === 1) return String(orders[0].id || "");
  const logDate = String(log.date || log.contact_date || "");
  const previousOrders = orders.filter(order => String(order.date || "") <= logDate);
  if (previousOrders.length) return String(previousOrders[previousOrders.length - 1].id || "");
  return "";
}

function appendOpportunityCycleNote(note = "", orderId = "") {
  const clean = stripOpportunityCycleNote(note);
  const marker = opportunityCycleMarker(orderId);
  return [clean, marker].filter(Boolean).join("\n");
}

const DEFAULT_CUSTOMER_SOURCE_CHANNELS = [
  { key: "facebook", name: "Facebook" },
  { key: "line", name: "LINE" },
  { key: "phone", name: "โทร" },
  { key: "crm", name: "CRM" }
];

const LEGACY_CUSTOMER_SOURCE_CHANNELS = [
  { key: "referral", name: "Customer Referral" },
  { key: "tiktok", name: "TikTok" },
  { key: "shopee", name: "Shopee" },
  { key: "lazada", name: "Lazada" },
  { key: "instagram", name: "Instagram" },
  { key: "website", name: "Website" },
  { key: "walk_in", name: "Walk-in" }
];

const CUSTOMER_SOURCE_KNOWN_CHANNELS = [...DEFAULT_CUSTOMER_SOURCE_CHANNELS, ...LEGACY_CUSTOMER_SOURCE_CHANNELS];
const CUSTOMER_SOURCE_KEYS = new Set(CUSTOMER_SOURCE_KNOWN_CHANNELS.map(channel => channel.key));
const CUSTOMER_SOURCE_BY_KEY = new Map(CUSTOMER_SOURCE_KNOWN_CHANNELS.map(channel => [channel.key, channel]));

function customerSourceKeyFromName(value = "") {
  return String(value || "")
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9ก-๙]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeCustomerSourceKey(value = "") {
  const raw = String(value || "").trim();
  const normalized = customerSourceKeyFromName(raw);
  if (!raw) return "";
  if (CUSTOMER_SOURCE_KEYS.has(normalized)) return normalized;
  if (
    normalized.includes("facebook") ||
    normalized === "fb" ||
    raw.includes("เฟส") ||
    raw.includes("เพจ") ||
    raw.includes("ไลฟ์") ||
    normalized.includes("inbox")
  ) return "facebook";
  if (normalized.includes("line") || normalized.includes("line_oa") || raw.includes("ไลน์")) return "line";
  if (normalized === "crm" || normalized.includes("customer_relationship") || normalized.includes("ลูกค้าสัมพันธ์")) return "crm";
  if (normalized.includes("tiktok") || normalized.includes("tik_tok") || raw.includes("ติ๊กต็อก")) return "tiktok";
  if (normalized.includes("shopee") || raw.includes("ช้อปปี้") || raw.includes("ช็อปปี้")) return "shopee";
  if (normalized.includes("lazada") || raw.includes("ลาซาด้า")) return "lazada";
  if (normalized.includes("instagram") || normalized === "ig" || raw.includes("อินสตาแกรม")) return "instagram";
  if (normalized.includes("website") || normalized.includes("web") || raw.includes("เว็บไซต์")) return "website";
  if (normalized.includes("walk_in") || normalized.includes("walkin") || raw.includes("หน้าร้าน")) return "walk_in";
  if (raw.includes("โทร") || normalized.includes("phone") || normalized.includes("call") || normalized.includes("tel")) return "phone";
  if (
    raw.includes("บอกต่อ") ||
    raw.includes("แนะนำ") ||
    normalized.includes("referral") ||
    normalized.includes("refer") ||
    normalized.includes("word_of_mouth")
  ) return "referral";
  if (normalized === "other" || raw.includes("อื่น")) return "";
  return normalized;
}

function normalizeCustomerSourceRecord(source = {}, index = 0) {
  const name = String(source.name || source.label || source.value || "").trim();
  const key = normalizeCustomerSourceKey(source.key || source.id || name);
  if (!key || !name) return null;
  const known = CUSTOMER_SOURCE_BY_KEY.get(key);
  return {
    key,
    name: known?.name || name,
    sortOrder: Number(source.sortOrder ?? source.order ?? index + 10)
  };
}

function normalizeCustomerSources(sources = []) {
  const map = new Map();
  (Array.isArray(sources) ? sources : []).forEach((source, index) => {
    const normalized = normalizeCustomerSourceRecord(source, index);
    if (normalized && !DEFAULT_CUSTOMER_SOURCE_CHANNELS.some(item => item.key === normalized.key)) {
      map.set(normalized.key, normalized);
    }
  });
  return [...map.values()].sort((a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name));
}

function normalizeOrderOriginSource(sourceValue = "", otherValue = "") {
  const raw = String(sourceValue || "").trim();
  const other = String(otherValue || "").trim();
  if (!raw && !other) return { originSource: "", originSourceOther: "" };
  if (raw.toLowerCase() === "other" && other) {
    return { originSource: normalizeCustomerSourceKey(other), originSourceOther: "" };
  }
  const key = normalizeCustomerSourceKey(raw || other);
  return { originSource: key, originSourceOther: "" };
}

function normalizeDuplicateText(value) {
  return normalizeImportText(value).toLowerCase();
}

function normalizeDuplicateNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeDuplicateComparisonFields(order = {}) {
  return {
    customer_name: normalizeDuplicateText(order.name || order.customerName || order.customer_name || ""),
    phone_number: normalizePhone(order.phone || order.phone_number || ""),
    shipping_address: normalizeDuplicateText(order.address || order.shippingAddress || order.shipping_address || ""),
    quantity: normalizeDuplicateNumber(order.jars || order.quantity || 0),
    total_amount: normalizeDuplicateNumber(order.amount || order.totalAmount || order.total_amount || 0)
  };
}

function duplicateFingerprint(order = {}) {
  return JSON.stringify(normalizeDuplicateComparisonFields(order));
}

function parseOrderDateTime(order = {}) {
  const date = toDateOnly(order.date || order.order_date || "");
  if (date) {
    const timeValue = String(order.time || order.order_time || "").trim();
    const timeMatch = timeValue.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!timeMatch) {
      const fallback = new Date(`${date}T00:00:00+07:00`);
      return Number.isNaN(fallback.getTime()) ? null : fallback;
    }
    const [, hours, minutes, seconds = "00"] = timeMatch;
    const exact = new Date(`${date}T${String(hours).padStart(2, "0")}:${minutes}:${seconds}+07:00`);
    return Number.isNaN(exact.getTime()) ? null : exact;
  }
  const createdValue = String(order.createdAt || order.created_at || "").trim();
  if (createdValue && /T/.test(createdValue)) {
    const created = new Date(createdValue);
    if (!Number.isNaN(created.getTime())) return created;
  }
  const updatedValue = String(order.updatedAt || order.updated_at || "").trim();
  if (updatedValue) {
    const updated = new Date(updatedValue);
    if (!Number.isNaN(updated.getTime())) return updated;
  }
  return null;
}

function parseOrderCreatedDateTime(order = {}) {
  const createdValue = String(order.createdAt || order.created_at || "").trim();
  if (!createdValue) return null;
  const created = new Date(createdValue);
  return Number.isNaN(created.getTime()) ? null : created;
}

function isWithinOrderCycleHours(existingDateValue, payloadDateValue, hours) {
  if (!existingDateValue || !payloadDateValue) return false;
  const existingTime = existingDateValue instanceof Date ? existingDateValue.getTime() : new Date(existingDateValue).getTime();
  const payloadTime = payloadDateValue instanceof Date ? payloadDateValue.getTime() : new Date(payloadDateValue).getTime();
  if (Number.isNaN(existingTime) || Number.isNaN(payloadTime)) return false;
  return Math.abs(payloadTime - existingTime) <= Number(hours || 0) * 60 * 60 * 1000;
}

function isSameOrderDate(order = {}, payload = {}) {
  const orderDate = toDateOnly(order.date || order.order_date || "");
  const payloadDate = toDateOnly(payload.date || payload.order_date || "");
  return Boolean(orderDate && payloadDate && orderDate === payloadDate);
}

function isWithinCreatedOrderWindow(order = {}, payload = {}, hours) {
  if (!isSameOrderDate(order, payload)) return true;
  const orderCreatedAt = parseOrderCreatedDateTime(order);
  if (!orderCreatedAt) return true;
  const payloadCreatedAt = parseOrderCreatedDateTime(payload) || new Date();
  return isWithinOrderCycleHours(orderCreatedAt, payloadCreatedAt, hours);
}

function findExactDuplicateOrderWithin24Hours(db, payload = {}) {
  const payloadFields = normalizeDuplicateComparisonFields(payload);
  const payloadDateTime = parseOrderDateTime(payload) || new Date();
  return (db.orders || []).find(order => {
    const orderDateTime = parseOrderDateTime(order);
    if (!orderDateTime) return false;
    if (!isWithinOrderCycleHours(orderDateTime, payloadDateTime, 24)) return false;
    if (!isWithinCreatedOrderWindow(order, payload, 24)) return false;
    const existingFields = normalizeDuplicateComparisonFields(order);
    const matchedFields = Object.keys(payloadFields).filter(key => existingFields[key] === payloadFields[key]);
    if (matchedFields.length !== 5) return false;
    order.__duplicateMatch = {
      matchedFields,
      payload: payloadFields,
      existing: existingFields,
      payloadOrderDateTime: payloadDateTime.toISOString(),
      existingOrderDateTime: orderDateTime.toISOString()
    };
    return true;
  }) || null;
}

function sameBangkokCalendarDay(firstValue, secondValue) {
  const firstDate = toDateOnly(firstValue || "");
  const secondDate = toDateOnly(secondValue || "");
  return Boolean(firstDate && secondDate && firstDate === secondDate);
}

function findSimilarOrderCreatedToday(db, payload = {}, savedOrder = {}) {
  const payloadFields = normalizeDuplicateComparisonFields(payload);
  const savedCreatedAt = savedOrder.createdAt || savedOrder.created_at || new Date();
  return (db.orders || []).find(order => {
    if (order.id && savedOrder.id && order.id === savedOrder.id) return false;
    if (!sameBangkokCalendarDay(order.createdAt || order.created_at || "", savedCreatedAt)) return false;
    const existingFields = normalizeDuplicateComparisonFields(order);
    const matchedFields = Object.keys(payloadFields).filter(key => existingFields[key] === payloadFields[key]);
    if (matchedFields.length !== 5) return false;
    order.__duplicateMatch = {
      matchedFields,
      payload: payloadFields,
      existing: existingFields,
      payloadCreatedAt: toDateOnly(savedCreatedAt),
      existingCreatedAt: toDateOnly(order.createdAt || order.created_at || "")
    };
    return true;
  }) || null;
}

function secretInputValue(input, currentValue) {
  const value = String(input || "").trim();
  if (value === "__clear__") return "";
  if (!value || value === "__configured__") return currentValue || "";
  return value;
}

function ensurePasswordHash(user, password) {
  if (user.passwordHash) return false;
  if (user.password_hash) {
    user.passwordHash = user.password_hash;
    delete user.password_hash;
    return true;
  }
  const plain = String(password || user.password || user.pin || "");
  if (!plain) return false;
  user.passwordHash = hashPassword(plain);
  delete user.password;
  delete user.pin;
  return true;
}

function getCurrentUser(req) {
  return getSession(req)?.user || null;
}

function requireUser(req, res) {
  const user = getCurrentUser(req);
  if (!user) {
    json(res, 401, { ok: false, error: "กรุณาเข้าสู่ระบบ" });
    return null;
  }
  return user;
}

function sessionExpiredResponse(req, res) {
  destroySession(req);
  return json(res, 401, { ok: false, error: "เซสชันหมดอายุหรือผู้ใช้งานถูกปิดใช้งาน" }, {
    "Set-Cookie": clearSessionCookie()
  });
}

async function freshSessionUser(req, db = null) {
  const sessionUser = getCurrentUser(req);
  if (!sessionUser) return null;
  if (!db && typeof readUserById === "function") {
    const storedUser = await readUserById(sessionUser.id);
    if (!storedUser || storedUser.active === false) return null;
    return publicUser(storedUser);
  }
  const sourceDb = db || await readDb();
  return currentUserFromDb(sessionUser, sourceDb);
}

async function requireAdmin(req, res, db = null) {
  const sessionUser = requireUser(req, res);
  if (!sessionUser) return null;
  const user = await freshSessionUser(req, db);
  if (!user) {
    sessionExpiredResponse(req, res);
    return null;
  }
  if (!["Owner", "Admin"].includes(user.role)) {
    json(res, 403, { ok: false, error: "ต้องใช้สิทธิ์ Owner หรือ Admin" });
    return null;
  }
  return user;
}

async function requireOwner(req, res, db = null) {
  const sessionUser = requireUser(req, res);
  if (!sessionUser) return null;
  const user = await freshSessionUser(req, db);
  if (!user) {
    sessionExpiredResponse(req, res);
    return null;
  }
  if (user.role !== "Owner") {
    json(res, 403, { ok: false, error: "ต้องใช้สิทธิ์ Owner" });
    return null;
  }
  return user;
}

function hasPermission(user, dbOrSettings, permission) {
  if (!user) return false;
  if (user.role === "Owner") return true;
  const settings = dbOrSettings?.settings || dbOrSettings || {};
  return Boolean(permissionPayloadForRole(user.role, settings)[permission]);
}

async function requirePermission(req, res, db, permission, error = "ไม่มีสิทธิ์เข้าถึงส่วนนี้") {
  const sessionUser = requireUser(req, res);
  if (!sessionUser) return null;
  const sourceDb = db || await readDb();
  const user = currentUserFromDb(sessionUser, sourceDb);
  if (!user) {
    sessionExpiredResponse(req, res);
    return null;
  }
  if (!hasPermission(user, sourceDb, permission)) {
    json(res, 403, { ok: false, error });
    return null;
  }
  return user;
}

async function requirePermissionFast(req, res, permission, error = "ไม่มีสิทธิ์เข้าถึงส่วนนี้") {
  const sessionUser = requireUser(req, res);
  if (!sessionUser) return null;
  const user = typeof readUserById === "function" ? await readUserById(sessionUser.id) : null;
  if (!user || user.active === false) {
    sessionExpiredResponse(req, res);
    return null;
  }
  const settings = typeof readSettingsPatch === "function"
    ? await readSettingsPatch(["rolePermissions"])
    : {};
  if (!hasPermission(user, settings, permission)) {
    json(res, 403, { ok: false, error });
    return null;
  }
  return publicUser(user);
}

function normalizeUserRole(role) {
  return ["Owner", "Admin", "Staff"].includes(role) ? role : "Staff";
}

function activeOwnerCount(users = []) {
  return users.filter(user => user.role === "Owner" && user.active !== false).length;
}

function isLastActiveOwner(users = [], user) {
  return user?.role === "Owner" && user.active !== false && activeOwnerCount(users) <= 1;
}

function currentUserFromDb(sessionUser, db) {
  if (!sessionUser) return null;
  const storedUser = (db.users || []).find(user => user.id === sessionUser.id);
  if (!storedUser || storedUser.active === false) return null;
  return publicUser({
    ...storedUser,
    tenantId: sessionUser.tenantId || storedUser.tenantId || "",
    tenantName: sessionUser.tenantName || storedUser.tenantName || "",
    tenantRole: sessionUser.tenantRole || storedUser.tenantRole || ""
  });
}

function canManageUser(currentUser, targetUser = null, nextRole = "") {
  if (!currentUser) return false;
  if (currentUser.role === "Owner") return true;
  if (currentUser.role !== "Admin") return false;
  if (targetUser?.role === "Owner") return false;
  if (nextRole === "Owner") return false;
  return true;
}

function csvEscape(value) {
  const textValue = String(value ?? "");
  if (/[",\n]/.test(textValue)) return `"${textValue.replace(/"/g, '""')}"`;
  return textValue;
}

function csvResponse(res, filename, rows) {
  const headers = Object.keys(rows[0] || { empty: "" });
  const body = [
    headers.join(","),
    ...rows.map(row => headers.map(header => csvEscape(row[header])).join(","))
  ].join("\n");
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store"
  });
  res.end(`\uFEFF${body}`);
}

function importJobView(job) {
  if (!job) return null;
  const elapsedMs = Math.max(0, Date.now() - new Date(job.startedAt || job.createdAt).getTime());
  const processed = Number(job.processed || 0);
  const total = Number(job.total || 0);
  const remaining = Math.max(0, total - processed);
  const etaSeconds = processed > 0 && remaining > 0
    ? Math.ceil((elapsedMs / processed) * remaining / 1000)
    : 0;
  return {
    ...job,
    failedRows: undefined,
    percent: total ? Math.min(100, Math.round((processed / total) * 100)) : 0,
    etaSeconds,
    durationSeconds: Math.ceil((job.completedAt
      ? new Date(job.completedAt).getTime() - new Date(job.startedAt || job.createdAt).getTime()
      : elapsedMs) / 1000),
    canExportFailures: Number(job.failed || 0) > 0
  };
}

function importCleanupView(preview) {
  if (!preview) return null;
  return {
    job: importJobView(preview.job),
    orderCount: Number(preview.orderCount || 0),
    customerCount: Number(preview.customerCount || 0),
    settingsKeys: preview.settingsKeys || [],
    supported: preview.supported !== false
  };
}

async function handleImportJobsApi(req, res, url) {
  const sessionUser = requireUser(req, res);
  if (!sessionUser) return true;
  const currentUser = await freshSessionUser(req);
  if (!currentUser) {
    sessionExpiredResponse(req, res);
    return true;
  }
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/api/import-jobs/active") {
    const type = url.searchParams.get("type") || "orders";
    const job = await getActiveImportJob(type) || await getLatestImportJob(type);
    return json(res, 200, { ok: true, job: importJobView(job) });
  }

  if (req.method === "GET" && url.pathname === "/api/import-jobs/latest-cleanup-preview") {
    const db = await readDb();
    if (!await requirePermission(req, res, db, "system.danger", "ไม่มีสิทธิ์ล้างข้อมูลงานนำเข้า")) return true;
    const preview = await previewLatestImportCleanup(url.searchParams.get("type") || "orders");
    if (!preview) return json(res, 404, { ok: false, error: "ไม่พบงานนำเข้าล่าสุด" });
    return json(res, 200, { ok: true, preview: importCleanupView(preview) });
  }

  if (req.method === "POST" && url.pathname === "/api/import-jobs") {
    const db = await readDb();
    if (!await requirePermission(req, res, db, "customers.import", "ไม่มีสิทธิ์นำเข้าข้อมูล")) return true;
    const body = await readBody(req);
    const type = body.type || "orders";
    if (type !== "orders") return json(res, 400, { ok: false, error: "ประเภทการนำเข้ายังไม่รองรับ" });
    const total = Number(body.total || 0);
    if (!Number.isInteger(total) || total < 1) {
      return json(res, 400, { ok: false, error: "ไฟล์ไม่มีข้อมูลสำหรับนำเข้า" });
    }
    const active = await getActiveImportJob(type);
    if (active) {
      if (active.fingerprint === body.fingerprint && active.total === total) {
        if (active.processed >= active.total) {
          active.status = "completed";
          active.completedAt = active.completedAt || new Date().toISOString();
          active.lastError = "";
          await saveImportJob(active);
        }
        return json(res, 200, { ok: true, job: importJobView(active), resumed: true });
      }
      return json(res, 409, {
        ok: false,
        error: "มีงานนำเข้าออเดอร์กำลังทำงานอยู่",
        job: importJobView(active)
      });
    }
    const now = new Date().toISOString();
    const job = {
      id: uid("import"),
      type,
      entity: "Order",
      status: "queued",
      fileName: String(body.fileName || "orders.csv"),
      fileSize: Number(body.fileSize || 0),
      fingerprint: String(body.fingerprint || ""),
      total,
      processed: 0,
      imported: 0,
      skipped: 0,
      failed: 0,
      failedRows: [],
      importedOrderIds: [],
      importedCustomerIds: [],
      batchSize: Math.max(200, Math.min(500, Number(body.batchSize || 300))),
      createdAt: now,
      startedAt: now,
      completedAt: "",
      createdBy: currentUser.id
    };
    await saveImportJob(job);
    return json(res, 201, { ok: true, job: importJobView(job) });
  }

  const jobId = parts[2];
  if (!jobId) return false;
  const job = await getImportJob(jobId);
  if (!job) {
    json(res, 404, { ok: false, error: "ไม่พบงานนำเข้า" });
    return true;
  }

  if (req.method === "GET" && parts.length === 3) {
    json(res, 200, { ok: true, job: importJobView(job) });
    return true;
  }

  if (req.method === "POST" && parts[3] === "cleanup") {
    const db = await readDb();
    if (!await requirePermission(req, res, db, "system.danger", "ไม่มีสิทธิ์ล้างข้อมูลงานนำเข้า")) return true;
    try {
      const result = await cleanupImportJob(jobId);
      if (!result) return json(res, 404, { ok: false, error: "ไม่พบงานนำเข้า" });
      return json(res, 200, {
        ok: true,
        cleanup: {
          job: importJobView(result.job),
          deletedOrders: result.deletedOrders || 0,
          deletedCustomers: result.deletedCustomers || 0,
          deletedImportRecords: result.deletedImportRecords || 0,
          supported: result.supported !== false
        }
      });
    } catch (error) {
      return json(res, 400, { ok: false, error: error.message });
    }
  }

  if (req.method === "POST" && parts[3] === "cancel") {
    const db = await readDb();
    if (!await requirePermission(req, res, db, "customers.import", "ไม่มีสิทธิ์จัดการงานนำเข้า")) return true;
    if (["queued", "running", "paused"].includes(job.status)) {
      job.status = "cancelled";
      job.completedAt = new Date().toISOString();
      await saveImportJob(job);
    }
    json(res, 200, { ok: true, job: importJobView(job) });
    return true;
  }

  if (req.method === "POST" && parts[3] === "batches") {
    const db = await readDb();
    if (!await requirePermission(req, res, db, "customers.import", "ไม่มีสิทธิ์นำเข้าข้อมูล")) return true;
    if (!["queued", "running", "paused"].includes(job.status)) {
      json(res, 409, { ok: false, error: "งานนำเข้าไม่ได้อยู่ในสถานะทำงาน", job: importJobView(job) });
      return true;
    }
    const body = await readBody(req);
    const offset = Number(body.offset);
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!Number.isInteger(offset) || rows.length < 1 || rows.length > 500) {
      json(res, 400, { ok: false, error: "ข้อมูลชุดนำเข้าไม่ถูกต้อง" });
      return true;
    }
    if (offset < job.processed) {
      json(res, 200, { ok: true, job: importJobView(job), replayed: true });
      return true;
    }
    if (offset !== job.processed) {
      json(res, 409, { ok: false, error: "ลำดับชุดข้อมูลไม่ต่อเนื่อง", job: importJobView(job) });
      return true;
    }

    job.status = "running";
    try {
      const result = await importOrdersBatch(rows);
      job.processed += rows.length;
      job.imported += result.imported;
      job.skipped += result.skipped;
      job.failed += result.failed.length;
      job.failedRows.push(...result.failed);
      job.importedOrderIds = Array.from(new Set([...(job.importedOrderIds || []), ...(result.importedOrderIds || [])]));
      job.importedCustomerIds = Array.from(new Set([...(job.importedCustomerIds || []), ...(result.importedCustomerIds || [])]));
      if (job.processed >= job.total) {
        job.status = "completed";
        job.completedAt = new Date().toISOString();
      }
      await saveImportJob(job);
      json(res, 200, { ok: true, job: importJobView(job) });
    } catch (error) {
      job.status = "paused";
      job.lastError = error.message;
      await saveImportJob(job);
      json(res, 500, { ok: false, error: "งานนำเข้าหยุดชั่วคราวและสามารถทำต่อได้", job: importJobView(job) });
    }
    return true;
  }

  if (req.method === "GET" && parts[3] === "failed.csv") {
    const db = await readDb();
    if (!await requirePermission(req, res, db, "customers.import", "ไม่มีสิทธิ์ดาวน์โหลดไฟล์นำเข้า")) return true;
    const failedRows = (job.failedRows || []).map(item => ({
      rowNumber: item.rowNumber || "",
      error: item.error || "",
      ...item.row
    }));
    csvResponse(res, `failed-${job.fileName || "orders.csv"}`, failedRows);
    return true;
  }
  return false;
}

function vipLevel(totalSpent, settings = {}) {
  const thresholds = settings.vipThresholds || {};
  if (totalSpent >= Number(thresholds.superVip ?? 20000)) return "SUPER VIP";
  if (totalSpent >= Number(thresholds.vvip ?? 10000)) return "VVIP";
  if (totalSpent >= Number(thresholds.vip ?? 5000)) return "VIP";
  return "NORMAL";
}

function normalizedVipThresholds(body = {}, settings = {}) {
  const current = settings.vipThresholds || {};
  const thresholds = {
    vip: Number(body.vipThreshold ?? body.vip ?? current.vip ?? 5000),
    vvip: Number(body.vvipThreshold ?? body.vvip ?? current.vvip ?? 10000),
    superVip: Number(body.superVipThreshold ?? body.superVip ?? current.superVip ?? 20000)
  };
  if (
    !Number.isFinite(thresholds.vip) ||
    !Number.isFinite(thresholds.vvip) ||
    !Number.isFinite(thresholds.superVip) ||
    thresholds.vip < 0 ||
    thresholds.vvip < 0 ||
    thresholds.superVip < 0
  ) {
    return { ok: false, error: "กรุณากรอกยอดขั้นต่ำ VIP ให้ถูกต้อง" };
  }
  if (!(thresholds.vip < thresholds.vvip && thresholds.vvip < thresholds.superVip)) {
    return { ok: false, error: "ยอดขั้นต่ำต้องเรียงเป็น VIP < VVIP < SUPER VIP" };
  }
  return { ok: true, thresholds };
}

function followUpDaysPerUnit(settings = {}, rules = []) {
  const configured = Number(settings.followUpDaysPerUnit);
  if (configured > 0) return configured;
  const firstRule = [...rules]
    .map(rule => ({ jars: Number(rule.jars), days: Number(rule.days) }))
    .filter(rule => rule.jars > 0 && rule.days > 0)
    .sort((a, b) => a.jars - b.jars)[0];
  if (firstRule) return Math.max(1, Math.round(firstRule.days / firstRule.jars));
  return 15;
}

function buildFollowUpRules(daysPerUnit) {
  return [1, 2, 3, 4, 6, 10, 20].map(units => ({
    jars: units,
    days: units * daysPerUnit
  }));
}

function quantityFromText(value = "") {
  const textValue = String(value || "");
  const totalMatch = textValue.match(/(?:รวม|=)\s*(\d+)\s*กระปุก/i);
  if (totalMatch) return Number(totalMatch[1]);
  const plusFree = textValue.match(/(\d+)\s*(?:กระปุก|ปุก|ขวด)?\s*แถม\s*(\d+)\s*(?:กระปุก|ปุก|ขวด)?/i);
  if (plusFree) return Number(plusFree[1]) + Number(plusFree[2]);
  const unitMatch = textValue.match(/(\d+)\s*(?:กระปุก|ปุก|jar|jars|ขวด)/i);
  if (unitMatch) return Number(unitMatch[1]);
  return 0;
}

function totalUnitsReceived(order = {}) {
  const baseUnits = Number(order.jars || 0);
  const fromRawText = quantityFromText(order.rawText || order.raw_text || "");
  if (fromRawText > 0) return Math.max(baseUnits, fromRawText);
  const freeUnits = quantityFromText(order.freeGift || order.free_gift || "");
  return baseUnits + freeUnits;
}

function followUpDaysForUnits(units, settings, rules) {
  const daysPerUnit = followUpDaysPerUnit(settings, rules);
  return Math.max(daysPerUnit, Number(units || 0) * daysPerUnit || daysPerUnit);
}

function customerScore(totalSpent, purchaseCount, firstPurchaseDate, lastPurchaseDate) {
  if (!purchaseCount || !totalSpent) return 0;
  const activeDays = Math.max(30, diffDays(firstPurchaseDate, lastPurchaseDate) + 1);
  const frequencyPerMonth = purchaseCount / (activeDays / 30);
  return Math.round(totalSpent * purchaseCount * frequencyPerMonth);
}

function enrichDb(db, selectedDate = toDateOnly()) {
  synchronizeCustomers(db);
  const customers = db.customers.map(customer => {
    const orders = db.orders
      .filter(order => order.customerId === customer.id)
      .sort((a, b) => compareDate(a.date, b.date));
    const firstOrder = orders[0];
    const lastOrder = orders[orders.length - 1];
    const totalSpent = orders.reduce((sum, order) => sum + Number(order.amount || 0), 0);
    const totalJars = orders.reduce((sum, order) => sum + Number(order.jars || 0), 0);
    const purchaseCount = orders.length;
    const firstPurchaseDate = firstOrder?.date || "";
    const lastPurchaseDate = lastOrder?.date || "";
    const lastJars = totalUnitsReceived(lastOrder);
    const daysToNext = followUpDaysForUnits(lastJars, db.settings, db.followUpRules);
    const followUpDate = lastPurchaseDate ? addDays(lastPurchaseDate, daysToNext) : "";
    const overdueDays = followUpDate ? diffDays(followUpDate, selectedDate) : 0;
    const level = vipLevel(totalSpent, db.settings);
    const contactLogs = (db.contactLogs || [])
      .filter(log => log.customerId === customer.id)
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    let status = purchaseCount <= 1 ? "NEW" : "NORMAL";
    if (level !== "NORMAL") status = level;
    if (overdueDays > 90) status = "LOST";
    else if (overdueDays > 30) status = "AT RISK";
    const hasVipCard = orders.some(order => order.vipCardStatus === "ส่งบัตรแล้ว");

    return {
      ...customer,
      phone: normalizePhone(customer.phone),
      firstPurchaseDate,
      lastPurchaseDate,
      purchaseCount,
      totalJars,
      totalSpent,
      lastJars,
      followUpDate,
      overdueDays,
      status,
      vipLevel: level,
      customerScore: customerScore(totalSpent, purchaseCount, firstPurchaseDate, lastPurchaseDate),
      note: customer.note || customer.lastContactNote || "",
      contactLogs,
      orders: orders.map(order => {
        const sourceChannel = orderChannel(order);
        const vipDiscountEligible = hasVipCard && /ไลน์บริษัท|line company|บริษัท/i.test(sourceChannel);
        return {
          ...order,
          sourceChannel,
          socialName: order.socialName || order.social_name || "",
          freeGift: order.freeGift || order.free_gift || "",
          vipCardStatus: order.vipCardStatus || order.vip_card_status || "ยังไม่ได้ส่งบัตร",
          vipCardReminder: order.vipCardStatus !== "ส่งบัตรแล้ว" && !hasVipCard ? "ใส่บัตร VIP ในกล่อง" : "",
          vipDiscountFlag: vipDiscountEligible ? "ลูกค้ามีบัตร VIP และสั่งผ่านไลน์บริษัท: รองรับส่วนลด VIP กระปุกละ 10 บาท" : ""
        };
      })
    };
  });

  const vipCardSentByCustomer = new Map();
  for (const order of db.orders || []) {
    if (order.vipCardStatus === "ส่งบัตรแล้ว") vipCardSentByCustomer.set(order.customerId, true);
  }

  const allTags = Array.from(
    new Set([
      ...(db.tags || []),
      ...customers.flatMap(customer => customer.tags || [])
    ])
  ).sort((a, b) => a.localeCompare(b, "th"));

  return {
    ...db,
    tags: allTags,
    customers,
    orders: db.orders.map(order => {
      const customer = customers.find(item => item.id === order.customerId);
      const hasVipCard = vipCardSentByCustomer.get(order.customerId) || order.vipCardStatus === "ส่งบัตรแล้ว";
      const sourceChannel = orderChannel(order);
      const needsVipCard = order.vipCardStatus !== "ส่งบัตรแล้ว" && !hasVipCard;
      const vipDiscountEligible = hasVipCard && /ไลน์บริษัท|line company|บริษัท/i.test(sourceChannel);
      return {
        ...order,
        customerName: customer?.name || "",
        phone: customer?.phone || "",
        tags: customer?.tags || [],
        status: customer?.status || "",
        vipLevel: customer?.vipLevel || "NORMAL",
        sourceChannel,
        socialName: order.socialName || order.social_name || "",
        freeGift: order.freeGift || order.free_gift || "",
        vipCardStatus: order.vipCardStatus || order.vip_card_status || "ยังไม่ได้ส่งบัตร",
        vipCardReminder: needsVipCard ? "ใส่บัตร VIP ในกล่อง" : "",
        vipDiscountFlag: vipDiscountEligible ? "ลูกค้ามีบัตร VIP และสั่งผ่านไลน์บริษัท: รองรับส่วนลด VIP กระปุกละ 10 บาท" : ""
      };
    })
  };
}

function buildSummary(enriched, selectedDate = toDateOnly()) {
  const todayOrders = enriched.orders.filter(order => order.date === selectedDate);
  const monthKey = selectedDate.slice(0, 7);
  const monthOrders = enriched.orders.filter(order => String(order.date).startsWith(monthKey));
  const dueCustomers = enriched.customers.filter(customer => customer.followUpDate && customer.followUpDate <= selectedDate);

  return {
    selectedDate,
    salesToday: todayOrders.reduce((sum, order) => sum + Number(order.amount || 0), 0),
    salesThisMonth: monthOrders.reduce((sum, order) => sum + Number(order.amount || 0), 0),
    ordersToday: todayOrders.length,
    ordersThisMonth: monthOrders.length,
    jarsToday: todayOrders.reduce((sum, order) => sum + Number(order.jars || 0), 0),
    jarsThisMonth: monthOrders.reduce((sum, order) => sum + Number(order.jars || 0), 0),
    orderCount: enriched.orders.length,
    customerCount: enriched.customers.length,
    newCustomers: enriched.customers.filter(customer => customer.status === "NEW").length,
    vip: enriched.customers.filter(customer => customer.vipLevel === "VIP").length,
    vvip: enriched.customers.filter(customer => customer.vipLevel === "VVIP").length,
    superVip: enriched.customers.filter(customer => customer.vipLevel === "SUPER VIP").length,
    atRisk: enriched.customers.filter(customer => customer.status === "AT RISK").length,
    lost: enriched.customers.filter(customer => customer.status === "LOST").length,
    dueToday: dueCustomers.length,
    dueByPriority: {
      "SUPER VIP": dueCustomers.filter(customer => customer.vipLevel === "SUPER VIP").length,
      VVIP: dueCustomers.filter(customer => customer.vipLevel === "VVIP").length,
      VIP: dueCustomers.filter(customer => customer.vipLevel === "VIP").length,
      NORMAL: dueCustomers.filter(customer => customer.vipLevel === "NORMAL").length
    }
  };
}

function orderMutationPayload(db, { orderId = "", deletedOrderId = "", previousCustomerIds = [], selectedDate = toDateOnly() } = {}) {
  synchronizeCustomers(db);
  const order = orderId ? (db.orders || []).find(item => item.id === orderId) || null : null;
  const affectedCustomerIds = Array.from(new Set([
    ...previousCustomerIds,
    ...(order ? [order.customerId] : [])
  ].filter(Boolean)));
  const customerMap = new Map((db.customers || []).map(customer => [customer.id, customer]));
  const customers = affectedCustomerIds.map(id => {
    const customer = customerMap.get(id);
    if (!customer) return null;
    const customerOrders = (db.orders || [])
      .filter(item => item.customerId === id)
      .sort((a, b) => compareDate(a.date, b.date))
      .map(item => ({
        ...item,
        sourceChannel: orderChannel(item),
        socialName: item.socialName || item.social_name || "",
        freeGift: item.freeGift || item.free_gift || "",
        vipCardStatus: item.vipCardStatus || item.vip_card_status || "ยังไม่ได้ส่งบัตร"
      }));
    const hasVipCard = customerOrders.some(item => item.vipCardStatus === "ส่งบัตรแล้ว");
    const contactLogs = (db.contactLogs || [])
      .filter(log => log.customerId === id)
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    return {
      ...customer,
      overdueDays: customer.followUpDate ? diffDays(customer.followUpDate, selectedDate) : 0,
      note: customer.note || customer.lastContactNote || "",
      contactLogs,
      orders: customerOrders.map(item => ({
        ...item,
        tags: customer.tags || [],
        status: customer.status || "",
        vipLevel: customer.vipLevel || "NORMAL",
        vipCardReminder: item.vipCardStatus !== "ส่งบัตรแล้ว" && !hasVipCard ? "ใส่บัตร VIP ในกล่อง" : "",
        vipDiscountFlag: hasVipCard && /ไลน์บริษัท|line company|บริษัท/i.test(orderChannel(item))
          ? "ลูกค้ามีบัตร VIP และสั่งผ่านไลน์บริษัท: รองรับส่วนลด VIP กระปุกละ 10 บาท"
          : ""
      }))
    };
  }).filter(Boolean);
  const deletedCustomerIds = affectedCustomerIds.filter(id => !customerMap.has(id));
  return {
    order: order ? {
      ...order,
      customerName: customers.find(customer => customer.id === order.customerId)?.name || order.customerName || "",
      phone: order.phone || customers.find(customer => customer.id === order.customerId)?.phone || "",
      tags: customers.find(customer => customer.id === order.customerId)?.tags || [],
      status: customers.find(customer => customer.id === order.customerId)?.status || "",
      vipLevel: customers.find(customer => customer.id === order.customerId)?.vipLevel || "NORMAL",
      sourceChannel: orderChannel(order),
      socialName: order.socialName || order.social_name || "",
      freeGift: order.freeGift || order.free_gift || "",
      vipCardStatus: order.vipCardStatus || order.vip_card_status || "ยังไม่ได้ส่งบัตร"
    } : null,
    deletedOrderId,
    affectedCustomerIds,
    deletedCustomerIds,
    customers,
    tags: db.tags || [],
    settings: publicSettings(db.settings || {}),
    clientMutationId: ""
  };
}

function findOrCreateCustomer(db, payload) {
  const phone = normalizePhone(payload.phone);
  if (!phone) throw new Error("ต้องมีเบอร์โทรลูกค้า");
  let customer = db.customers.find(item => normalizePhone(item.phone) === phone);
  const nextTags = splitTags(payload.tags);

  if (!customer) {
    customer = {
      id: uid("c"),
      name: String(payload.name || `ลูกค้า ${phone}`).trim(),
      phone,
      address: String(payload.address || "").trim(),
      tags: nextTags,
      note: String(payload.note || "").trim(),
      createdAt: toDateOnly(payload.date || payload.createdAt || new Date()),
      lastContactDate: "",
      lastContactNote: "",
      assignedTo: payload.assignedTo || ""
    };
    db.customers.push(customer);
  } else {
    if (payload.name) customer.name = String(payload.name).trim();
    if (payload.address) customer.address = String(payload.address).trim();
    if (payload.note !== undefined) customer.note = String(payload.note || "").trim();
    if (nextTags.length) customer.tags = Array.from(new Set([...(customer.tags || []), ...nextTags]));
    if (payload.assignedTo) customer.assignedTo = payload.assignedTo;
  }

  if (nextTags.length) {
    db.tags = Array.from(new Set([...(db.tags || []), ...nextTags]));
  }

  return customer;
}

function addOrder(db, payload) {
  const resolvedPayload = applyResolvedProductToPayload(db.settings || {}, payload, {
    allowContainsMatch: Boolean(payload.allowProductContainsMatch)
  });
  const existingCustomer = payload.customerId
    ? db.customers.find(item => item.id === payload.customerId)
    : null;
  const customer = existingCustomer || findOrCreateCustomer(db, payload);

  if (!customer) throw new Error("ไม่พบลูกค้า");

  const jars = Number(payload.jars || 1);
  const amount = payload.amount !== undefined && payload.amount !== ""
    ? Number(payload.amount)
    : jars * Number(db.settings.defaultJarPrice || 750);
  const phone = normalizePhone(payload.phone || customer.phone || "");
  const previousVipCardSent = (db.orders || []).some(order =>
    order.customerId === customer.id && order.vipCardStatus === "ส่งบัตรแล้ว"
  );
  const vipCardStatus = String(
    payload.vipCardStatus || payload.vip_card_status || (previousVipCardSent ? "ส่งบัตรแล้ว" : "ยังไม่ได้ส่งบัตร")
  ).trim();
  const sourceChannel = orderChannel(payload);
  const originSource = normalizeOrderOriginSource(
    payload.originSource || payload.origin_source || "",
    payload.originSourceOther || payload.origin_source_other || ""
  );
  const vipDiscountFlag = previousVipCardSent && /ไลน์บริษัท|line company|บริษัท/i.test(sourceChannel)
    ? "ลูกค้ามีบัตร VIP และสั่งผ่านไลน์บริษัท: รองรับส่วนลด VIP กระปุกละ 10 บาท"
    : "";
  const note = [String(payload.note || "").trim(), vipDiscountFlag].filter(Boolean).join(" | ");
  const nowIso = new Date().toISOString();
  const order = {
    id: payload.id || uid("o"),
    customerId: customer.id,
    orderNumber: normalizeImportText(payload.orderNumber),
    items: resolvedPayload.items,
    customerName: normalizeImportText(payload.name || customer.name),
    phone,
    address: normalizeImportText(payload.address || customer.address),
    date: toDateOnly(payload.date || new Date()),
    time: String(payload.time || bangkokTime()),
    jars,
    amount,
    source: isPlaceholderChannel(payload.source) ? "" : String(payload.source || sourceChannel || "").trim(),
    sourceChannel,
    alternatePhone: String(payload.alternatePhone || payload.alternate_phone || "").trim(),
    originSource: originSource.originSource,
    originSourceOther: originSource.originSourceOther,
    lineMessageId: normalizeImportText(payload.lineMessageId || payload.line_message_id || ""),
    duplicateFingerprint: duplicateFingerprint(payload),
    socialName: String(payload.socialName || payload.social_name || "").trim(),
    freeGift: String(payload.freeGift || payload.free_gift || "").trim(),
    productId: String(resolvedPayload.productId || "").trim(),
    packageId: String(resolvedPayload.packageId || "").trim(),
    packageName: String(resolvedPayload.packageName || "").trim(),
    paidQuantity: Math.max(0, Number(resolvedPayload.paidQuantity || 0)),
    freeQuantity: Math.max(0, Number(resolvedPayload.freeQuantity || 0)),
    totalQuantityShipped: Math.max(0, Number(resolvedPayload.totalQuantityShipped || 0)),
    packageExpenses: normalizePackageExpenses(resolvedPayload.packageExpenses),
    vipCardStatus,
    note,
    rawText: String(payload.rawText || "").trim(),
    createdAt: nowIso,
    updatedAt: nowIso
  };

  applyOrderProfitSnapshot(order, db.settings || {}, "created");
  db.orders.push(order);
  return order;
}

function updateLineUpsaleOrder(db, order, payload = {}) {
  const previousOrder = { ...order };
  const existingProduct = resolveStoredProductForOrder(db.settings || {}, order);
  const customer = db.customers.find(item => item.id === order.customerId);
  const previousCustomer = customer ? { ...customer, tags: [...(customer.tags || [])] } : null;
  previousOrder.tags = previousCustomer?.tags || [];
  const nextTags = splitTags(payload.tags);
  try {
    if (customer) {
      if (payload.name) customer.name = String(payload.name).trim();
      if (payload.address) customer.address = String(payload.address).trim();
      if (payload.note !== undefined) customer.note = String(payload.note || "").trim();
      if (nextTags.length) customer.tags = Array.from(new Set([...(customer.tags || []), ...nextTags]));
    }
    if (nextTags.length) {
      db.tags = Array.from(new Set([...(db.tags || []), ...nextTags]));
    }
    const nextOriginSource = normalizeOrderOriginSource(
      payload.originSource || payload.origin_source || order.originSource || "",
      payload.originSourceOther || payload.origin_source_other || order.originSourceOther || ""
    );
    const nextSourceChannel = orderChannel(payload) || order.sourceChannel || "LINE";
    Object.assign(order, {
      orderNumber: normalizeImportText(payload.orderNumber || order.orderNumber),
      items: existingProduct.product.name,
      customerName: normalizeImportText(payload.name || order.customerName || customer?.name || ""),
      phone: normalizePhone(payload.phone || order.phone || customer?.phone || ""),
      address: normalizeImportText(payload.address || order.address || customer?.address || ""),
      date: payload.date ? toDateOnly(payload.date) : order.date,
      jars: payload.jars !== undefined ? Number(payload.jars || 1) : Number(order.jars || 1),
      amount: payload.amount !== undefined && payload.amount !== "" ? Number(payload.amount || 0) : Number(order.amount || 0),
      source: isPlaceholderChannel(payload.source) ? order.source : String(payload.source || order.source || nextSourceChannel || "").trim(),
      sourceChannel: nextSourceChannel,
      alternatePhone: payload.alternatePhone ?? payload.alternate_phone ?? order.alternatePhone,
      originSource: nextOriginSource.originSource,
      originSourceOther: nextOriginSource.originSourceOther,
      lineMessageId: normalizeImportText(payload.lineMessageId || payload.line_message_id || order.lineMessageId || ""),
      duplicateFingerprint: duplicateFingerprint(payload),
      socialName: String(payload.socialName || payload.social_name || order.socialName || "").trim(),
      freeGift: String(payload.freeGift ?? payload.free_gift ?? order.freeGift ?? "").trim(),
      productId: String(existingProduct.product.id || order.productId || "").trim(),
      packageId: String(existingProduct.package?.id || order.packageId || "").trim(),
      packageName: String(existingProduct.package?.name || order.packageName || "").trim(),
      paidQuantity: payload.paidQuantity !== undefined ? Math.max(0, Number(payload.paidQuantity || 0)) : Number(order.paidQuantity || 0),
      freeQuantity: payload.freeQuantity !== undefined ? Math.max(0, Number(payload.freeQuantity || 0)) : Number(order.freeQuantity || 0),
      totalQuantityShipped: payload.totalQuantityShipped !== undefined
        ? Math.max(0, Number(payload.totalQuantityShipped || 0))
        : Number(order.totalQuantityShipped || 0),
      packageExpenses: payload.packageExpenses !== undefined ? normalizePackageExpenses(payload.packageExpenses) : normalizePackageExpenses(order.packageExpenses),
      vipCardStatus: String(payload.vipCardStatus || payload.vip_card_status || order.vipCardStatus || "ยังไม่ได้ส่งบัตร").trim(),
      note: String(payload.note ?? order.note ?? "").trim(),
      rawText: String(payload.rawText || order.rawText || "").trim(),
      updatedAt: new Date().toISOString()
    });
    order.tags = customer?.tags || previousOrder.tags || [];
    applyOrderProfitSnapshot(order, db.settings || {}, "edited");
    const changes = collectOrderChanges(previousOrder, order);
    delete order.tags;
    adjustInventoryForOrderChange(db, previousOrder, order);
    return { order, previousOrder, changes };
  } catch (error) {
    Object.assign(order, previousOrder);
    delete order.tags;
    if (customer && previousCustomer) Object.assign(customer, previousCustomer);
    throw error;
  }
}

function findDuplicateOrder(db, payload = {}) {
  const recentExactDuplicate = findExactDuplicateOrderWithin24Hours(db, payload);
  if (recentExactDuplicate) return recentExactDuplicate;
  return null;
}

function orderNumberKey(value) {
  return normalizeImportText(value).toLowerCase();
}

function sameOrderCustomerIdentity(order = {}, payload = {}) {
  const orderPhone = normalizePhone(order.phone || "");
  const payloadPhone = normalizePhone(payload.phone || "");
  if (orderPhone && payloadPhone && orderPhone === payloadPhone) return true;
  const orderCustomerId = normalizeImportText(order.customerId || order.customer_id || "");
  const payloadCustomerId = normalizeImportText(payload.customerId || payload.customer_id || "");
  return Boolean(orderCustomerId && payloadCustomerId && orderCustomerId === payloadCustomerId);
}

function isWithinPreviousHours(dateValue, hours, now = new Date()) {
  if (!dateValue) return false;
  const timestamp = dateValue instanceof Date ? dateValue.getTime() : new Date(dateValue).getTime();
  if (Number.isNaN(timestamp)) return false;
  const current = now.getTime();
  return timestamp <= current && timestamp >= current - (Number(hours || 0) * 60 * 60 * 1000);
}

function findLineUpsaleOrder(db, payload = {}) {
  const targetOrderNumber = orderNumberKey(payload.orderNumber || payload.order_number || "");
  if (!targetOrderNumber) return null;
  const payloadDateTime = parseOrderDateTime(payload) || new Date();
  return (db.orders || []).find(order => {
    if (orderNumberKey(order.orderNumber || order.order_number || "") !== targetOrderNumber) return false;
    if (!sameOrderCustomerIdentity(order, payload)) return false;
    if (!isWithinOrderCycleHours(parseOrderDateTime(order), payloadDateTime, 24)) return false;
    return isWithinCreatedOrderWindow(order, payload, 24);
  }) || null;
}

function lineMessageIdFromEventMessage(message = {}) {
  return normalizeImportText(message?.id || message?.messageId || message?.message_id || "");
}

function isDuplicateLineMessage(db, messageId = "") {
  const normalizedId = normalizeImportText(messageId);
  if (!normalizedId) return false;
  const orderMatch = (db.orders || []).some(order =>
    normalizeImportText(order.lineMessageId || order.line_message_id || "") === normalizedId
  );
  if (orderMatch) return true;
  return (db.lineMessages || []).some(message => {
    const rawMessageId = lineMessageIdFromEventMessage(message.rawEvent?.message || message.rawEvent?.rawEvent?.message || {});
    return rawMessageId === normalizedId;
  });
}

function valueForChange(value) {
  if (Array.isArray(value)) return value.map(item => String(item || "").trim()).filter(Boolean).join(", ");
  return normalizeImportText(value);
}

function numberForChange(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function collectOrderChanges(before = {}, after = {}) {
  const specs = [
    { key: "jars", label: "📦 Quantity", type: "number", oldValue: before.jars, newValue: after.jars },
    { key: "amount", label: "💰 Amount", type: "money", oldValue: before.amount, newValue: after.amount },
    { key: "freeGift", label: "🎁 Gift", oldValue: before.freeGift, newValue: after.freeGift },
    { key: "address", label: "🏠 Shipping Address", oldValue: before.address, newValue: after.address },
    { key: "tags", label: "🏷️ Customer Symptoms", oldValue: before.tags, newValue: after.tags },
    { key: "vipCardStatus", label: "💳 VIP Status", oldValue: before.vipCardStatus, newValue: after.vipCardStatus },
    { key: "sourceChannel", label: "🛒 Sales Channel", oldValue: before.sourceChannel, newValue: after.sourceChannel },
    { key: "originSource", label: "📣 Origin Source", oldValue: before.originSource, newValue: after.originSource },
    { key: "socialName", label: "👤 Customer Social", oldValue: before.socialName, newValue: after.socialName },
    { key: "alternatePhone", label: "☎️ Alternate Phone", oldValue: before.alternatePhone, newValue: after.alternatePhone },
    { key: "items", label: "🧾 Product", oldValue: before.items, newValue: after.items },
    { key: "note", label: "📝 Note", oldValue: before.note, newValue: after.note }
  ];
  return specs
    .map(spec => {
      const oldComparable = spec.type ? numberForChange(spec.oldValue) : valueForChange(spec.oldValue);
      const newComparable = spec.type ? numberForChange(spec.newValue) : valueForChange(spec.newValue);
      if (oldComparable === newComparable) return null;
      return { ...spec, oldComparable, newComparable };
    })
    .filter(Boolean);
}

function displayChangeValue(value) {
  const normalized = valueForChange(value);
  return normalized || "None";
}

function signedDelta(oldValue, newValue) {
  const delta = numberForChange(newValue) - numberForChange(oldValue);
  if (!delta) return "";
  return ` (${delta > 0 ? "+" : ""}${delta.toLocaleString("en-US")})`;
}

function formatUpsaleReply(order = {}, changes = []) {
  const changeByKey = new Map(changes.map(change => [change.key, change]));
  const quantityChange = changeByKey.get("jars");
  const amountChange = changeByKey.get("amount");
  const giftChange = changeByKey.get("freeGift");
  const noteChange = changeByKey.get("note");
  const lines = [
    "✅ อัปเดตออเดอร์อัปเซลเรียบร้อยแล้ว",
    "",
    `เลขออเดอร์: ${order.orderNumber || "-"}`
  ];
  if (quantityChange) {
    lines.push(
      "",
      "📦 จำนวน",
      `• ${numberForChange(quantityChange.oldValue).toLocaleString("en-US")} → ${numberForChange(quantityChange.newValue).toLocaleString("en-US")}${signedDelta(quantityChange.oldValue, quantityChange.newValue)}`
    );
  }
  if (amountChange) {
    const amountDelta = numberForChange(amountChange.newValue) - numberForChange(amountChange.oldValue);
    lines.push(
      "",
      "💰 ยอดซื้อ",
      `• ${numberForChange(amountChange.oldValue).toLocaleString("en-US")} → ${numberForChange(amountChange.newValue).toLocaleString("en-US")} บาท${signedDelta(amountChange.oldValue, amountChange.newValue)}`,
      "",
      "📈 เพิ่มยอดขาย",
      `• ${amountDelta > 0 ? "+" : ""}${amountDelta.toLocaleString("en-US")} บาท`
    );
  }
  if (giftChange) {
    lines.push(
      "",
      "🎁 ของแถม",
      `• ${displayChangeValue(giftChange.oldValue)} → ${displayChangeValue(giftChange.newValue)}`
    );
  }
  if (noteChange) {
    lines.push(
      "",
      "📝 หมายเหตุ",
      `• ${displayChangeValue(noteChange.newValue)}`
    );
  }
  lines.push(
    "",
    "Growup Pilot ได้อัปเดตออเดอร์เดิมและปรับสต็อกเฉพาะส่วนต่างเรียบร้อยแล้ว"
  );
  return lines.join("\n");
}

function missingRequiredOrderFields(order = {}) {
  const required = [
    ["Customer Name", order.name || order.customerName],
    ["Shipping Address", order.address],
    ["Phone Number", order.phone],
    ["Quantity", order.jars ?? order.quantity],
    ["Total Amount", order.amount]
  ];
  return required.filter(([, value]) => !normalizeImportText(value) && value !== 0).map(([label]) => label);
}

function parseCurrency(textValue) {
  const value = String(textValue || "");
  if (/ของฟรี|ฟรี/.test(value) && !/[0-9][0-9,]*\s*(?:บาท|฿|THB)/i.test(value)) return 0;
  const labelled = value.match(/(?:ยอด|ราคา|รวม|amount|price)\s*[:：-]?\s*([0-9][0-9,]*)/i);
  const cod = value.match(/(?:เก็บเงินปลายทาง|cod)\s*([0-9][0-9,]*)/i);
  const money = value.match(/([0-9][0-9,]*)\s*(?:บาท|฿|THB)/i);
  const match = labelled || cod || money;
  if (!match) return null;
  return Number(match[1].replace(/,/g, ""));
}

function parseQuantity(textValue) {
  const value = String(textValue || "");
  const freeOnly = value.match(/(?:รับ)?โซมินฟรี\s*(\d+)\s*กระปุก/);
  if (freeOnly) return Number(freeOnly[1]);
  const plusFree = value.match(/(\d+)\s*(?:กระปุก|ปุก|ขวด)?\s*แถม\s*(\d+)\s*(?:กระปุก|ปุก|ขวด)?/);
  if (plusFree) return Number(plusFree[1]) + Number(plusFree[2]);
  const jarMatch = value.match(/(\d+)\s*(?:กระปุก|ปุก|jar|jars|ขวด)/i);
  if (jarMatch) return Number(jarMatch[1]);
  return 1;
}

function shouldSkipLineImport(textValue) {
  return /^(รูป|ยกเลิกข้อความ|แก้ไขเลขออเดอร์)$/i.test(String(textValue || "").trim());
}

function splitLineImportChunks(content) {
  return String(content || "")
    .split(/\n-{3,}\n|\n\n+/)
    .map(chunk => chunk.trim())
    .filter(Boolean);
}

function parseLineImportContent(content, defaultJarPrice = 750) {
  const text = String(content || "").trim();
  if (!text) return [];
  if (parsePrimaryLineOrderForm(text)) {
    const parsed = parseLineOrder(text, defaultJarPrice);
    return parsed?.phone ? [parsed] : [];
  }
  const phoneMatches = text.match(/0[\d\s.-]{8,12}/g) || [];
  if (phoneMatches.length <= 1) {
    const parsed = parseLineOrder(text, defaultJarPrice);
    return parsed?.phone ? [parsed] : [];
  }

  return splitLineImportChunks(text)
    .map(chunk => parseLineOrder(chunk, defaultJarPrice))
    .filter(parsed => parsed?.phone);
}

function parseLabel(textValue, labels) {
  const escapedLabels = labels.map(label => String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(?:${escapedLabels.join("|")})\\s*[:：-]\\s*([^\\n]+)`, "i");
  return String(textValue || "").match(pattern)?.[1]?.trim() || "";
}

const PRIMARY_LINE_ORDER_FIELDS = [
  ["items", "สินค้า"],
  ["orderNumber", "เลขออเดอร์"],
  ["date", "วันที่ซื้อ"],
  ["sourceChannel", "ช่องทางการสั่งซื้อ"],
  ["socialName", "Facebook / LINE ลูกค้า"],
  ["name", "ชื่อลูกค้า"],
  ["phone", "เบอร์โทร"],
  ["alternatePhone", "เบอร์โทรสำรอง"],
  ["address", "ที่อยู่จัดส่ง"],
  ["jars", "จำนวน", ["จำนวนกระปุก"]],
  ["amount", "ยอดซื้อ"],
  ["originSource", "ช่องทางการขาย", ["ลูกค้ามาจาก"]],
  ["freeGift", "ของแถมที่ลูกค้าได้"],
  ["vipCardStatus", "สถานะบัตร VIP"],
  ["tags", "อาการลูกค้า"],
  ["note", "หมายเหตุ"]
];

function parsePrimaryLineOrderForm(rawText) {
  const textValue = String(rawText || "").trim();
  if (!textValue) return null;
  const lines = textValue.split(/\n+/).map(line => line.trim()).filter(Boolean);
  const fieldLabels = PRIMARY_LINE_ORDER_FIELDS.map(([key, label, aliases = []]) => ({
    key,
    labels: [label, ...aliases]
  }));
  const labels = fieldLabels.flatMap(field => field.labels);
  const isFieldLabelLine = lineValue => labels.some(label => {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escapedLabel}\\s*(?:[:：]|$)`, "i").test(lineValue);
  });
  const labelMap = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const matchedField = fieldLabels.find(field => field.labels.some(label => {
      const normalizedLine = line.toLowerCase();
      const normalizedLabel = label.toLowerCase();
      const escapedLabel = normalizedLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return normalizedLine === normalizedLabel
        || new RegExp(`^${escapedLabel}\\s*[:：]`).test(normalizedLine);
    }));
    if (!matchedField) continue;
    const matchedLabel = matchedField.labels.find(label => {
      const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`^${escapedLabel}\\s*(?:[:：]|$)`, "i").test(line);
    }) || matchedField.labels[0];
    const inlineValue = line.slice(matchedLabel.length).replace(/^\s*[:：]\s*/, "").trim();
    const valueLines = inlineValue ? [inlineValue] : [];
    let cursor = index + 1;
    while (cursor < lines.length && !isFieldLabelLine(lines[cursor])) {
      valueLines.push(lines[cursor]);
      cursor += 1;
    }
    labelMap.set(matchedField.key, valueLines.join("\n").trim());
  }
  if (!labelMap.size) return null;
  const requiredKeys = ["date", "name", "phone", "address", "jars", "amount"];
  const hasPrimaryShape = requiredKeys.every(key => labelMap.has(key));
  if (!hasPrimaryShape) return null;
  const get = key => String(labelMap.get(key) || "").trim();
  const phone = normalizePhone(get("phone"));
  if (!phone) return null;
  return {
    items: normalizeProductNameForMatching(get("items")),
    orderNumber: normalizeImportText(get("orderNumber")),
    name: normalizeImportText(get("name") || `ลูกค้า ${phone}`),
    phone,
    alternatePhone: normalizePhone(get("alternatePhone")),
    address: normalizeImportText(get("address")),
    date: normalizeImportDate(get("date")) || toDateOnly(),
    jars: Number(get("jars").replace(/[^\d.]/g, "")) || parseQuantity(get("jars")) || 1,
    amount: get("amount")
      ? parseCurrency(get("amount")) ?? Number(get("amount").replace(/,/g, "").replace(/[^\d.]/g, ""))
      : null,
    source: "LINE",
    sourceChannel: normalizeImportText(get("sourceChannel") || "LINE"),
    originSource: normalizeImportText(get("originSource")),
    socialName: normalizeImportText(get("socialName")),
    freeGift: normalizeImportText(get("freeGift")),
    vipCardStatus: normalizeImportText(get("vipCardStatus") || "ยังไม่ได้ส่งบัตร") || "ยังไม่ได้ส่งบัตร",
    tags: splitTags(get("tags")),
    note: normalizeImportText(get("note")),
    rawText: textValue
  };
}

function parseSourceChannel(textValue) {
  const explicit = parseLabel(textValue, ["ช่องทาง", "ช่องทางสั่ง", "สั่งจาก", "source_channel", "source"]);
  if (explicit) return explicit;
  if (/ไลน์บริษัท|line company/i.test(textValue)) return "ไลน์บริษัท";
  if (/line oa|ไลน์ oa/i.test(textValue)) return "LINE OA";
  if (/โทรสั่ง|โทรคอนเฟิร์ม|คอนเฟิร์มแล้ว|โทรสั่งแล้ว|โทร\s*สั่ง/i.test(textValue)) return "โทรสั่ง";
  if (/facebook|เฟส|เพจ/i.test(textValue)) return "Facebook";
  if (/line|ไลน์/i.test(textValue)) return "LINE";
  return "LINE";
}

function parseSocialName(textValue) {
  const explicit = parseLabel(textValue, ["ชื่อเฟส", "ชื่อไลน์", "เฟส", "ไลน์", "social_name", "social"]);
  if (explicit) return explicit;
  const fbLine = String(textValue || "").match(/(?:^|\n)\s*(?:F|FB|LINE)\s*[:：]\s*([^\n]+)/i);
  if (fbLine) return fbLine[0].trim();
  return "";
}

function parseFreeGift(textValue) {
  const explicit = parseLabel(textValue, ["ของแถม", "free_gift"]);
  if (explicit) return explicit;
  const value = String(textValue || "");
  const giftKeywords = [
    "กระบอกน้ำ",
    "นาฬิกา",
    "งาดำชง",
    "เซตผ้าเช็ดตัว",
    "ผ้าเช็ดตัว",
    "ของพรีเมียม"
  ];
  const giftLine = value
    .split(/\n+/)
    .map(line => line.trim())
    .find(line => giftKeywords.some(keyword => line.includes(keyword)));
  if (giftLine) return giftLine;
  const giftMatch = value.match(/(?:ของแถม|ฟรีของแถม|รับของแถม)\s*[:：-]?\s*([^\n]+)/i);
  return giftMatch?.[1]?.trim() || "";
}

function parseLineOrder(rawText, defaultJarPrice = 750) {
  const textValue = String(rawText || "").trim();
  if (shouldSkipLineImport(textValue)) return null;
  const primary = parsePrimaryLineOrderForm(textValue);
  if (primary) {
    return {
      ...primary,
      amount: Number.isFinite(Number(primary.amount)) && primary.amount !== ""
        ? Number(primary.amount)
        : Number(primary.jars || 1) * Number(defaultJarPrice || 750)
    };
  }
  const lines = textValue.split(/\n+/).map(line => line.trim()).filter(Boolean);
  const phoneLine = lines.find(line => /โทร|เบอร์|phone|mobile|tel/i.test(line) && /\d/.test(line)) || lines.find(line => /^0[\d\s.-]{8,12}$/.test(line.replace(/[^\d\s.-]/g, "")));
  const phoneMatch = phoneLine?.match(/0\d{8,9}/) || textValue.match(/(?<!\d)0\d{8,9}(?!\d)/);
  const phone = normalizePhone(phoneMatch?.[0] || "");
  if (!phone) return null;
  const jars = parseQuantity(textValue);
  const parsedAmount = parseCurrency(textValue);
  const amount = parsedAmount === null ? jars * Number(defaultJarPrice || 750) : parsedAmount;
  const dateMatch = textValue.match(/(20\d{2})[-/](\d{1,2})[-/](\d{1,2})/);
  const date = dateMatch
    ? `${dateMatch[1]}-${String(dateMatch[2]).padStart(2, "0")}-${String(dateMatch[3]).padStart(2, "0")}`
    : toDateOnly();
  const addressLine = textValue
    .split(/\n+/)
    .find(line => /(ที่อยู่|ต\.|อ\.|จ\.|แขวง|เขต|ถนน|หมู่|ม\.)/.test(line));
  const explicitNameLine = lines.find(line => /^(?:คุณ|ชื่อ|ลูกค้า)\b/i.test(line) || /(?:^|\s)(?:คุณ|ชื่อ|ลูกค้า)\s*[:：-]/i.test(line));
  const explicitName = explicitNameLine?.match(/(?:คุณ|ชื่อ|ลูกค้า)\s*[:：-]?\s*([^\n,]+)/i);
  const firstLine = lines.find(line => line && !line.match(/^(?:f|fb|line)\s*[:：]/i) && !/โทร|เบอร์|phone|mobile|tel/i.test(line) && !/(?:\d[\d\s.-]*){9,}/.test(line));
  const name = (explicitName?.[1] || firstLine || `ลูกค้า ${phone}`)
    .replace(/^(ชื่อ|ลูกค้า)\s*[:：-]?\s*/i, "")
    .replace(/^คุณ\s*/i, "")
    .trim();
  const tagMatches = Array.from(textValue.matchAll(/#([^\s#]+)/g)).map(match => match[1].trim());
  const promoQuantityLine = lines.find(line => /\d+\s*(?:กระปุก|ปุก|ขวด)?\s*แถม\s*\d+\s*(?:กระปุก|ปุก|ขวด)?/.test(line));
  const note = promoQuantityLine ? promoQuantityLine : "";
  const orderNumber = parseLabel(textValue, ["เลขออเดอร์", "order number", "order_number"]) || "";
  const productName = parseLabel(textValue, ["สินค้า", "ชื่อสินค้า", "product", "product_name"]) || "";

  return {
    items: normalizeProductNameForMatching(productName),
    orderNumber: normalizeImportText(orderNumber),
    name,
    phone,
    address: addressLine ? addressLine.replace(/^ที่อยู่\s*[:：-]?\s*/, "").trim() : "",
    date,
    jars,
    amount,
    tags: tagMatches,
    source: "LINE",
    sourceChannel: parseSourceChannel(textValue),
    originSource: normalizeImportText(parseLabel(textValue, ["ช่องทางการขาย", "ลูกค้ามาจาก", "origin_source", "origin source", "มาจาก", "แหล่งที่มา"])),
    socialName: parseSocialName(textValue),
    freeGift: parseFreeGift(textValue),
    note,
    vipCardStatus: parseLabel(textValue, ["สถานะบัตร VIP", "vip_card_status", "บัตร VIP"]) || "ยังไม่ได้ส่งบัตร",
    rawText: textValue
  };
}

function extractLineWebhookContext(event = {}) {
  return {
    replyToken: event.replyToken || "",
    source: event.source || {},
    text: event.message?.text || "",
    messageId: event.message?.id || ""
  };
}

function isTargetGroup(eventSource = {}, settings = {}) {
  if (eventSource.type !== "group") return false;
  const configuredGroupId = normalizeImportText(settings.lineGroupId || "");
  if (!configuredGroupId) return true;
  return String(eventSource.groupId || "") === configuredGroupId;
}

function formatMissingFieldsMessage(fields) {
  return fields.join("\n");
}

function lineEventLogPayload(event = {}, text = "") {
  const source = event.source || {};
  return {
    eventType: event.type || "",
    messageType: event.message?.type || "",
    sourceType: source.type || "",
    groupId: source.groupId || "",
    userId: source.userId || "",
    text: String(text || "").slice(0, 500)
  };
}

function safeDiagnosticErrorMessage(value = "") {
  return String(value || "")
    .replace(/0\d{8,9}/g, "[redacted-phone]")
    .replace(/[A-Za-z0-9_-]{80,}/g, "[redacted-long-token]")
    .slice(0, 300);
}

function safeDatabaseErrorDetails(error = {}) {
  const message = safeDiagnosticErrorMessage(error.message || String(error));
  const statusMatch = message.match(/\brequest failed:\s*(\d{3})\b/i);
  const tableMatch = message.match(/Supabase\s+([a-z_]+)\s+request failed/i);
  const constraintMatch = message.match(/constraint\s+"([^"]+)"/i);
  return {
    code: String(error.code || ""),
    status: statusMatch?.[1] || String(error.status || ""),
    table: tableMatch?.[1] || String(error.table || ""),
    constraint: constraintMatch?.[1] || String(error.constraint || ""),
    message
  };
}

function safePersistedOrderDiagnostics(orders = []) {
  return (orders || []).map(order => ({
    id: order.id || "",
    lineMessageId: order.lineMessageId || "",
    amount: order.amount,
    date: order.date || "",
    mode: order.mode || ""
  }));
}

function lineDebugFromMessage(message = {}) {
  const event = message.rawEvent || {};
  const source = event.source || {};
  const debug = event.__debug || {};
  const httpDebug = event.__httpDebug || {};
  return {
    id: message.id || "",
    received_at: message.receivedAt || debug.received_at || httpDebug.received_at || "",
    event_type: event.type || debug.event_type || httpDebug.event_type || "",
    source_type: source.type || debug.source_type || httpDebug.source_type || "",
    groupId: source.groupId || debug.groupId || "",
    userId: source.userId || debug.userId || "",
    text: message.text || message.raw_text || debug.text || httpDebug.text || "",
    parser_status: debug.parser_status || "not_run",
    supabase_insert_status: debug.supabase_insert_status || "not_run",
    error_message: debug.error_message || httpDebug.error_message || "",
    http_method: httpDebug.method || "",
    http_body_length: httpDebug.body_length ?? "",
    http_user_agent: httpDebug.user_agent || "",
    http_reached_handler: httpDebug.reached_handler === true,
    http_is_line_request: httpDebug.is_line_request === true,
    http_signature_validation: httpDebug.signature_validation || ""
  };
}

function lineDebugSummary(rows = []) {
  const httpRows = rows.filter(row => row.http_reached_handler);
  const lastHttp = httpRows[0] || null;
  const lastLine = httpRows.find(row => row.http_is_line_request) || null;
  return {
    last_http_request_received: lastHttp?.received_at || "",
    last_http_method: lastHttp?.http_method || "",
    last_http_body_length: lastHttp?.http_body_length ?? "",
    last_http_user_agent: lastHttp?.http_user_agent || "",
    line_request_seen: Boolean(lastLine),
    signature_validation: lastLine?.http_signature_validation || lastHttp?.http_signature_validation || "not_seen"
  };
}

function safeHeader(req, name) {
  const value = req.headers[String(name).toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : String(value || "");
}

function addHttpWebhookDebug(db, req, rawBody = "", status = {}) {
  const signature = safeHeader(req, "x-line-signature");
  const userAgent = safeHeader(req, "user-agent");
  const receivedAt = new Date().toISOString();
  const isLineRequest = Boolean(signature) || /line/i.test(userAgent);
  const debug = {
    received_at: receivedAt,
    event_type: "http_request",
    source_type: "http",
    method: req.method || "",
    path: "/api/line/webhook",
    body_length: Buffer.byteLength(String(rawBody || ""), "utf8"),
    user_agent: userAgent.slice(0, 300),
    content_type: safeHeader(req, "content-type").slice(0, 120),
    has_line_signature: Boolean(signature),
    is_line_request: isLineRequest,
    signature_validation: status.signatureValidation || "not_checked",
    reached_handler: true,
    text: `${req.method || ""} /api/line/webhook body=${Buffer.byteLength(String(rawBody || ""), "utf8")}`,
    error_message: status.errorMessage || ""
  };
  db.lineMessages = db.lineMessages || [];
  db.lineMessages.push({
    id: uid("line_http"),
    receivedAt,
    rawEvent: { __httpDebug: debug },
    text: debug.text,
    raw_text: debug.text
  });
  console.log("LINE webhook HTTP request", JSON.stringify({
    method: debug.method,
    bodyLength: debug.body_length,
    isLineRequest: debug.is_line_request,
    signatureValidation: debug.signature_validation,
    receivedAt
  }));
  return debug;
}

function persistWebhookDebugAsync(db) {
  setImmediate(() => {
    writeDb(db).catch(error => {
      console.error("LINE webhook debug write failed:", error);
    });
  });
}

function isLineVerifyRequest(body = {}) {
  if (!Array.isArray(body.events)) return false;
  if (body.events.length === 0) return true;
  return body.events.every(event => !event?.message);
}

function looksLikeOrderMessage(textValue = "") {
  const text = String(textValue || "");
  if (parsePrimaryLineOrderForm(text)) return true;
  const hasPhone = /(?<!\d)0\d{8,9}(?!\d)/.test(text);
  const hasAmount = /(?:ยอด|ราคา|รวม|amount|price|cod|เก็บเงินปลายทาง|บาท|฿|THB)/i.test(text);
  const hasQuantity = /(?:\d+\s*(?:กระปุก|ปุก|jar|jars|ขวด)|จำนวน|qty|quantity)/i.test(text);
  const hasAddress = /(ที่อยู่|ต\.|อ\.|จ\.|แขวง|เขต|ถนน|หมู่|ม\.)/.test(text);
  return hasPhone && (hasAmount || hasQuantity || hasAddress);
}

async function lineApiRequest(pathname, { method = "POST", body } = {}, accessToken) {
  const res = await fetch(`https://api.line.me${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`LINE API request failed: ${res.status} ${detail}`);
  }
  return res.status === 204 ? null : res.json();
}

async function replyLineMessages(settings, replyToken, messages) {
  if (!replyToken) return;
  const accessToken = settings.lineChannelAccessToken;
  if (!accessToken) return;
  await lineApiRequest("/v2/bot/message/reply", {
    body: { replyToken, messages }
  }, accessToken);
}

function normalizedOrderForStorage(parsed = {}) {
  return {
    ...parsed,
    items: normalizeProductNameForMatching(parsed.items || parsed.product || parsed.productName || ""),
    name: parsed.name || parsed.customerName || "",
    phone: normalizePhone(parsed.phone || ""),
    amount: Number(parsed.amount || 0),
    jars: Number(parsed.jars || parsed.quantity || 0) || 1,
    date: toDateOnly(parsed.date || new Date()),
    orderNumber: normalizeImportText(parsed.orderNumber || parsed.order_number || ""),
    lineMessageId: normalizeImportText(parsed.lineMessageId || parsed.line_message_id || ""),
    source: parsed.source || "LINE",
    sourceChannel: parsed.sourceChannel || parsed.source_channel || "LINE"
  };
}

async function parseOrderWithAI(textValue, settings = {}) {
  const fallback = parseLineOrder(textValue, settings.defaultJarPrice);
  if (parsePrimaryLineOrderForm(textValue)) return fallback;
  const apiKey = settings.openaiApiKey;
  if (!apiKey) return fallback;
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: settings.openaiModel || "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content: "Extract a LINE order into JSON. If exact Thai key names are present, never guess, rename, or swap them. Return only valid JSON with keys: productName, orderDate, orderNumber, salesChannel, originSource, tag, customerSocial, customerName, shippingAddress, phoneNumber, alternatePhone, quantity, totalAmount, freeGift, vipStatus, note. Use empty string for missing fields."
          },
          {
            role: "user",
            content: textValue
          }
        ]
      })
    });
    if (!response.ok) return fallback;
    const payload = await response.json();
    const raw = payload.output_text || payload.output?.flatMap(item => item.content || []).map(chunk => chunk.text || "").join("") || "";
    if (!raw.trim()) return fallback;
    const parsed = JSON.parse(raw);
    return {
      items: normalizeProductNameForMatching(parsed.productName || fallback?.items || ""),
      date: normalizeImportDate(parsed.orderDate) || fallback?.date || toDateOnly(),
      orderNumber: normalizeImportText(parsed.orderNumber || ""),
      sourceChannel: normalizeImportText(parsed.salesChannel || fallback?.sourceChannel || "LINE"),
      originSource: normalizeImportText(parsed.originSource || fallback?.originSource || ""),
      tags: splitTags(parsed.tag || ""),
      socialName: normalizeImportText(parsed.customerSocial || fallback?.socialName || ""),
      name: normalizeImportText(parsed.customerName || fallback?.name || ""),
      address: normalizeImportText(parsed.shippingAddress || fallback?.address || ""),
      phone: normalizePhone(parsed.phoneNumber || fallback?.phone || ""),
      alternatePhone: normalizePhone(parsed.alternatePhone || fallback?.alternatePhone || ""),
      jars: Number(parsed.quantity || fallback?.jars || 0) || 1,
      amount: Number(parsed.totalAmount || fallback?.amount || 0),
      freeGift: normalizeImportText(parsed.freeGift || fallback?.freeGift || ""),
      vipCardStatus: normalizeImportText(parsed.vipStatus || fallback?.vipCardStatus || "ยังไม่ได้ส่งบัตร") || "ยังไม่ได้ส่งบัตร",
      note: normalizeImportText(parsed.note || fallback?.note || ""),
      source: "LINE",
      rawText: textValue
    };
  } catch {
    return fallback;
  }
}

async function handleLineWebhookEvents(db, settings, events, options = {}) {
  const parsedOrders = [];
  const replies = [];
  const persistedOrders = [];
  for (const event of events) {
    const { replyToken, source, text, messageId } = extractLineWebhookContext(event);
    const eventLog = lineEventLogPayload(event, text);
    console.log("LINE webhook event received", JSON.stringify(eventLog));
    const debug = {
      received_at: new Date().toISOString(),
      event_type: event.type || "",
      source_type: source.type || "",
      groupId: source.groupId || "",
      userId: source.userId || "",
      text: String(text || "").slice(0, 1000),
      parser_status: "not_run",
      supabase_insert_status: "not_run",
      error_message: ""
    };
    const rawText = text || "";
    const storedEvent = { ...event, __debug: debug };
    console.log("LINE webhook event payload", JSON.stringify({
      eventType: event.type || "",
      sourceType: source.type || "",
      hasMessage: Boolean(event.message),
      hasPostback: Boolean(event.postback),
      hasFollow: Boolean(event.follow)
    }));
    if (isDuplicateLineMessage(db, messageId)) {
      debug.parser_status = "duplicate_message";
      debug.supabase_insert_status = "skipped_duplicate_message";
      console.log("LINE webhook duplicate delivery skipped", JSON.stringify({
        groupId: source.groupId || "",
        lineMessageId: messageId || ""
      }));
      replies.push({ replyToken, messages: [{ type: "text", text: "ℹ️ ออเดอร์นี้มีอยู่แล้วใน Growup Pilot" }] });
      continue;
    }
    db.lineMessages.push({
      id: uid("line"),
      receivedAt: debug.received_at,
      rawEvent: storedEvent,
      text: rawText,
      raw_text: rawText
    });
    if (!isTargetGroup(source, settings)) {
      debug.parser_status = "skipped_group_filter";
      debug.error_message = source.type !== "group"
        ? "Event source is not a group."
        : `LINE_GROUP_ID mismatch. Received groupId: ${source.groupId || "(missing)"}`;
      console.log("LINE webhook group skipped", JSON.stringify({
        groupId: source.groupId || "",
        configuredGroupId: settings.lineGroupId || "",
        reason: source.type !== "group" ? "not_group" : "group_id_mismatch"
      }));
      continue;
    }
    if (!rawText) continue;
    if (!looksLikeOrderMessage(rawText)) {
      debug.parser_status = "skipped_not_order_format";
      console.log("LINE webhook message skipped", JSON.stringify({ reason: "not_order_format", groupId: source.groupId || "" }));
      continue;
    }
    console.log("LINE webhook parser starting", JSON.stringify({ groupId: source.groupId || "", hasOpenAI: Boolean(settings.openaiApiKey) }));
    const parsed = await parseOrderWithAI(rawText, settings);
    const normalized = normalizedOrderForStorage({ ...parsed, lineMessageId: messageId });
    const missingFields = missingRequiredOrderFields(normalized);
    if (missingFields.length) {
      debug.parser_status = "missing_required_fields";
      debug.error_message = `Missing fields: ${missingFields.join(", ")}`;
      console.log("LINE webhook parser missing fields", JSON.stringify({ groupId: source.groupId || "", missingFields }));
      replies.push({ replyToken, messages: [{ type: "text", text: formatMissingFieldsMessage(missingFields) }] });
      continue;
    }
    try {
      const upsaleOrder = findLineUpsaleOrder(db, normalized);
      if (upsaleOrder) {
        const { order, changes } = updateLineUpsaleOrder(db, upsaleOrder, normalized);
        parsedOrders.push(order);
        persistedOrders.push({
          id: order.id,
          lineMessageId: order.lineMessageId || "",
          phone: order.phone || "",
          amount: order.amount,
          date: order.date,
          mode: "upsale"
        });
        debug.parser_status = "upsale_updated";
        debug.supabase_insert_status = "pending_write";
        console.log("LINE webhook upsale order updated", JSON.stringify({
          groupId: source.groupId || "",
          lineMessageId: messageId || "",
          orderNumber: normalized.orderNumber || "",
          phone: normalized.phone || "",
          amount: normalized.amount,
          date: normalized.date,
          changedFields: changes.map(change => change.key)
        }));
        const upsaleReplyText = formatUpsaleReply(order, changes);
        debug.reply_text = upsaleReplyText;
        replies.push({ replyToken, messages: [{ type: "text", text: upsaleReplyText }] });
      } else {
        const order = addOrder(db, { ...normalized, allowProductContainsMatch: true });
        adjustInventoryForOrderChange(db, null, order);
        parsedOrders.push(order);
        persistedOrders.push({
          id: order.id,
          lineMessageId: order.lineMessageId || "",
          phone: order.phone || "",
          amount: order.amount,
          date: order.date,
          mode: "created"
        });
        debug.parser_status = "parsed";
        debug.supabase_insert_status = "pending_write";
        console.log("LINE webhook order parsed", JSON.stringify({
          groupId: source.groupId || "",
          lineMessageId: messageId || "",
          orderNumber: normalized.orderNumber || "",
          phone: normalized.phone || "",
          amount: normalized.amount,
          date: normalized.date
        }));
        const similarOrderToday = findSimilarOrderCreatedToday(db, normalized, order);
        if (similarOrderToday) {
          console.log("LINE webhook similar order warning appended", JSON.stringify({
            groupId: source.groupId || "",
            lineMessageId: messageId || "",
            orderNumber: normalized.orderNumber || "",
            phone: normalized.phone || "",
            amount: normalized.amount,
            date: normalized.date,
            matchedOrderId: similarOrderToday.id || "",
            matchedOrderNumber: similarOrderToday.orderNumber || similarOrderToday.order_number || ""
          }));
        }
        const successReplyText = "✅ นำเข้าออเดอร์เรียบร้อยแล้ว\nGrowup Pilot บันทึกข้อมูลเรียบร้อย";
        const replyText = similarOrderToday
          ? `${successReplyText}\n\n⚠️ พบออเดอร์ที่คล้ายกันภายในวันนี้\nกรุณาตรวจสอบว่าเป็นออเดอร์ใหม่ของลูกค้า หรือเป็นข้อความที่ส่งซ้ำ`
          : successReplyText;
        debug.reply_text = replyText;
        replies.push({ replyToken, messages: [{ type: "text", text: replyText }] });
      }
    } catch (error) {
      if (error.code === "ORDER_DUPLICATE") {
        debug.parser_status = "duplicate";
        debug.supabase_insert_status = "skipped_duplicate";
        console.log("LINE webhook duplicate order skipped", JSON.stringify({
          groupId: source.groupId || "",
          lineMessageId: messageId || "",
          orderNumber: normalized.orderNumber || "",
          phone: normalized.phone || "",
          amount: normalized.amount,
          date: normalized.date
        }));
        const duplicateReplyText = normalized.lineMessageId
          && normalizeImportText(error.order?.lineMessageId || error.order?.line_message_id || "") === normalized.lineMessageId
          ? "ℹ️ ออเดอร์นี้มีอยู่แล้วใน Growup Pilot"
          : "⚠️ พบออเดอร์ซ้ำ ระบบไม่นำเข้า CRM\n\nพบออเดอร์ที่มีรายละเอียดตรงกันภายใน 24 ชั่วโมง\nกรุณาตรวจสอบก่อนส่งซ้ำ";
        replies.push({ replyToken, messages: [{ type: "text", text: duplicateReplyText }] });
        continue;
      }
      if (error.code === "PRODUCT_NOT_FOUND") {
        debug.parser_status = "product_not_found";
        debug.supabase_insert_status = "skipped_product_not_found";
        debug.error_message = PRODUCT_RESOLUTION_ERROR;
        console.log("LINE webhook product not found skipped", JSON.stringify({
          groupId: source.groupId || "",
          lineMessageId: messageId || "",
          orderNumber: normalized.orderNumber || "",
          product: normalized.items || ""
        }));
        replies.push({ replyToken, messages: [{ type: "text", text: PRODUCT_RESOLUTION_ERROR }] });
        continue;
      }
      debug.parser_status = "error";
      debug.error_message = error.message || String(error);
      throw error;
    }
  }
  for (const message of db.lineMessages || []) {
    if (message.rawEvent?.__debug?.supabase_insert_status === "pending_write") {
      message.rawEvent.__debug.supabase_insert_status = "inserted";
    }
  }
  try {
    await writeDb(db);
  } catch (error) {
    console.error("LINE webhook persistence failed", JSON.stringify({
      stage: "writeDb",
      tenantId: options.tenant?.tenantId || "",
      parsedOrders: parsedOrders.length,
      persistedOrders: safePersistedOrderDiagnostics(persistedOrders),
      error: safeDatabaseErrorDetails(error)
    }));
    throw error;
  }
  console.log("LINE webhook database write completed", JSON.stringify({
    parsedOrders: parsedOrders.length,
    persistedOrders
  }));
  for (const reply of replies) {
    try {
      await replyLineMessages(settings, reply.replyToken, reply.messages);
    } catch {
      // Ignore reply failures so webhook delivery still succeeds.
    }
  }
  return parsedOrders;
}

function verifyLineSignature(rawBody, channelSecret, signature) {
  if (!channelSecret) return true;
  if (!signature) return false;
  const digest = crypto
    .createHmac("sha256", channelSecret)
    .update(rawBody || "")
    .digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  } catch {
    return false;
  }
}

async function handleLineWebhookPost(req, res, db, options = {}) {
  const body = req._parsedBody || await readBody(req);
  const signature = req.headers["x-line-signature"];
  const settings = effectiveSettings(db.settings);
  const httpDebug = addHttpWebhookDebug(db, req, body._rawBody || "", { signatureValidation: "pending" });
  console.log("LINE webhook raw body", JSON.stringify({
    receivedAt: httpDebug.received_at,
    hasEvents: Array.isArray(body.events),
    eventCount: Array.isArray(body.events) ? body.events.length : -1,
    bodyLength: Buffer.byteLength(body._rawBody || "", "utf8"),
    bodyPreview: String(body._rawBody || "").slice(0, 1200)
  }));
  if (!settings.lineWebhookEnabled) {
    httpDebug.signature_validation = "not_checked";
    httpDebug.error_message = "LINE webhook disabled.";
    persistWebhookDebugAsync(db);
    return json(res, 200, { ok: true, received: 0, verification: true });
  }
  if (!verifyLineSignature(body._rawBody, settings.lineChannelSecret, signature)) {
    httpDebug.signature_validation = "fail";
    httpDebug.error_message = "LINE signature validation failed.";
    persistWebhookDebugAsync(db);
    return json(res, 200, { ok: true, received: 0, verification: true });
  }
  httpDebug.signature_validation = "pass";
  const events = Array.isArray(body.events) ? body.events : [{ message: { text: body.text || body.content || "" } }];
  if (!Array.isArray(body.events)) {
    console.log("LINE webhook no events array", JSON.stringify({
      receivedAt: httpDebug.received_at,
      eventType: body.type || "",
      sourceType: body.source?.type || "",
      hasBodyEvents: false
    }));
  } else if (!body.events.length) {
    console.log("LINE webhook empty events array", JSON.stringify({
      receivedAt: httpDebug.received_at,
      eventType: body.type || "",
      sourceType: body.source?.type || "",
      hasBodyEvents: true,
      eventCount: 0
    }));
  }
  if (!events.length) {
    persistWebhookDebugAsync(db);
    return json(res, 200, { ok: true, received: 0, verification: true });
  }
  const parsedOrders = await handleLineWebhookEvents(db, settings, events, options);
  return json(res, 200, { ok: true, received: events.length, parsedOrders: parsedOrders.length });
}

async function handleBillingApi(req, res, url, db, currentUser) {
  if (req.method === "GET" && url.pathname === "/api/billing/upgrade/qr") {
    return serveSubscriptionQrImage(req, res, db, currentUser);
  }

  if (req.method === "GET" && url.pathname === "/api/billing/subscription") {
    return json(res, 200, { ok: true, billing: subscriptionBillingPayload(db) });
  }

  if (req.method === "POST" && url.pathname === "/api/billing/upgrade") {
    if (currentUser.role !== "Owner") {
      return json(res, 403, { ok: false, code: "UPGRADE_OWNER_REQUIRED", error: "ต้องใช้สิทธิ์ Owner เพื่ออัปเกรดแพ็กเกจ" });
    }
    if (typeof beginSubscriptionUpgrade !== "function") {
      return json(res, 503, { ok: false, code: "SUBSCRIPTION_UPGRADE_REQUIRED", error: "ระบบอัปเกรดแพ็กเกจยังไม่พร้อมใช้งาน" });
    }
    const body = await readBody(req);
    const targetPlan = normalizeSignupPlan(body.targetPlan || body.plan);
    const subscription = currentSubscription(db);
    const currentPlan = String(subscription?.plan || "").toLowerCase();
    const planOrder = { starter: 0, business: 1, enterprise: 2 };
    if (!targetPlan || !subscription || !planOrder[targetPlan] || planOrder[targetPlan] <= Number(planOrder[currentPlan] ?? -1)) {
      return json(res, 409, { ok: false, code: "UPGRADE_NOT_ALLOWED", error: "ไม่สามารถอัปเกรดไปยังแพ็กเกจนี้ได้" });
    }

    const providerConfig = paymentProviderConfig();
    if (!providerConfig.configured) {
      return json(res, 503, {
        ok: false,
        code: "PAYMENT_PROVIDER_REQUIRED",
        error: "ยังไม่ได้ตั้งค่าผู้ให้บริการชำระเงินใน Preview"
      });
    }
    if (providerConfig.provider !== STRIPE_PROVIDER) {
      return json(res, 501, {
        ok: false,
        code: "PAYMENT_PROVIDER_ADAPTER_REQUIRED",
        error: "ยังไม่มี adapter สำหรับผู้ให้บริการชำระเงินที่ตั้งค่าไว้"
      });
    }
    const idempotencyKey = `pricing-upgrade-${currentUser.tenantId}-${crypto.randomUUID()}`;
    let pendingUpgradeAttempts = [];
    if (typeof readPendingSubscriptionUpgrades === "function") {
      try {
        pendingUpgradeAttempts = await readPendingSubscriptionUpgrades(currentUser.tenantId);
      } catch (error) {
        console.error("Pending subscription upgrade lookup failed", error.message);
      }
    }
    try {
      const pendingCandidate = pendingUpgradePaymentFor(db, currentUser, pendingUpgradeAttempts);
      const pendingView = pendingCandidate
        ? upgradePaymentView({
            payment: pendingCandidate.payment || {},
            attempt: pendingCandidate.attempt,
            currentPlan,
            targetPlan: pendingCandidate.payment?.plan || pendingCandidate.attempt?.targetPlan || ""
          })
        : null;
      const pendingTarget = String(pendingView?.targetPlan || "").toLowerCase();
      if (pendingView && pendingTarget && pendingTarget !== targetPlan) {
        return json(res, 409, {
          ok: false,
          code: "UPGRADE_IN_PROGRESS",
          error: "คุณมีรายการชำระเงินที่ยังไม่เสร็จสิ้น กรุณาดำเนินการรายการเดิมให้เรียบร้อยก่อน",
          pendingPayment: publicPayment(pendingView),
          billing: subscriptionBillingPayload({ ...db, payments: [pendingView, ...(db.payments || [])] })
        });
      }

      // A prior request may have created the Stripe PaymentIntent before the
      // local reference write completed. Recover that exact intent by its
      // server-owned metadata instead of creating a second payment.
      if (pendingView && pendingTarget === targetPlan && !pendingView.providerPaymentReference && pendingCandidate.payment) {
        const recovered = await recoverPendingUpgradePaymentReference(pendingCandidate.payment, currentUser);
        if (recovered) {
          const recoveredView = upgradePaymentView({
            payment: recovered.payment,
            attempt: pendingCandidate.attempt,
            currentPlan,
            targetPlan
          });
          return json(res, 200, {
            ok: true,
            provider: STRIPE_PROVIDER,
            resumed: true,
            recovered: true,
            upgrade: upgradeViewFromPayment(pendingCandidate.attempt || {}, recoveredView),
            payment: publicPayment(recoveredView),
            promptpay: recovered.promptpay,
            billing: subscriptionBillingPayload({ ...db, payments: [recoveredView, ...(db.payments || [])] })
          });
        }
      }

      // Legacy upgrade rows can predate the current RPC contract. If the
      // authoritative payment already has a Stripe reference, resume that
      // exact PaymentIntent directly instead of asking the RPC to create or
      // reject another attempt.
      if (pendingView && pendingTarget === targetPlan && pendingView.providerPaymentReference) {
        const promptpay = await retrievePaymentIntent(pendingView.providerPaymentReference);
        const reconciledStatus = await reconcileResumablePayment(
          pendingCandidate.payment || pendingView,
          pendingCandidate.attempt,
          promptpay,
          currentUser
        );
        if (["pending", "processing"].includes(reconciledStatus)) {
          console.log("Subscription upgrade resumed existing payment", JSON.stringify({
            tenantId: currentUser.tenantId,
            paymentId: pendingView.id,
            paymentIntentId: promptpay.paymentIntentId,
            stripeStatus: promptpay.status,
            localStatus: promptpay.localStatus,
            resumed: true
          }));
          return json(res, 200, {
            ok: true,
            provider: STRIPE_PROVIDER,
            resumed: true,
            upgrade: upgradeViewFromPayment(pendingCandidate.attempt || {}, pendingView),
            payment: publicPayment(pendingView),
            promptpay,
            billing: subscriptionBillingPayload({ ...db, payments: [pendingView, ...(db.payments || [])] })
          });
        }
        if (reconciledStatus === "paid") {
          console.log("Subscription upgrade observed succeeded payment awaiting webhook", JSON.stringify({
            tenantId: currentUser.tenantId,
            paymentId: pendingView.id,
            paymentIntentId: promptpay.paymentIntentId,
            stripeStatus: promptpay.status,
            resumed: true,
            awaitingWebhook: true
          }));
          return json(res, 200, {
            ok: true,
            provider: STRIPE_PROVIDER,
            resumed: true,
            awaitingWebhook: true,
            upgrade: upgradeViewFromPayment(pendingCandidate.attempt || {}, pendingView),
            payment: publicPayment(pendingView),
            promptpay,
            billing: subscriptionBillingPayload({ ...db, payments: [pendingView, ...(db.payments || [])] })
          });
        }
        // A terminal provider state was reconciled above. Continue through
        // the normal RPC path so a fresh attempt can be created safely.
        if (["failed", "cancelled", "expired", "paid"].includes(reconciledStatus)) {
          if (pendingCandidate.attempt && ["failed", "cancelled", "expired"].includes(reconciledStatus)
            && typeof closeTerminalSubscriptionUpgradeAttempt === "function") {
            await closeTerminalSubscriptionUpgradeAttempt({
              attemptId: pendingCandidate.attempt.id || pendingCandidate.attempt.upgradeId,
              tenantId: currentUser.tenantId,
              status: reconciledStatus
            });
          }
          pendingUpgradeAttempts = [];
        }
      }

      const upgrade = await beginSubscriptionUpgrade({
        tenantId: currentUser.tenantId,
        userId: currentUser.id,
        targetPlan,
        idempotencyKey,
        provider: providerConfig.provider
      });
      if (!upgrade?.paymentId) {
        return json(res, 503, { ok: false, code: "SUBSCRIPTION_UPGRADE_REQUIRED", error: "สร้างรายการอัปเกรดไม่สำเร็จ" });
      }
      const upgradePayment = {
        id: upgrade.paymentId,
        tenantId: upgrade.tenantId,
        subscriptionId: upgrade.subscriptionId,
        provider: upgrade.provider,
        status: upgrade.status,
        currency: upgrade.currency,
        amountMinor: upgrade.amountMinor,
        plan: upgrade.targetPlan,
        currentPlan: upgrade.currentPlan,
        targetPlan: upgrade.targetPlan,
        operation: "subscription_upgrade",
        billingInterval: upgrade.billingInterval,
        idempotencyKey: upgrade.idempotencyKey,
        providerPaymentReference: upgrade.providerPaymentReference,
        billingPeriodStartedAt: upgrade.billingPeriodStartedAt,
        billingPeriodEndsAt: upgrade.billingPeriodEndsAt,
        createdAt: upgrade.createdAt
      };
      const existingUpgradePayment = (db.payments || []).find(payment => (
        String(payment.id || "") === String(upgrade.paymentId || "")
      ));
      const providerPaymentReference = String(
        upgradePayment.providerPaymentReference
          || existingUpgradePayment?.providerPaymentReference
          || existingUpgradePayment?.provider_payment_reference
          || ""
      );
      if (providerConfig.provider === STRIPE_PROVIDER) {
        if (typeof setPaymentProviderReference !== "function") {
          return json(res, 503, { ok: false, code: "STRIPE_PAYMENT_RPC_REQUIRED", error: "ระบบบันทึก Stripe payment ยังไม่พร้อม" });
        }
        const promptpay = providerPaymentReference
          ? await retrievePaymentIntent(providerPaymentReference)
          : await createPromptPayPaymentIntent({
              payment: upgradePayment,
              returnUrl: `${requestOrigin(req)}/pricing`,
              receiptEmail: receiptEmailForUser(currentUser)
            });
        const nextPayment = await setPaymentProviderReference({
          paymentId: upgradePayment.id,
          tenantId: currentUser.tenantId,
          provider: STRIPE_PROVIDER,
          providerPaymentReference: promptpay.paymentIntentId,
          status: promptpay.status === "processing" ? "processing" : "pending",
          providerMetadata: {
            stripe_status: promptpay.status,
            promptpay_has_qr: Boolean(stripeQrImageSource(promptpay)),
            hosted_instructions_url: stripeQrHostedInstructions(promptpay),
            operation: "subscription_upgrade",
            current_plan: upgrade.currentPlan,
            target_plan: upgrade.targetPlan
          }
        });
        const payment = publicPayment({ ...upgradePayment, ...nextPayment, currentPlan: upgrade.currentPlan, targetPlan: upgrade.targetPlan, operation: "subscription_upgrade" });
        return json(res, 200, {
          ok: true,
          provider: STRIPE_PROVIDER,
          upgrade,
          payment,
          promptpay,
          billing: subscriptionBillingPayload({ ...db, payments: [payment, ...(db.payments || [])] })
        });
      }
      return json(res, 501, { ok: false, code: "PAYMENT_PROVIDER_ADAPTER_REQUIRED", error: "ยังไม่มี adapter สำหรับผู้ให้บริการชำระเงินที่ตั้งค่าไว้" });
    } catch (error) {
      const detail = String(error.code || error.detail || error.message || "");
      for (const code of ["UPGRADE_NOT_ALLOWED", "UPGRADE_IN_PROGRESS", "UPGRADE_IDEMPOTENCY_CONFLICT", "SUBSCRIPTION_NOT_UPGRADABLE", "SUBSCRIPTION_NOT_FOUND", "UPGRADE_TENANT_FORBIDDEN", "INVALID_SUBSCRIPTION_UPGRADE_INPUT"]) {
        if (detail.includes(code)) {
          const status = code === "UPGRADE_TENANT_FORBIDDEN" ? 403 : 409;
          const pendingCandidate = pendingUpgradePaymentFor(db, currentUser, pendingUpgradeAttempts);
          const pendingView = pendingCandidate
            ? upgradePaymentView({
                payment: pendingCandidate.payment || {},
                attempt: pendingCandidate.attempt,
                currentPlan,
                targetPlan: pendingCandidate.payment?.plan || pendingCandidate.attempt?.targetPlan || ""
              })
            : null;
          return json(res, status, {
            ok: false,
            code,
            error: code === "UPGRADE_IN_PROGRESS" ? "มีรายการอัปเกรดที่กำลังดำเนินการอยู่" : "ไม่สามารถเริ่มรายการอัปเกรดนี้ได้",
            ...(code === "UPGRADE_IN_PROGRESS" && pendingView
              ? {
                  pendingPayment: publicPayment(pendingView),
                  billing: subscriptionBillingPayload({ ...db, payments: [pendingView, ...(db.payments || [])] })
                }
              : {})
          });
        }
      }
      if (error.code === "STRIPE_TEST_SECRET_KEY_REQUIRED" || error.code === "STRIPE_LIVE_SECRET_KEY_REQUIRED") {
        return json(res, 503, { ok: false, code: error.code, error: "ยังไม่ได้ตั้งค่า Stripe secret key ให้ตรงกับ environment" });
      }
      if (String(error.code || "").startsWith("STRIPE_")) {
        return json(res, 502, { ok: false, code: error.code, error: "เชื่อมต่อ Stripe ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" });
      }
      if (detail.includes("SUBSCRIPTION_UPGRADE_EVENT_MISMATCH")) {
        console.error("Subscription upgrade reconciliation rejected", JSON.stringify({
          tenantId: currentUser.tenantId,
          targetPlan,
          code: "SUBSCRIPTION_UPGRADE_EVENT_MISMATCH"
        }));
        return json(res, 409, {
          ok: false,
          code: "PAYMENT_RECONCILIATION_RETRY",
          error: "ระบบกำลังตรวจสอบการชำระเงิน กรุณารอสักครู่แล้วลองเปิดรายการเดิมอีกครั้ง"
        });
      }
      throw error;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/billing/checkout") {
    if (currentUser.role !== "Owner") {
      return json(res, 403, { ok: false, error: "ต้องใช้สิทธิ์ Owner เพื่อจัดการการชำระเงิน" });
    }
    if (typeof beginSubscriptionPayment !== "function") {
      return json(res, 503, { ok: false, error: "ระบบชำระเงินยังไม่พร้อมใช้งาน" });
    }
    const subscription = currentSubscription(db);
    const access = subscriptionAccess(subscription);
    if (subscription && !access.requiresPayment) {
      return json(res, 409, { ok: false, code: "PAYMENT_NOT_REQUIRED", error: "แพ็กเกจนี้ยังไม่ต้องชำระเงิน" });
    }
    const body = await readBody(req);
    const idempotencyKey = String(body.idempotencyKey || body.checkoutRequestId || crypto.randomUUID()).trim();
    const providerConfig = paymentProviderConfig();
    try {
      if (subscription && access.requiresPayment && Number(subscription.amountDueMinor || 0) === 0) {
        if (typeof activateZeroAmountSubscriptionPayment !== "function") {
          return json(res, 503, { ok: false, code: "ZERO_AMOUNT_ACTIVATION_REQUIRED", error: "ระบบเปิดใช้งานแพ็กเกจส่วนลดเต็มจำนวนยังไม่พร้อม" });
        }
        const payment = await activateZeroAmountSubscriptionPayment({
          tenantId: currentUser.tenantId,
          userId: currentUser.id,
          idempotencyKey
        });
        return json(res, 200, {
          ok: true,
          provider: "zero_amount",
          payment: publicPayment(payment),
          billing: subscriptionBillingPayload({ ...db, payments: [payment, ...(db.payments || [])] })
        });
      }

      const payment = await beginSubscriptionPayment({
        tenantId: currentUser.tenantId,
        userId: currentUser.id,
        idempotencyKey,
        provider: providerConfig.provider
      });
      if (!providerConfig.configured) {
        return json(res, 503, {
          ok: false,
          code: "PAYMENT_PROVIDER_REQUIRED",
          error: "ยังไม่ได้ตั้งค่าผู้ให้บริการชำระเงินใน Preview",
          payment: publicPayment(payment),
          billing: subscriptionBillingPayload({ ...db, payments: [payment, ...(db.payments || [])] })
        });
      }
      if (providerConfig.provider === STRIPE_PROVIDER) {
        if (typeof setPaymentProviderReference !== "function") {
          return json(res, 503, { ok: false, code: "STRIPE_PAYMENT_RPC_REQUIRED", error: "ระบบบันทึก Stripe payment ยังไม่พร้อม" });
        }
        const promptpay = payment.providerPaymentReference
          ? await retrievePaymentIntent(payment.providerPaymentReference)
          : await createPromptPayPaymentIntent({
              payment,
              returnUrl: `${requestOrigin(req)}/settings/subscription`,
              receiptEmail: receiptEmailForUser(currentUser)
            });
        const nextPayment = await setPaymentProviderReference({
          paymentId: payment.id,
          tenantId: currentUser.tenantId,
          provider: STRIPE_PROVIDER,
          providerPaymentReference: promptpay.paymentIntentId,
          status: promptpay.status === "processing" ? "processing" : "pending",
          providerMetadata: {
            stripe_status: promptpay.status,
            promptpay_has_qr: Boolean(stripeQrImageSource(promptpay)),
            hosted_instructions_url: stripeQrHostedInstructions(promptpay)
          }
        });
        return json(res, 200, {
          ok: true,
          provider: STRIPE_PROVIDER,
          payment: publicPayment(nextPayment || payment),
          promptpay,
          billing: subscriptionBillingPayload({ ...db, payments: [nextPayment || payment, ...(db.payments || [])] })
        });
      }
      return json(res, 501, {
        ok: false,
        code: "PAYMENT_PROVIDER_ADAPTER_REQUIRED",
        error: "ยังไม่มี adapter สำหรับผู้ให้บริการชำระเงินที่ตั้งค่าไว้",
        payment: publicPayment(payment)
      });
    } catch (error) {
      const detail = String(error.detail || error.message || "");
      if (detail.includes("PAYMENT_NOT_REQUIRED")) {
        return json(res, 409, { ok: false, code: "PAYMENT_NOT_REQUIRED", error: "แพ็กเกจนี้ยังไม่ต้องชำระเงิน" });
      }
      if (detail.includes("SUBSCRIPTION_NOT_FOUND")) {
        return json(res, 404, { ok: false, code: "SUBSCRIPTION_NOT_FOUND", error: "ไม่พบ subscription ของ tenant นี้" });
      }
      if (detail.includes("PAYMENT_TENANT_FORBIDDEN")) {
        return json(res, 403, { ok: false, code: "PAYMENT_TENANT_FORBIDDEN", error: "ไม่มีสิทธิ์สร้างรายการชำระเงินของ tenant นี้" });
      }
      if (error.code === "STRIPE_TEST_SECRET_KEY_REQUIRED" || error.code === "STRIPE_LIVE_SECRET_KEY_REQUIRED") {
        return json(res, 503, { ok: false, code: error.code, error: "ยังไม่ได้ตั้งค่า Stripe secret key ให้ตรงกับ environment" });
      }
      if (String(error.code || "").startsWith("STRIPE_")) {
        return json(res, 502, { ok: false, code: error.code, error: "เชื่อมต่อ Stripe ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" });
      }
      throw error;
    }
  }

  return json(res, 404, { ok: false, error: "API not found" });
}

async function handleStripeWebhookApi(req, res) {
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });
  if (dbProvider !== "supabase") return json(res, 503, { ok: false, error: "Stripe webhook requires Supabase provider." });
  const providerConfig = paymentProviderConfig();
  if (providerConfig.provider !== STRIPE_PROVIDER || !providerConfig.stripe?.webhookConfigured || !providerConfig.stripe?.modeConfigured) {
    return json(res, 503, { ok: false, code: "STRIPE_WEBHOOK_NOT_CONFIGURED", error: "Stripe webhook is not configured for this environment." });
  }

  const body = await readBody(req);
  let event;
  try {
    event = verifyStripeWebhookPayload(body._rawBody || "", req.headers["stripe-signature"] || "");
  } catch (error) {
    return json(res, 400, { ok: false, code: error.code || "STRIPE_WEBHOOK_INVALID", error: "Invalid Stripe webhook signature." });
  }

  const supportedTypes = new Set([
    "payment_intent.succeeded",
    "payment_intent.processing",
    "payment_intent.payment_failed",
    "payment_intent.canceled"
  ]);
  if (!supportedTypes.has(String(event.type || ""))) {
    return json(res, 200, { ok: true, ignored: true, type: event.type || "" });
  }

  const intent = event.data?.object || {};
  const paymentIntentId = String(intent.id || "");
  if (!paymentIntentId || typeof readPaymentByProviderReference !== "function") {
    return json(res, 200, { ok: true, ignored: true, reason: "payment_reference_missing" });
  }
  const payment = await readPaymentByProviderReference(STRIPE_PROVIDER, paymentIntentId);
  if (!payment?.id) {
    return json(res, 200, { ok: true, ignored: true, reason: "local_payment_not_found" });
  }

  const rawEvent = safeStripeEventForStorage(event);
  const input = {
    provider: STRIPE_PROVIDER,
    providerEventId: event.id,
    paymentId: payment.id,
    providerPaymentReference: paymentIntentId,
    amountMinor: Number(intent.amount || 0),
    currency: String(intent.currency || "").toUpperCase(),
    rawEvent
  };
  try {
    if (event.type === "payment_intent.succeeded" || stripePaymentStatus(intent.status) === "paid") {
      if (payment.operation === "subscription_upgrade") {
        if (typeof recordSubscriptionUpgradeSuccess !== "function") {
          return json(res, 503, { ok: false, code: "SUBSCRIPTION_UPGRADE_SUCCESS_RPC_REQUIRED", error: "Subscription upgrade success RPC is not configured." });
        }
        await recordSubscriptionUpgradeSuccess(input);
      } else {
        if (typeof recordProviderPaymentSuccess !== "function") {
          return json(res, 503, { ok: false, code: "PAYMENT_SUCCESS_RPC_REQUIRED", error: "Payment success RPC is not configured." });
        }
        await recordProviderPaymentSuccess(input);
      }
    } else {
      const status = event.type === "payment_intent.payment_failed"
        ? "failed"
        : (event.type === "payment_intent.canceled" ? "cancelled" : stripePaymentStatus(intent.status));
      if (payment.operation === "subscription_upgrade") {
        if (typeof recordSubscriptionUpgradeStatus !== "function") {
          return json(res, 503, { ok: false, code: "SUBSCRIPTION_UPGRADE_STATUS_RPC_REQUIRED", error: "Subscription upgrade status RPC is not configured." });
        }
        await recordSubscriptionUpgradeStatus({ ...input, status });
      } else {
        if (typeof recordProviderPaymentStatus !== "function") {
          return json(res, 503, { ok: false, code: "PAYMENT_STATUS_RPC_REQUIRED", error: "Payment status RPC is not configured." });
        }
        await recordProviderPaymentStatus({ ...input, status });
      }
    }
  } catch (error) {
    console.error("Stripe webhook payment reconciliation failed", {
      code: error.code || "",
      message: error.message || "",
      eventId: event.id || "",
      paymentIntentId
    });
    return json(res, 400, { ok: false, code: error.code || "STRIPE_WEBHOOK_RECONCILE_FAILED", error: "Stripe payment reconciliation failed." });
  }

  return json(res, 200, { ok: true, received: true, eventId: event.id || "" });
}

async function handlePlatformAdminApi(req, res, url, currentUser) {
  try {
    if (req.method === "GET" && url.pathname === "/api/platform-admin/overview") {
      return json(res, 200, { ok: true, overview: await platformAdminOverview(currentUser.id) });
    }
    if (req.method === "GET" && url.pathname === "/api/platform-admin/tenants") {
      return json(res, 200, {
        ok: true,
        result: await platformAdminTenants(currentUser.id, {
          search: url.searchParams.get("search") || "",
          limit: Number(url.searchParams.get("limit") || 50),
          offset: Number(url.searchParams.get("offset") || 0)
        })
      });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/platform-admin/tenants/")) {
      const tenantId = url.pathname.split("/").pop();
      return json(res, 200, { ok: true, result: await platformAdminTenantDetail(currentUser.id, tenantId) });
    }
    if (req.method === "GET" && url.pathname === "/api/platform-admin/payments") {
      return json(res, 200, {
        ok: true,
        result: await platformAdminPayments(currentUser.id, {
          status: url.searchParams.get("status") || "",
          limit: Number(url.searchParams.get("limit") || 50),
          offset: Number(url.searchParams.get("offset") || 0)
        })
      });
    }
    if (req.method === "GET" && url.pathname === "/api/platform-admin/promotions") {
      return json(res, 200, { ok: true, result: await platformAdminPromotionCodes(currentUser.id) });
    }
    if (["POST", "PUT"].includes(req.method) && url.pathname === "/api/platform-admin/promotions") {
      const body = await readBody(req);
      return json(res, 200, { ok: true, result: await platformAdminUpsertPromotionCode(currentUser.id, body) });
    }
  } catch (error) {
    return safePlatformAdminError(res, error);
  }
  return json(res, 404, { ok: false, error: "API not found" });
}

function parseDelimited(content) {
  const lines = String(content || "")
    .replace(/\r/g, "")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const delimiter = lines[0].includes("\t") ? "\t" : ",";
  const rows = lines.map(line => {
    const values = [];
    let current = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"') {
        quoted = !quoted;
      } else if (char === delimiter && !quoted) {
        values.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    return values;
  });
  const headers = rows.shift().map(header => header.toLowerCase().trim());
  return rows.map(row => {
    const item = {};
    headers.forEach((header, index) => {
      item[header] = row[index] || "";
    });
    return item;
  });
}

function normalizeImportRow(row, defaultJarPrice) {
  const get = (...keys) => keys.map(key => row[key]).find(Boolean) || "";
  const orderNumber = normalizeImportText(get("order_number", "order number", "เลขออเดอร์"));
  const jars = Number(get("jars", "jar", "จำนวนกระปุก", "กระปุก", "ซื้อกี่กระปุก", "qty", "quantity") || 1);
  const amountText = String(get("amount", "total", "ยอด", "ยอดซื้อ", "ราคา")).replace(/,/g, "").trim();
  const parsedAmount = amountText === "" ? NaN : Number(amountText);
  const sourceChannel = get("source_channel", "source channel", "ช่องทางการสั่งซื้อ", "ช่องทาง", "ช่องทางสั่ง", "สั่งจาก", "source") || "Import";
  const vipValue = normalizeImportText(get(
    "vip_card_status",
    "vip card status",
    "สถานะบัตร vip",
    "บัตร vip",
    "เคยได้บัตรvipแล้วหรือยัง"
  ));
  const originSource = normalizeOrderOriginSource(get("origin_source", "origin source", "ช่องทางการขาย", "ลูกค้ามาจาก", "มาจาก", "แหล่งที่มา"));
  return {
    items: get("items", "product", "product_name", "สินค้า") || "Growup",
    orderNumber,
    name: get("name", "customer", "customer name", "ชื่อ", "ชื่อลูกค้า", "ชื่อลูกค้ารับของ", "ลูกค้า"),
    phone: get("phone", "tel", "mobile", "เบอร์", "เบอร์โทร", "โทร", "โทรศัพท์", "เบอร์โทรศัพท์"),
    alternatePhone: get("alternate_phone", "alternate phone", "secondary phone", "เบอร์โทรสำรอง", "เบอร์สำรอง", "โทรสำรอง"),
    address: get("address", "ที่อยู่", "ที่อยู่จัดส่ง"),
    date: normalizeImportDate(get("date", "order date", "วันที่", "วันที่ซื้อ", "วันที่สั่งซื้อ")) || toDateOnly(),
    jars,
    amount: Number.isFinite(parsedAmount) ? parsedAmount : jars * defaultJarPrice,
    tags: get("tags", "tag", "แท็ก", "อาการลูกค้า", "อาการ"),
    source: "Import",
    sourceChannel,
    socialName: get(
      "social_name",
      "social name",
      "facebook / line ลูกค้า",
      "ชื่อเฟส",
      "ชื่อไลน์",
      "ชื่อ facebook หรือ ไลน์ ของลูกค้า",
      "facebook",
      "line"
    ),
    originSource: originSource.originSource,
    originSourceOther: originSource.originSourceOther,
    freeGift: get("free_gift", "free gift", "ของแถมที่ลูกค้าได้", "ของแถม", "แถม"),
    vipCardStatus: !vipValue
      ? ""
      : /^(เคย|ใช่|มี|ส่งแล้ว|ได้แล้ว|yes|y|true|1)$/i.test(vipValue)
        ? "ส่งบัตรแล้ว"
        : vipValue,
    note: get("note", "หมายเหตุ", "remark", "remarks"),
    rawText: JSON.stringify({ ...row, __orderNumber: orderNumber, __alternatePhone: get("alternate_phone", "alternate phone", "secondary phone", "เบอร์โทรสำรอง", "เบอร์สำรอง", "โทรสำรอง"), __originSource: originSource.originSource, __originSourceOther: originSource.originSourceOther })
  };
}

function csvDuplicateKey(order, db) {
  const customer = db.customers.find(item => item.id === order.customerId);
  return JSON.stringify([
    toDateOnly(order.date) || String(order.date || "").trim(),
    normalizeImportText(order.name || order.customerName || customer?.name),
    normalizeImportText(order.address || customer?.address),
    Number(order.amount || 0)
  ]);
}

const csvMergeFields = [
  "orderNumber",
  "date",
  "sourceChannel",
  "socialName",
  "name",
  "phone",
  "alternatePhone",
  "address",
  "jars",
  "amount",
  "freeGift",
  "vipCardStatus",
  "tags",
  "originSource",
  "note"
];

function csvCompleteness(row) {
  return csvMergeFields.reduce((score, field) => score + (normalizeImportText(row[field]) ? 1 : 0), 0);
}

function mergeCsvRows(current, candidate) {
  const preferred = csvCompleteness(candidate) > csvCompleteness(current) ? candidate : current;
  const fallback = preferred === current ? candidate : current;
  const merged = { ...preferred };
  for (const field of csvMergeFields) {
    if (!normalizeImportText(merged[field]) && normalizeImportText(fallback[field])) {
      merged[field] = fallback[field];
    }
  }
  merged.rawText = JSON.stringify({ primary: preferred.rawText, merged: fallback.rawText });
  return merged;
}

function prepareCsvImport(content, db) {
  const rows = parseDelimited(content);
  const grouped = new Map();
  let invalid = 0;
  let duplicateRows = 0;
  for (const row of rows) {
    const normalized = normalizeImportRow(row, Number(db.settings.defaultJarPrice || 750));
    if (!normalized.phone || !normalized.name || !normalized.date) {
      invalid += 1;
      continue;
    }
    const key = csvDuplicateKey(normalized, db);
    if (grouped.has(key)) {
      grouped.set(key, mergeCsvRows(grouped.get(key), normalized));
      duplicateRows += 1;
    } else {
      grouped.set(key, normalized);
    }
  }

  const existingKeys = new Set(db.orders.map(order => csvDuplicateKey(order, db)));
  const previewRows = [];
  let existingDuplicates = 0;
  for (const [key, row] of grouped) {
    const duplicate = existingKeys.has(key);
    if (duplicate) existingDuplicates += 1;
    previewRows.push({ ...row, duplicate });
  }
  return {
    rows: previewRows,
    imported: previewRows.filter(row => !row.duplicate).length,
    duplicates: duplicateRows + existingDuplicates,
    invalid
  };
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const safePath = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  const requestedPath = safePath === "/"
    ? "/landing.html"
    : safePath === "/login"
      ? "/login.html"
      : safePath === "/signup"
        ? "/signup.html"
        : safePath;
  let filePath = path.join(PUBLIC_DIR, requestedPath);
  if (!filePath.startsWith(PUBLIC_DIR)) return text(res, 403, "Forbidden");

  fs.readFile(filePath, (error, file) => {
    if (error && !path.extname(filePath)) {
      filePath = path.join(PUBLIC_DIR, "index.html");
      return fs.readFile(filePath, (fallbackError, fallbackFile) => {
        if (fallbackError) return text(res, 404, "Not found");
        res.writeHead(200, {
          "Content-Type": MIME_TYPES[".html"],
          ...staticCacheHeaders(filePath)
        });
        res.end(fallbackFile);
      });
    }
    if (error) return text(res, 404, "Not found");
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      ...staticCacheHeaders(filePath)
    });
    res.end(file);
  });
}

function isPublicAppPath(pathname = "") {
  return ["/", "/login", "/signup"].includes(pathname);
}

function redirectToLogin(res) {
  res.writeHead(302, {
    Location: "/login",
    "Cache-Control": "no-store",
    "Set-Cookie": clearSessionCookie()
  });
  res.end();
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const isLineWebhook = url.pathname === "/api/line/webhook";
  const requestStartedAt = Date.now();

  if (url.pathname === "/api/stripe/webhook" || url.pathname === "/api/payments/stripe/webhook") {
    return handleStripeWebhookApi(req, res);
  }

  if (isLineWebhook && req.method === "POST") {
    const body = await readBody(req);
    if (isLineVerifyRequest(body)) {
      console.log("LINE webhook verify request", JSON.stringify({
        method: req.method,
        bodyLength: Buffer.byteLength(body._rawBody || "", "utf8"),
        timestamp: new Date().toISOString(),
        signaturePresent: Boolean(req.headers["x-line-signature"])
      }));
      return json(res, 200, { ok: true, received: 0, verification: true });
    }
    req._parsedBody = body;
  }

  if (req.method === "GET" && url.pathname === "/api/session") {
    const session = getSession(req);
    if (!session?.user) return json(res, 200, { ok: true, user: null });
    const user = await freshSessionUser(req);
    if (!user) return sessionExpiredResponse(req, res);
    const nextSession = createSession(user);
    return json(res, 200, { ok: true, user }, {
      "Set-Cookie": sessionCookie(nextSession.token, nextSession.expiresAt)
    });
  }

  if (req.method === "GET" && url.pathname === "/api/verify/runtime") {
    if (process.env.VERCEL_ENV === "production") {
      return json(res, 404, { ok: false, error: "API not found" });
    }
    return json(res, 200, {
      ok: true,
      runtime: runtimeSupabaseInfo()
    });
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    destroySession(req);
    return json(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
  }

  if (req.method === "POST" && url.pathname === "/api/signup/promotion-code") {
    const body = await readBody(req);
    const promotionCode = normalizePromotionCodeInput(body.promotionCode || body.promoCode || body.code || "");
    const selectedPlan = normalizeSignupPlan(body.landingSelectedPlan || body.selectedPlan || body.plan);
    const selectedBilling = normalizeSignupBilling(body.landingSelectedBilling || body.selectedBilling || body.billing);
    if (!promotionCode || !selectedPlan || !selectedBilling || typeof validatePromotionCode !== "function") {
      return json(res, 400, {
        ok: false,
        code: "PROMOTION_CODE_INVALID",
        error: "โค้ดโปรโมชั่นไม่ถูกต้องหรือไม่สามารถใช้กับแพ็กเกจนี้ได้"
      });
    }
    try {
      const result = await validatePromotionCode({
        promotionCode,
        selectedPlan,
        selectedBilling
      });
      if (!result?.valid) {
        const reason = String(result?.reason || "PROMOTION_CODE_INVALID");
        return json(res, 400, {
          ok: false,
          code: reason,
          error: safePromotionError(reason)
        });
      }
      return json(res, 200, {
        ok: true,
        promotion: {
          valid: true,
          code: result.code,
          selectedPlan: result.selectedPlan,
          selectedBilling: result.selectedBilling,
          benefitType: result.benefitType,
          benefitDescription: result.benefitDescription
        }
      });
    } catch (error) {
      if (error.code === "SIGNUP_PROVIDER_UNSUPPORTED") {
        return json(res, 503, { ok: false, error: "ระบบโปรโมชั่นยังไม่พร้อมใช้งาน" });
      }
      console.error("Promotion validation failed", error);
      return json(res, 500, { ok: false, error: "ตรวจสอบโค้ดโปรโมชั่นไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/signup") {
    const body = await readBody(req);
    const normalized = validateSignupBody(body);
    if (normalized.error) return json(res, 400, { ok: false, code: normalized.code, error: normalized.error });
    const retryAfter = checkAuthRateLimit(req, "signup", normalized.username);
    if (retryAfter) {
      return json(res, 429, { ok: false, error: "ลองใหม่อีกครั้งในภายหลัง" }, { "Retry-After": String(retryAfter) });
    }
    if (typeof createSignupTenantAccount !== "function") {
      return json(res, 503, { ok: false, error: "ระบบสมัครใช้งานยังไม่พร้อมใช้งาน" });
    }
    const passwordHash = hashPassword(normalized.password);
    const userId = `u_${crypto.randomUUID()}`;
    try {
      const user = await createSignupTenantAccount({
        idempotencyKey: normalized.idempotencyKey,
        userId,
        username: normalized.username,
        passwordHash,
        name: normalized.displayName,
        businessName: normalized.businessName,
        defaults: signupDefaults(normalized.businessName),
        promotionCode: normalized.promotionCode,
        selectedPlan: normalized.selectedPlan,
        selectedBilling: normalized.selectedBilling
      });
      if (!user?.tenantId || user.role !== "Owner") {
        return json(res, 500, { ok: false, error: "สมัครใช้งานไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" });
      }
      const session = createSession(user);
      return json(res, 200, { ok: true, user: publicUser(user) }, {
        "Set-Cookie": sessionCookie(session.token, session.expiresAt)
      });
    } catch (error) {
      if (error.code === "ACCOUNT_EXISTS") {
        return json(res, 409, {
          ok: false,
          code: "DUPLICATE_USERNAME",
          field: "username",
          error: "ชื่อผู้ใช้งานนี้ถูกใช้แล้ว กรุณาใช้ชื่ออื่น"
        });
      }
      if (error.code === "IDEMPOTENCY_CONFLICT" || error.code === "INVALID_SIGNUP_INPUT") {
        return json(res, 400, { ok: false, error: "คำขอสมัครไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง" });
      }
      if (String(error.code || "").startsWith("PROMOTION_CODE_")) {
        return json(res, 400, { ok: false, code: error.code, error: safePromotionError(error.code) });
      }
      if (error.code === "SIGNUP_PROVIDER_UNSUPPORTED") {
        return json(res, 503, { ok: false, error: "ระบบสมัครใช้งานยังไม่พร้อมใช้งาน" });
      }
      if (String(error.detail || error.message || "").includes("PGRST202")) {
        return json(res, 503, { ok: false, error: "ระบบสมัครใช้งานกำลังอัปเดต กรุณาลองใหม่อีกครั้ง" });
      }
      console.error("Signup bootstrap failed", error);
      return json(res, 500, { ok: false, error: "สมัครใช้งานไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readBody(req);
    const username = String(body.username || body.userId || "").trim();
    const password = String(body.password || body.pin || "");
    const retryAfter = checkAuthRateLimit(req, "login", username);
    if (retryAfter) {
      return json(res, 429, { ok: false, error: "ลองใหม่อีกครั้งในภายหลัง" }, { "Retry-After": String(retryAfter) });
    }
    const user = typeof findUserForLogin === "function"
      ? await findUserForLogin(username)
      : (await readDb()).users.find(item =>
        item.active !== false &&
        (item.username === username || item.id === username)
      );
    if (!user) return json(res, 401, { ok: false, error: "Username หรือ Password ไม่ถูกต้อง" });
    const upgraded = ensurePasswordHash(user, password);
    if (!verifyPassword(password, user.passwordHash)) {
      return json(res, 401, { ok: false, error: "Username หรือ Password ไม่ถูกต้อง" });
    }
    if (upgraded) {
      const persistPasswordUpgrade = async () => {
        const db = await readDb();
        const storedUser = db.users.find(item => item.id === user.id);
        if (storedUser) {
          storedUser.passwordHash = user.passwordHash;
          delete storedUser.password;
          delete storedUser.pin;
          await writeDb(db);
        }
      };
      if (typeof withTenantContext === "function" && user.tenantId) {
        await withTenantContext(user, persistPasswordUpgrade);
      } else {
        await persistPasswordUpgrade();
      }
    }
    const session = createSession(user);
    return json(res, 200, { ok: true, user: publicUser(user) }, {
      "Set-Cookie": sessionCookie(session.token, session.expiresAt)
    });
  }

  if (req.method === "GET" && url.pathname === "/api/verify/customer-sync") {
    const verification = await verifyCustomerSync();
    return json(res, verification.ok ? 200 : 409, { ok: verification.ok, verification });
  }

  if (req.method === "POST" && url.pathname === "/api/contact-log" && typeof createContactLogFast === "function") {
    const authStartedAt = Date.now();
    const currentUser = await requirePermissionFast(req, res, "customers.edit", "ไม่มีสิทธิ์บันทึกการติดต่อลูกค้า");
    if (!currentUser) return;
    const authMs = Date.now() - authStartedAt;
    const bodyStartedAt = Date.now();
    const body = await readBody(req);
    const bodyMs = Date.now() - bodyStartedAt;
    const customerId = String(body.customerId || "").trim();
    const logDate = toDateOnly(body.date || new Date());
    const logResult = String(body.result || "โทรติด").trim();
    const requestedOrderId = String(body.orderId || body.order_id || body.opportunityCycleId || "").trim();
    const manualOpportunityResult = logResult === OPPORTUNITY_CHAT_RESULT || logResult === OPPORTUNITY_CRM_RESULT;
    const fastStartedAt = Date.now();
    const result = await createContactLogFast({
      customerId,
      date: logDate,
      result: logResult,
      note: String(body.note || "").trim(),
      staff: String(body.staff || body.staffName || "").trim(),
      nextFollowUpDate: toDateOnly(body.nextFollowUpDate || ""),
      orderId: requestedOrderId,
      manualOpportunityResult
    });
    const fastMs = Date.now() - fastStartedAt;
    if (!result?.ok) {
      const status = result?.status || 400;
      return json(res, status, { ok: false, error: result?.error || "บันทึกไม่สำเร็จ" }, {
        "Server-Timing": `auth;dur=${authMs}, parse;dur=${bodyMs}, db;dur=${fastMs}`,
        "X-Contact-Log-Auth-Ms": String(authMs),
        "X-Contact-Log-Db-Ms": String(fastMs)
      });
    }
    const timings = result.timings || {};
    const elapsedMs = Date.now() - requestStartedAt;
    return json(res, 200, {
      ok: true,
      log: result.log,
      duplicate: Boolean(result.duplicate),
      timings: {
        authMs,
        bodyMs,
        ...timings,
        totalMs: elapsedMs
      }
    }, {
      "Server-Timing": [
        `auth;dur=${authMs}`,
        `parse;dur=${bodyMs}`,
        `read;dur=${timings.readMs || 0}`,
        `duplicate;dur=${timings.duplicateMs || 0}`,
        `write;dur=${timings.writeMs || 0}`,
        `serialize;dur=${timings.serializeMs || 0}`,
        `total;dur=${elapsedMs}`
      ].join(", "),
      "X-Contact-Log-Auth-Ms": String(authMs),
      "X-Contact-Log-Read-Ms": String(timings.readMs || 0),
      "X-Contact-Log-Duplicate-Ms": String(timings.duplicateMs || 0),
      "X-Contact-Log-Write-Ms": String(timings.writeMs || 0),
      "X-Contact-Log-Total-Ms": String(elapsedMs),
      "X-Contact-Log-Response-Bytes": String(Buffer.byteLength(JSON.stringify({ ok: true, log: result.log, duplicate: Boolean(result.duplicate) }), "utf8"))
    });
  }

  if (isLineWebhook && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      message: "Growup Pilot LINE webhook endpoint is ready. Use POST /api/line/webhook."
    });
  }

  if (url.pathname.startsWith("/api/import-jobs")) {
    const handled = await handleImportJobsApi(req, res, url);
    if (handled !== false) return;
  }

  if (req.method === "GET" && url.pathname === "/api/permissions") {
    const db = await readDb();
    const currentUser = await requireOwner(req, res, db);
    if (!currentUser) return;
    return json(res, 200, {
      ok: true,
      catalog: PERMISSION_GROUPS,
      recommended: RECOMMENDED_ROLE_PERMISSIONS,
      rolePermissions: normalizedRolePermissions(db.settings || {})
    });
  }

  if (req.method === "PUT" && url.pathname === "/api/permissions") {
    const db = await readDb();
    const currentUser = await requireOwner(req, res, db);
    if (!currentUser) return;
    const body = await readBody(req);
    const next = sanitizeRolePermissions(body.rolePermissions || body.permissions || {});
    const patch = { rolePermissions: next };
    if (typeof persistSettingsPatch === "function") {
      await persistSettingsPatch(patch);
    } else {
      db.settings = { ...(db.settings || {}), ...patch };
      await writeDb(db);
    }
    return json(res, 200, {
      ok: true,
      catalog: PERMISSION_GROUPS,
      recommended: RECOMMENDED_ROLE_PERMISSIONS,
      rolePermissions: next
    });
  }

  if (req.method === "PUT" && url.pathname === "/api/settings/finance") {
    if (!await requirePermission(req, res, null, "reports.costs", "ไม่มีสิทธิ์แก้ไขต้นทุนและการเงิน")) return;
    const body = await readBody(req);
    const patch = {};
    if (body.productCosts !== undefined) {
      patch.productCosts = normalizeSettingsCostRows(body.productCosts, "costPerJar");
    }
    if (body.additionalCosts !== undefined) {
      patch.additionalCosts = normalizeSettingsCostRows(body.additionalCosts, "amount");
    }
    if (patch.productCosts === undefined && patch.additionalCosts === undefined) {
      return json(res, 400, { ok: false, error: "ไม่มีข้อมูลต้นทุนให้บันทึก" });
    }
    const persistStartedAt = Date.now();
    if (typeof persistSettingsPatch === "function") {
      await persistSettingsPatch(patch);
    } else {
      const fallbackDb = await readDb();
      fallbackDb.settings = { ...(fallbackDb.settings || {}), ...patch };
      await writeDb(fallbackDb);
    }
    const persistMs = Date.now() - persistStartedAt;
    return json(res, 200, {
      ok: true,
      settings: financeSettingsPayload(patch)
    }, {
      "Server-Timing": `dbread;dur=0, dbwrite;dur=${persistMs}`,
      "X-Settings-Db-Read-Ms": "0",
      "X-Settings-Db-Write-Ms": String(persistMs)
    });
  }

  if (req.method === "GET" && url.pathname === "/api/products/image-storage/dry-run") {
    if (!await requirePermission(req, res, null, "products.edit", "ไม่มีสิทธิ์จัดการสินค้า")) return;
    const startedAt = Date.now();
    const settings = await readProductSettingsForSave();
    const products = normalizeProductRecords(settings.products);
    const items = productImageMigrationSummary(products);
    return json(res, 200, {
      ok: true,
      storageConfigured: typeof uploadProductImageObject === "function",
      productCount: products.length,
      migrateCount: items.filter(item => item.action === "migrate").length,
      skippedCount: items.filter(item => item.action === "skip").length,
      totalBase64Bytes: items
        .filter(item => item.action === "migrate")
        .reduce((sum, item) => sum + Number(item.bytes || 0), 0),
      items,
      elapsedMs: Date.now() - startedAt
    });
  }

  if (req.method === "POST" && url.pathname === "/api/products/image-storage/migrate") {
    if (!await requirePermission(req, res, null, "products.edit", "ไม่มีสิทธิ์จัดการสินค้า")) return;
    if (typeof uploadProductImageObject !== "function" || typeof verifyPublicProductImageUrl !== "function") {
      return json(res, 501, { ok: false, error: "Product image storage is not configured for this database provider." });
    }
    const readStartedAt = Date.now();
    const settings = await readProductSettingsForSave();
    const readMs = Date.now() - readStartedAt;
    const products = normalizeProductRecords(settings.products);
    const nextProducts = products.map(product => ({ ...product }));
    const migrated = [];
    const skipped = productImageMigrationSummary(products).filter(item => item.action === "skip");
    const uploadStartedAt = Date.now();
    try {
      for (let index = 0; index < nextProducts.length; index += 1) {
        const product = nextProducts[index];
        const plan = productImageStoragePlan(product);
        if (!plan) continue;
        const url = await uploadProductImageObject(plan.objectPath, plan.bytes, plan.mimeType);
        const verified = await verifyPublicProductImageUrl(url);
        if (!verified) throw new Error(`Product image verification failed for ${product.id}`);
        nextProducts[index] = { ...product, image: url, updatedAt: product.updatedAt || new Date().toISOString() };
        migrated.push({
          id: product.id,
          name: product.name,
          sku: product.sku,
          bytes: plan.byteLength,
          mimeType: plan.mimeType,
          objectPath: plan.objectPath,
          url
        });
      }
    } catch (error) {
      return json(res, 500, {
        ok: false,
        error: error.message || "Product image migration failed",
        migratedButNotPersistedCount: migrated.length,
        persisted: false
      });
    }
    const uploadMs = Date.now() - uploadStartedAt;
    const persistStartedAt = Date.now();
    if (migrated.length) await persistSettingsPatch({ products: nextProducts });
    const persistMs = Date.now() - persistStartedAt;
    return json(res, 200, {
      ok: true,
      productCount: products.length,
      migratedCount: migrated.length,
      skippedCount: skipped.length,
      failedCount: 0,
      migrated,
      skipped,
      timings: { readMs, uploadMs, persistMs }
    }, {
      "Server-Timing": `dbread;dur=${readMs}, imageupload;dur=${uploadMs}, dbwrite;dur=${persistMs}`,
      "X-Settings-Db-Read-Ms": String(readMs),
      "X-Product-Image-Upload-Ms": String(uploadMs),
      "X-Settings-Db-Write-Ms": String(persistMs)
    });
  }

  if (req.method === "GET" && url.pathname === "/api/products/image-storage/verify") {
    if (!await requirePermission(req, res, null, "products.view", "ไม่มีสิทธิ์ดูสินค้า")) return;
    const settings = await readProductSettingsForSave();
    const products = normalizeProductRecords(settings.products);
    const storageBaseUrl = typeof productImagePublicBaseUrl === "function" ? productImagePublicBaseUrl() : "";
    const verified = [];
    const failed = [];
    const skipped = [];
    for (const product of products) {
      const image = String(product.image || "").trim();
      if (!image) {
        skipped.push({ id: product.id, name: product.name, reason: "no-image" });
      } else if (parseProductImageDataUrl(image)) {
        skipped.push({ id: product.id, name: product.name, reason: "base64-not-migrated" });
      } else if (storageBaseUrl && image.startsWith(storageBaseUrl) && typeof verifyPublicProductImageUrl === "function") {
        const ok = await verifyPublicProductImageUrl(image);
        (ok ? verified : failed).push({ id: product.id, name: product.name, url: image });
      } else {
        skipped.push({ id: product.id, name: product.name, reason: isHttpImageUrl(image) ? "external-url" : "unsupported-image-format" });
      }
    }
    return json(res, failed.length ? 409 : 200, {
      ok: failed.length === 0,
      productCount: products.length,
      verifiedCount: verified.length,
      skippedCount: skipped.length,
      failedCount: failed.length,
      verified,
      skipped,
      failed
    });
  }

  if (req.method === "POST" && url.pathname === "/api/products/image-storage/rollback") {
    if (!await requirePermission(req, res, null, "products.edit", "ไม่มีสิทธิ์จัดการสินค้า")) return;
    const body = await readBody(req);
    if (body.confirm !== "ROLLBACK_PRODUCT_IMAGES" || !Array.isArray(body.products)) {
      return json(res, 400, { ok: false, error: "Rollback requires confirm=ROLLBACK_PRODUCT_IMAGES and products backup." });
    }
    const patch = { products: normalizeProductRecords(body.products) };
    if (Array.isArray(body.productCosts)) {
      patch.productCosts = normalizeSettingsCostRows(body.productCosts, "costPerJar");
    }
    const persistStartedAt = Date.now();
    await persistSettingsPatch(patch);
    const persistMs = Date.now() - persistStartedAt;
    return json(res, 200, {
      ok: true,
      restoredProductCount: patch.products.length,
      restoredProductCostCount: patch.productCosts?.length || 0,
      persistMs
    }, {
      "X-Settings-Db-Write-Ms": String(persistMs)
    });
  }

  if (req.method === "POST" && url.pathname === "/api/products") {
    if (!await requirePermission(req, res, null, "products.edit", "ไม่มีสิทธิ์เพิ่มสินค้า")) return;
    const body = await readBody(req);
    const readStartedAt = Date.now();
    const settings = await readProductSettingsForSave();
    const readMs = Date.now() - readStartedAt;
    const incoming = normalizeProductRecords([body])[0];
    if (!incoming?.name) return json(res, 400, { ok: false, error: "กรุณาระบุชื่อสินค้า" });
    incoming.id = body.id ? String(body.id) : "";
    const products = normalizeProductRecords(settings.products);
    const incomingIdentity = normalizedProductIdentity(incoming);
    const existingIndex = products.findIndex(item => {
      const identity = normalizedProductIdentity(item);
      return (
        (incoming.id && item.id === incoming.id) ||
        (incomingIdentity.sku && incomingIdentity.sku === identity.sku) ||
        (incomingIdentity.name && incomingIdentity.name === identity.name)
      );
    });
    const previousProduct = existingIndex >= 0 ? products[existingIndex] : null;
    const now = new Date().toISOString();
    const preserveExistingName = existingIndex >= 0
      && !incoming.id
      && incomingIdentity.name
      && incomingIdentity.name === normalizedProductIdentity(products[existingIndex]).name;
    const product = existingIndex >= 0
      ? normalizeProductRecords([{
          ...products[existingIndex],
          ...incoming,
          name: preserveExistingName ? products[existingIndex].name : incoming.name,
          id: products[existingIndex].id,
          archived: false,
          createdAt: products[existingIndex].createdAt || now,
          updatedAt: now
        }])[0]
      : {
          ...incoming,
          id: incoming.id || newProductId(products),
          archived: false,
          createdAt: incoming.createdAt || now,
          updatedAt: now
        };
    const imageStartedAt = Date.now();
    product.image = await storeProductImageForSave(product.id, product.image);
    const imageMs = Date.now() - imageStartedAt;
    if (existingIndex >= 0) products[existingIndex] = product;
    else products.push(product);
    const productCosts = normalizeSettingsCostRows(settings.productCosts, "costPerJar");
    const existingCostIndex = productCostIndex(productCosts, product.id, [
      previousProduct?.name,
      product.name
    ]);
    const costRow = {
      id: product.id,
      name: product.name,
      costPerJar: product.costPerItem,
      enabled: true
    };
    if (existingCostIndex === -1) productCosts.push(costRow);
    else productCosts[existingCostIndex] = costRow;
    const patch = { products, productCosts };
    const persistStartedAt = Date.now();
    await persistSettingsPatch(patch);
    const persistMs = Date.now() - persistStartedAt;
    return json(res, 200, { ok: true, product, settings: productSettingsPayload(patch) }, {
      "Server-Timing": `dbread;dur=${readMs}, image;dur=${imageMs}, dbwrite;dur=${persistMs}`,
      "X-Settings-Db-Read-Ms": String(readMs),
      "X-Product-Image-Upload-Ms": String(imageMs),
      "X-Settings-Db-Write-Ms": String(persistMs)
    });
  }

  if (req.method === "PUT" && /^\/api\/products\/[^/]+$/.test(url.pathname)) {
    if (!await requirePermission(req, res, null, "products.edit", "ไม่มีสิทธิ์แก้ไขสินค้า")) return;
    const productId = decodeURIComponent(url.pathname.split("/").pop() || "");
    const body = await readBody(req);
    const readStartedAt = Date.now();
    const settings = await readProductSettingsForSave();
    const readMs = Date.now() - readStartedAt;
    const products = normalizeProductRecords(settings.products);
    const index = products.findIndex(item => item.id === productId);
    if (index === -1) return json(res, 404, { ok: false, error: "ไม่พบสินค้า" });
    const previous = products[index];
    const next = normalizeProductRecords([{
      ...previous,
      ...body,
      id: productId,
      archived: previous.archived,
      createdAt: previous.createdAt,
      updatedAt: new Date().toISOString()
    }])[0];
    const imageStartedAt = Date.now();
    next.image = await storeProductImageForSave(next.id, next.image);
    const imageMs = Date.now() - imageStartedAt;
    products[index] = next;
    const productCosts = normalizeSettingsCostRows(settings.productCosts, "costPerJar");
    const costIndex = productCostIndex(productCosts, productId, [previous.name, next.name]);
    const costRow = {
      id: productId,
      name: next.name,
      costPerJar: next.costPerItem,
      enabled: !next.archived
    };
    if (costIndex === -1) productCosts.push(costRow);
    else productCosts[costIndex] = costRow;
    const patch = { products, productCosts };
    const persistStartedAt = Date.now();
    await persistSettingsPatch(patch);
    const persistMs = Date.now() - persistStartedAt;
    return json(res, 200, { ok: true, product: next, settings: productSettingsPayload(patch) }, {
      "Server-Timing": `dbread;dur=${readMs}, image;dur=${imageMs}, dbwrite;dur=${persistMs}`,
      "X-Settings-Db-Read-Ms": String(readMs),
      "X-Product-Image-Upload-Ms": String(imageMs),
      "X-Settings-Db-Write-Ms": String(persistMs)
    });
  }

  if (isLineWebhook && req.method === "POST") {
    const body = req._parsedBody || await readBody(req);
    req._parsedBody = body;
    if (dbProvider !== "supabase") {
      const db = await readDb();
      return handleLineWebhookPost(req, res, db);
    }
    if (typeof withTenantContext !== "function" || typeof resolveTenantForLineWebhook !== "function") {
      return json(res, 503, { ok: false, error: "LINE webhook tenant resolver is not configured." });
    }
    const tenant = await resolveTenantForLineWebhook(body);
    if (!tenant) {
      const sourceDiagnostic = Array.isArray(body.events)
        ? {
          eventCount: body.events.length,
          sourceTypes: [...new Set(body.events.map(event => event?.source?.type || "").filter(Boolean))],
          groupIds: [...new Set(body.events.map(event => String(event?.source?.groupId || "").trim()).filter(Boolean))],
          missingGroupId: body.events.some(event => event?.source?.type === "group" && !event?.source?.groupId)
        }
        : { eventCount: 0, sourceTypes: [], groupIds: [], missingGroupId: true };
      const resolverDiagnostic = typeof diagnoseLineWebhookTenantRejection === "function"
        ? await diagnoseLineWebhookTenantRejection(body).catch(error => ({
          category: "diagnostic_failed",
          errorCode: error.code || "",
          errorMessage: safeDiagnosticErrorMessage(error.message || String(error))
        }))
        : { category: "diagnostic_unavailable" };
      console.error("LINE webhook rejected without trusted tenant mapping", JSON.stringify({
        ...sourceDiagnostic,
        resolverCategory: resolverDiagnostic.category || "",
        candidateTenantCount: resolverDiagnostic.candidateTenantCount ?? "",
        malformedTenantCount: resolverDiagnostic.malformedTenantCount ?? "",
        matchedTenantIds: resolverDiagnostic.matchedTenantIds || []
      }));
      return json(res, 403, { ok: false, error: "LINE webhook tenant mapping is not configured." });
    }
    return withTenantContext(tenant, async () => {
      const db = await readDb();
      return handleLineWebhookPost(req, res, db, { tenant });
    });
  }

  const dbReadStartedAt = Date.now();
  const db = await readDb();
  const dbReadMs = Date.now() - dbReadStartedAt;
  const sessionUser = isLineWebhook ? null : requireUser(req, res);
  if (!isLineWebhook && !sessionUser) return;
  const currentUser = isLineWebhook ? null : currentUserFromDb(sessionUser, db);
  if (!isLineWebhook && !currentUser) {
    destroySession(req);
    return json(res, 401, { ok: false, error: "เซสชันหมดอายุหรือผู้ใช้งานถูกปิดใช้งาน" }, { "Set-Cookie": clearSessionCookie() });
  }

  if (!isLineWebhook && isBillingApiPath(url.pathname)) {
    return handleBillingApi(req, res, url, db, currentUser);
  }

  if (!isLineWebhook && isPlatformAdminApiPath(url.pathname)) {
    return handlePlatformAdminApi(req, res, url, currentUser);
  }

  if (!isLineWebhook && !isSubscriptionAccessExempt(url.pathname)) {
    const access = subscriptionAccess(currentSubscription(db));
    if (!access.allowed) return subscriptionBlockedResponse(res, db);
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    const date = url.searchParams.get("date") || toDateOnly();
    const backfilledOrders = backfillMissingOrderProfitSnapshots(db);
    if (backfilledOrders.length) {
      try {
        if (typeof persistOrderProfitSnapshots === "function") {
          await persistOrderProfitSnapshots(backfilledOrders);
        } else {
          await writeDb(db);
        }
      } catch (error) {
        console.error("Profit snapshot lazy backfill persistence failed", JSON.stringify({
          orderCount: backfilledOrders.length,
          message: error.message
        }));
      }
    }
    const enriched = enrichDb(db, date);
    const currentPermissions = permissionPayloadForRole(currentUser.role, enriched.settings || {});
    if (!hasPermission(currentUser, enriched, "orders.view")) enriched.orders = [];
    if (!hasPermission(currentUser, enriched, "customers.view")) enriched.customers = [];
    if (!hasPermission(currentUser, enriched, "products.view")) {
      enriched.settings = { ...(enriched.settings || {}), products: [], productCosts: [] };
    }
    if (!hasPermission(currentUser, enriched, "reports.costs")) {
      enriched.settings = { ...(enriched.settings || {}), productCosts: [], additionalCosts: [] };
    }
    if (!hasPermission(currentUser, enriched, "reports.finance")) {
      enriched.settings = { ...(enriched.settings || {}), adCostRecords: [] };
    }
    let notificationReadIds = [];
    if (typeof readNotificationReadIds === "function") {
      try {
        notificationReadIds = await readNotificationReadIds(currentUser.id);
      } catch (error) {
        // Keep the workspace available while a newly deployed Supabase schema migration is pending.
        console.error("Notification read state unavailable", error.message);
      }
    }
    return json(res, 200, {
      ...enriched,
      settings: publicSettings(enriched.settings),
      users: currentUser.role === "Owner" ? enriched.users.map(publicUser) : [currentUser],
      currentUser,
      notificationReadIds,
      currentPermissions,
      permissionCatalog: currentUser.role === "Owner" ? PERMISSION_GROUPS : [],
      billing: subscriptionBillingPayload(enriched),
      summary: buildSummary(enriched, date)
    });
  }

  if (req.method === "POST" && url.pathname === "/api/notifications/read") {
    const body = await readBody(req);
    const notificationIds = sanitizeNotificationIds(body.notificationIds);
    if (!notificationIds.length) {
      try {
        const notificationReadIds = typeof readNotificationReadIds === "function"
          ? await readNotificationReadIds(currentUser.id)
          : [];
        return json(res, 200, { ok: true, notificationReadIds });
      } catch (error) {
        console.error("Notification read state unavailable", error.message);
        return json(res, 503, { ok: false, error: "บันทึกสถานะอ่านการแจ้งเตือนไม่สำเร็จ" });
      }
    }
    try {
      const notificationReadIds = typeof persistNotificationReadIds === "function"
        ? await persistNotificationReadIds(currentUser.id, notificationIds)
        : [];
      return json(res, 200, { ok: true, notificationReadIds });
    } catch (error) {
      console.error("Notification read persistence failed", error.message);
      return json(res, 503, { ok: false, error: "บันทึกสถานะอ่านการแจ้งเตือนไม่สำเร็จ" });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/marketing-performance") {
    if (!await requirePermission(req, res, db, "reports.finance", "ไม่มีสิทธิ์ดูรายงานการเงิน")) return;
    const date = String(url.searchParams.get("date") || "").trim();
    const month = String(url.searchParams.get("month") || "").trim();
    return json(res, 200, {
      ok: true,
      performance: marketingPerformanceForDb(db, {
        date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "",
        month: /^\d{4}-\d{2}$/.test(month) ? month : ""
      })
    });
  }

  if (req.method === "POST" && url.pathname === "/api/customer-sources") {
    if (!await requirePermission(req, res, db, "orders.create", "ไม่มีสิทธิ์เพิ่มออเดอร์")) return;
    const body = await readBody(req);
    const name = String(body.name || "").trim();
    if (!name) return json(res, 400, { ok: false, error: "กรุณาระบุช่องทางการขาย" });
    const source = normalizeCustomerSourceRecord({ name, sortOrder: 1000 });
    if (!source) return json(res, 400, { ok: false, error: "ช่องทางการขายไม่ถูกต้อง" });
    const defaultSource = DEFAULT_CUSTOMER_SOURCE_CHANNELS.find(item => item.key === source.key);
    if (defaultSource) {
      return json(res, 200, { ok: true, source: defaultSource, settings: customerSourcesSettingsPayload(db.settings || {}) });
    }
    db.settings = db.settings || {};
    const sources = normalizeCustomerSources(db.settings.customerSources);
    const existing = sources.find(item => item.key === source.key);
    if (!existing) {
      sources.push({ ...source, sortOrder: sources.length + DEFAULT_CUSTOMER_SOURCE_CHANNELS.length });
      db.settings.customerSources = normalizeCustomerSources(sources);
      await writeDb(db);
    }
    const saved = existing || db.settings.customerSources.find(item => item.key === source.key) || source;
    return json(res, 200, { ok: true, source: saved, settings: customerSourcesSettingsPayload(db.settings || {}) });
  }

  if (req.method === "POST" && url.pathname === "/api/ad-costs") {
    if (!await requirePermission(req, res, db, "reports.finance", "ไม่มีสิทธิ์จัดการค่าโฆษณา")) return;
    const body = await readBody(req);
    const record = normalizeAdCostInput(db, body);
    if (!record) {
      return json(res, 400, {
        ok: false,
        error: "กรุณาระบุวันที่ สินค้า แพลตฟอร์ม และค่าโฆษณาให้ครบ"
      });
    }
    db.settings.adCostRecords = normalizeAdCostRecords(db.settings.adCostRecords);
    db.settings.adCostRecords.push(record);
    await writeDb(db);
    return json(res, 200, { ok: true, record });
  }

  if (url.pathname.startsWith("/api/ad-costs/")) {
    const id = decodeURIComponent(url.pathname.split("/").pop());
    db.settings.adCostRecords = normalizeAdCostRecords(db.settings.adCostRecords);
    const index = db.settings.adCostRecords.findIndex(record => record.id === id);
    if (index === -1) return json(res, 404, { ok: false, error: "ไม่พบรายการค่าโฆษณา" });
    if (req.method === "PUT") {
      if (!await requirePermission(req, res, db, "reports.finance", "ไม่มีสิทธิ์จัดการค่าโฆษณา")) return;
      const body = await readBody(req);
      const record = normalizeAdCostInput(db, body, db.settings.adCostRecords[index]);
      if (!record) return json(res, 400, { ok: false, error: "ข้อมูลค่าโฆษณาไม่ครบ" });
      db.settings.adCostRecords[index] = record;
      await writeDb(db);
      return json(res, 200, { ok: true, record });
    }
    if (req.method === "DELETE") {
      if (!await requirePermission(req, res, db, "reports.finance", "ไม่มีสิทธิ์จัดการค่าโฆษณา")) return;
      const [record] = db.settings.adCostRecords.splice(index, 1);
      await writeDb(db);
      return json(res, 200, { ok: true, record });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/ad-platforms") {
    if (!await requirePermission(req, res, db, "reports.finance", "ไม่มีสิทธิ์จัดการแพลตฟอร์มโฆษณา")) return;
    const body = await readBody(req);
    const name = String(body.name || "").trim();
    if (!name) return json(res, 400, { ok: false, error: "กรุณาระบุชื่อแพลตฟอร์ม" });
    const platforms = normalizeAdPlatforms(db.settings.adPlatforms, {
      useDefaults: db.settings.adPlatforms === undefined
    });
    const platform = {
      id: uid("ad_platform"),
      name,
      enabled: body.enabled !== false
    };
    platforms.push(platform);
    db.settings.adPlatforms = platforms;
    await writeDb(db);
    return json(res, 200, { ok: true, platform });
  }

  if (url.pathname.startsWith("/api/ad-platforms/")) {
    const id = decodeURIComponent(url.pathname.split("/").pop());
    const platforms = normalizeAdPlatforms(db.settings.adPlatforms, {
      useDefaults: db.settings.adPlatforms === undefined
    });
    const index = platforms.findIndex(platform => platform.id === id);
    if (index === -1) return json(res, 404, { ok: false, error: "ไม่พบแพลตฟอร์ม" });
    if (req.method === "PUT") {
      if (!await requirePermission(req, res, db, "reports.finance", "ไม่มีสิทธิ์จัดการแพลตฟอร์มโฆษณา")) return;
      const body = await readBody(req);
      const name = String(body.name ?? platforms[index].name).trim();
      if (!name) return json(res, 400, { ok: false, error: "กรุณาระบุชื่อแพลตฟอร์ม" });
      platforms[index] = {
        ...platforms[index],
        name,
        enabled: body.enabled === undefined ? platforms[index].enabled : body.enabled !== false
      };
      db.settings.adPlatforms = platforms;
      db.settings.adCostRecords = normalizeAdCostRecords(db.settings.adCostRecords).map(record => (
        record.platformId === id ? { ...record, platformName: name } : record
      ));
      await writeDb(db);
      return json(res, 200, { ok: true, platform: platforms[index] });
    }
    if (req.method === "DELETE") {
      if (!await requirePermission(req, res, db, "reports.finance", "ไม่มีสิทธิ์จัดการแพลตฟอร์มโฆษณา")) return;
      const [platform] = platforms.splice(index, 1);
      db.settings.adPlatforms = platforms;
      await writeDb(db);
      return json(res, 200, { ok: true, platform });
    }
  }

  if (req.method === "PUT" && url.pathname === "/api/profile") {
    const body = await readBody(req);
    const user = db.users.find(item => item.id === currentUser.id);
    if (!user) return json(res, 404, { ok: false, error: "ไม่พบผู้ใช้งาน" });
    const displayName = String(body.displayName || "").trim();
    if (!displayName) return json(res, 400, { ok: false, error: "กรุณาใส่ชื่อที่ต้องการแสดง" });
    let avatar = "";
    try {
      avatar = sanitizeAvatarDataUrl(body.avatar);
    } catch (error) {
      return json(res, 400, { ok: false, error: error.message || "รูปโปรไฟล์ไม่ถูกต้อง" });
    }
    const savedUser = typeof persistUserProfile === "function"
      ? await persistUserProfile(currentUser.id, { displayName, avatar })
      : null;
    if (!savedUser) return json(res, 404, { ok: false, error: "ไม่พบผู้ใช้งาน" });
    const session = createSession(savedUser);
    return json(res, 200, { ok: true, user: publicUser(savedUser) }, {
      "Set-Cookie": sessionCookie(session.token, session.expiresAt)
    });
  }

  if (req.method === "PUT" && url.pathname === "/api/profile/theme") {
    const body = await readBody(req);
    const savedUser = typeof persistUserThemePreference === "function"
      ? await persistUserThemePreference(currentUser.id, normalizeThemePreference(body.themePreference || body.theme))
      : null;
    if (!savedUser) return json(res, 404, { ok: false, error: "ไม่พบผู้ใช้งาน" });
    const session = createSession(savedUser);
    return json(res, 200, { ok: true, user: publicUser(savedUser) }, {
      "Set-Cookie": sessionCookie(session.token, session.expiresAt)
    });
  }

  if (req.method === "GET" && url.pathname === "/api/line-debug") {
    if (!await requirePermission(req, res, db, "system.integrations", "ไม่มีสิทธิ์ดูข้อมูลเชื่อมต่อ")) return;
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 50)));
    const rows = (db.lineMessages || [])
      .map(lineDebugFromMessage)
      .sort((a, b) => String(b.received_at || "").localeCompare(String(a.received_at || "")))
      .slice(0, limit);
    return json(res, 200, { ok: true, summary: lineDebugSummary(rows), rows });
  }

  if (req.method === "POST" && url.pathname === "/api/customers") {
    if (!await requirePermission(req, res, db, "customers.edit", "ไม่มีสิทธิ์เพิ่มลูกค้า")) return;
    return json(res, 409, { ok: false, error: "สร้างลูกค้าแยกเดี่ยวไม่ได้ กรุณาสร้างผ่านออเดอร์" });
  }

  if (req.method === "PUT" && url.pathname.startsWith("/api/customers/")) {
    if (!await requirePermission(req, res, db, "customers.edit", "ไม่มีสิทธิ์แก้ไขลูกค้า")) return;
    const id = url.pathname.split("/").pop();
    const body = await readBody(req);
    const customer = db.customers.find(item => item.id === id);
    if (!customer) return json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
    Object.assign(customer, {
      tags: body.tags !== undefined ? splitTags(body.tags) : customer.tags,
      note: body.note ?? customer.note,
      lastContactDate: body.lastContactDate ?? customer.lastContactDate,
      lastContactNote: body.lastContactNote ?? customer.lastContactNote,
      assignedTo: body.assignedTo ?? customer.assignedTo
    });
    db.tags = Array.from(new Set([...(db.tags || []), ...(customer.tags || [])]));
    await writeDb(db);
    return json(res, 200, { ok: true, customer });
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/customers/")) {
    if (!await requirePermission(req, res, db, "customers.delete", "ไม่มีสิทธิ์ลบลูกค้า")) return;
    const id = url.pathname.split("/").pop();
    const customer = db.customers.find(item => item.id === id);
    if (!customer) return json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
    if (db.orders.some(order => order.customerId === id)) {
      return json(res, 409, { ok: false, error: "ไม่สามารถลบลูกค้าที่ยังมีออเดอร์ได้" });
    }
    await deleteCustomer(id);
    return json(res, 200, { ok: true, deletedCustomerId: id });
  }

  if (req.method === "POST" && url.pathname === "/api/orders") {
    const routeStartedAt = requestStartedAt;
    const timings = { dbReadMs };
    const authStartedAt = Date.now();
    if (!await requirePermission(req, res, db, "orders.create", "ไม่มีสิทธิ์เพิ่มออเดอร์")) return;
    timings.authMs = Date.now() - authStartedAt;
    const bodyStartedAt = Date.now();
    const body = await readBody(req);
    timings.bodyMs = Date.now() - bodyStartedAt;
    let order;
    try {
      const addStartedAt = Date.now();
      order = addOrder(db, body);
      timings.addOrderMs = Date.now() - addStartedAt;
      const inventoryStartedAt = Date.now();
      adjustInventoryForOrderChange(db, null, order);
      timings.inventoryMs = Date.now() - inventoryStartedAt;
    } catch (error) {
      if (error.code === "ORDER_DUPLICATE") {
        return json(res, 409, { ok: false, error: "ออเดอร์นี้มีอยู่แล้ว" });
      }
      if (error.code === "INSUFFICIENT_STOCK") {
        return json(res, 409, {
          ok: false,
          error: error.message,
          product: error.product,
          availableStock: error.availableStock,
          requestedQuantity: error.requestedQuantity
        });
      }
      if (error.code === "PRODUCT_NOT_FOUND") {
        return json(res, 409, { ok: false, error: PRODUCT_RESOLUTION_ERROR });
      }
      throw error;
    }
    const mutationStartedAt = Date.now();
    const mutation = orderMutationPayload(db, {
      orderId: order.id,
      selectedDate: body.selectedDate || toDateOnly()
    });
    timings.mutationMs = Date.now() - mutationStartedAt;
    mutation.clientMutationId = String(body.clientMutationId || "");
    const persistStartedAt = Date.now();
    const persistTimings = typeof persistOrderMutation === "function"
      ? await persistOrderMutation(mutation, db.settings)
      : (await writeDb(db), { totalMs: Date.now() - persistStartedAt });
    timings.persistMs = Date.now() - persistStartedAt;
    timings.totalMs = Date.now() - routeStartedAt;
    console.info("[order-save:server]", JSON.stringify({
      method: "POST",
      orderId: order.id,
      timings,
      persist: persistTimings,
      dbRead: readDb.lastTimings || null
    }));
    return json(res, 200, { ok: true, mutation, timings: { ...timings, persist: persistTimings, dbRead: readDb.lastTimings || null } }, orderSaveHeaders(timings, {
      persist: persistTimings,
      dbRead: readDb.lastTimings || null
    }));
  }

  if (req.method === "PUT" && url.pathname.startsWith("/api/orders/")) {
    const routeStartedAt = requestStartedAt;
    const timings = { dbReadMs };
    const id = url.pathname.split("/").pop();
    const bodyStartedAt = Date.now();
    const body = await readBody(req);
    timings.bodyMs = Date.now() - bodyStartedAt;
    const bodyKeys = Object.keys(body || {});
    const statusOnly = bodyKeys.length > 0 && bodyKeys.every(key => [
      "status",
      "vipCardStatus",
      "vip_card_status",
      "note",
      "selectedDate",
      "clientMutationId"
    ].includes(key));
    const orderPermission = statusOnly ? "orders.status" : "orders.edit";
    const authStartedAt = Date.now();
    if (!await requirePermission(req, res, db, orderPermission, "ไม่มีสิทธิ์แก้ไขออเดอร์")) return;
    timings.authMs = Date.now() - authStartedAt;
    const order = db.orders.find(item => item.id === id);
    if (!order) return json(res, 404, { ok: false, error: "ไม่พบออเดอร์" });
    const previousOrder = { ...order };
    const previousCustomerIds = [order.customerId];
    const customer = db.customers.find(item => item.id === order.customerId);
    if (customer && body.tags !== undefined) {
      customer.tags = splitTags(body.tags);
      db.tags = Array.from(new Set([...(db.tags || []), ...(customer.tags || [])]));
    }
    const nextOriginSource = body.originSource !== undefined || body.origin_source !== undefined || body.originSourceOther !== undefined || body.origin_source_other !== undefined
      ? normalizeOrderOriginSource(
        body.originSource ?? body.origin_source ?? order.originSource,
        body.originSourceOther ?? body.origin_source_other ?? order.originSourceOther
      )
      : { originSource: order.originSource, originSourceOther: order.originSourceOther || "" };
    let resolvedPayload = null;
    try {
      const resolveStartedAt = Date.now();
      resolvedPayload = statusOnly
        ? null
        : applyResolvedProductToPayload(db.settings || {}, { ...order, ...body }, { preservePackageSnapshot: true });
      timings.productResolveMs = Date.now() - resolveStartedAt;
    } catch (error) {
      if (error.code === "PRODUCT_NOT_FOUND") {
        return json(res, 409, { ok: false, error: PRODUCT_RESOLUTION_ERROR });
      }
      throw error;
    }
    Object.assign(order, {
      orderNumber: body.orderNumber !== undefined ? normalizeImportText(body.orderNumber) : order.orderNumber,
      items: resolvedPayload ? resolvedPayload.items : order.items,
      customerName: body.name !== undefined ? String(body.name).trim() : order.customerName,
      phone: body.phone !== undefined ? normalizePhone(body.phone) : order.phone,
      address: body.address !== undefined ? String(body.address).trim() : order.address,
      date: body.date ? toDateOnly(body.date) : order.date,
      jars: body.jars !== undefined ? Number(body.jars) : order.jars,
      amount: body.amount !== undefined ? Number(body.amount) : order.amount,
      source: body.sourceChannel ?? order.source,
      sourceChannel: body.sourceChannel ?? order.sourceChannel,
      alternatePhone: body.alternatePhone ?? order.alternatePhone,
      originSource: nextOriginSource.originSource,
      originSourceOther: nextOriginSource.originSourceOther,
      socialName: body.socialName ?? order.socialName,
      freeGift: body.freeGift ?? order.freeGift,
      productId: resolvedPayload ? String(resolvedPayload.productId || "") : String(order.productId || ""),
      packageId: resolvedPayload ? String(resolvedPayload.packageId || "") : String(order.packageId || ""),
      packageName: resolvedPayload ? String(resolvedPayload.packageName || "") : String(order.packageName || ""),
      paidQuantity: resolvedPayload ? Math.max(0, Number(resolvedPayload.paidQuantity || 0)) : Number(order.paidQuantity || 0),
      freeQuantity: resolvedPayload ? Math.max(0, Number(resolvedPayload.freeQuantity || 0)) : Number(order.freeQuantity || 0),
      totalQuantityShipped: resolvedPayload
        ? Math.max(0, Number(resolvedPayload.totalQuantityShipped || 0))
        : Number(order.totalQuantityShipped || 0),
      packageExpenses: resolvedPayload
        ? normalizePackageExpenses(resolvedPayload.packageExpenses)
        : normalizePackageExpenses(order.packageExpenses),
      vipCardStatus: body.vipCardStatus ?? order.vipCardStatus,
      note: body.note ?? order.note
    });
    const snapshotStartedAt = Date.now();
    applyOrderProfitSnapshot(order, db.settings || {}, "edited");
    timings.profitSnapshotMs = Date.now() - snapshotStartedAt;
    try {
      const inventoryStartedAt = Date.now();
      adjustInventoryForOrderChange(db, previousOrder, order);
      timings.inventoryMs = Date.now() - inventoryStartedAt;
    } catch (error) {
      Object.assign(order, previousOrder);
      if (error.code === "INSUFFICIENT_STOCK") {
        return json(res, 409, {
          ok: false,
          error: error.message,
          product: error.product,
          availableStock: error.availableStock,
          requestedQuantity: error.requestedQuantity
        });
      }
      if (error.code === "PRODUCT_NOT_FOUND") {
        return json(res, 409, { ok: false, error: PRODUCT_RESOLUTION_ERROR });
      }
      throw error;
    }
    const mutationStartedAt = Date.now();
    const mutation = orderMutationPayload(db, {
      orderId: order.id,
      previousCustomerIds,
      selectedDate: body.selectedDate || toDateOnly()
    });
    timings.mutationMs = Date.now() - mutationStartedAt;
    mutation.clientMutationId = String(body.clientMutationId || "");
    const persistStartedAt = Date.now();
    const persistTimings = typeof persistOrderMutation === "function"
      ? await persistOrderMutation(mutation, db.settings)
      : (await writeDb(db), { totalMs: Date.now() - persistStartedAt });
    timings.persistMs = Date.now() - persistStartedAt;
    timings.totalMs = Date.now() - routeStartedAt;
    console.info("[order-save:server]", JSON.stringify({
      method: "PUT",
      orderId: order.id,
      timings,
      persist: persistTimings,
      dbRead: readDb.lastTimings || null
    }));
    return json(res, 200, { ok: true, mutation, timings: { ...timings, persist: persistTimings, dbRead: readDb.lastTimings || null } }, orderSaveHeaders(timings, {
      persist: persistTimings,
      dbRead: readDb.lastTimings || null
    }));
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/orders/")) {
    if (!await requirePermission(req, res, db, "orders.delete", "ไม่มีสิทธิ์ลบออเดอร์")) return;
    const id = url.pathname.split("/").pop();
    const orderIndex = db.orders.findIndex(item => item.id === id);
    if (orderIndex === -1) return json(res, 404, { ok: false, error: "ไม่พบออเดอร์" });
    const [deletedOrder] = db.orders.splice(orderIndex, 1);
    adjustInventoryForOrderChange(db, deletedOrder, null);
    const mutation = orderMutationPayload(db, {
      deletedOrderId: id,
      previousCustomerIds: deletedOrder?.customerId ? [deletedOrder.customerId] : [],
      selectedDate: url.searchParams.get("date") || toDateOnly()
    });
    if (typeof persistOrderMutation === "function") await persistOrderMutation(mutation, db.settings);
    else await writeDb(db);
    return json(res, 200, { ok: true, mutation });
  }

  if (req.method === "POST" && url.pathname === "/api/import") {
    if (!await requirePermission(req, res, db, "customers.import", "ไม่มีสิทธิ์นำเข้าข้อมูล")) return;
    const body = await readBody(req);
    const type = body.type || "csv";
    const content = body.content || "";
    const imported = [];
    let duplicates = 0;

    if (type === "line") {
      const parsedRows = parseLineImportContent(content, db.settings.defaultJarPrice);
      for (const parsed of parsedRows) {
        if (parsed?.phone) {
          try {
            const order = addOrder(db, parsed);
            adjustInventoryForOrderChange(db, null, order);
            imported.push(order);
          } catch (error) {
            if (error.code !== "ORDER_DUPLICATE") throw error;
            duplicates += 1;
          }
        }
      }
    } else {
      const prepared = prepareCsvImport(content, db);
      duplicates = prepared.duplicates;
      for (const row of prepared.rows) {
        if (!row.duplicate) {
          try {
            const order = addOrder(db, row);
            adjustInventoryForOrderChange(db, null, order);
            imported.push(order);
          } catch (error) {
            if (error.code !== "ORDER_DUPLICATE") throw error;
            duplicates += 1;
          }
        }
      }
    }

    await writeDb(db);
    return json(res, 200, { ok: true, imported: imported.length, duplicates });
  }

  if (req.method === "POST" && url.pathname === "/api/csv-preview") {
    if (!await requirePermission(req, res, db, "customers.import", "ไม่มีสิทธิ์นำเข้าข้อมูล")) return;
    const body = await readBody(req);
    const prepared = prepareCsvImport(body.content || "", db);
    return json(res, 200, { ok: true, ...prepared });
  }

  if (req.method === "POST" && url.pathname === "/api/parse-preview") {
    if (!await requirePermission(req, res, db, "customers.import", "ไม่มีสิทธิ์นำเข้าข้อมูล")) return;
    const body = await readBody(req);
    const content = body.content || "";
    const rows = parseLineImportContent(content, db.settings.defaultJarPrice)
      .map((parsed, index) => ({ id: index + 1, ...parsed }));
    return json(res, 200, { ok: true, rows });
  }

  if (req.method === "POST" && url.pathname === "/api/line/webhook") {
    const body = req._parsedBody || await readBody(req);
    const signature = req.headers["x-line-signature"];
    const settings = effectiveSettings(db.settings);
    const httpDebug = addHttpWebhookDebug(db, req, body._rawBody || "", { signatureValidation: "pending" });
    console.log("LINE webhook raw body", JSON.stringify({
      receivedAt: httpDebug.received_at,
      hasEvents: Array.isArray(body.events),
      eventCount: Array.isArray(body.events) ? body.events.length : -1,
      bodyLength: Buffer.byteLength(body._rawBody || "", "utf8"),
      bodyPreview: String(body._rawBody || "").slice(0, 1200)
    }));
    if (!settings.lineWebhookEnabled) {
      httpDebug.signature_validation = "not_checked";
      httpDebug.error_message = "LINE webhook disabled.";
      persistWebhookDebugAsync(db);
      return json(res, 200, { ok: true, received: 0, verification: true });
    }
    if (!verifyLineSignature(body._rawBody, settings.lineChannelSecret, signature)) {
      httpDebug.signature_validation = "fail";
      httpDebug.error_message = "LINE signature validation failed.";
      persistWebhookDebugAsync(db);
      return json(res, 200, { ok: true, received: 0, verification: true });
    }
    httpDebug.signature_validation = "pass";
    const events = Array.isArray(body.events) ? body.events : [{ message: { text: body.text || body.content || "" } }];
    if (!Array.isArray(body.events)) {
      console.log("LINE webhook no events array", JSON.stringify({
        receivedAt: httpDebug.received_at,
        eventType: body.type || "",
        sourceType: body.source?.type || "",
        hasBodyEvents: false
      }));
    } else if (!body.events.length) {
      console.log("LINE webhook empty events array", JSON.stringify({
        receivedAt: httpDebug.received_at,
        eventType: body.type || "",
        sourceType: body.source?.type || "",
        hasBodyEvents: true,
        eventCount: 0
      }));
    }
    if (!events.length) {
      persistWebhookDebugAsync(db);
      return json(res, 200, { ok: true, received: 0, verification: true });
    }
    const parsedOrders = await handleLineWebhookEvents(db, settings, events);
    return json(res, 200, { ok: true, received: events.length, parsedOrders: parsedOrders.length });
  }

  if (req.method === "POST" && url.pathname === "/api/line/mock") {
    if (!await requirePermission(req, res, db, "system.integrations", "ไม่มีสิทธิ์ทดสอบ LINE")) return;
    const body = await readBody(req);
    const rawText = String(body.text || body.content || "คุณทดสอบ โทร 0891234567 2 กระปุก รวม 1500 บาท #ทดสอบ");
    db.lineMessages = db.lineMessages || [];
    db.lineMessages.push({
      id: uid("line"),
      receivedAt: new Date().toISOString(),
      rawEvent: { type: "mock", message: { text: rawText } },
      text: rawText,
      raw_text: rawText
    });
    const parsed = parseLineOrder(rawText, db.settings.defaultJarPrice);
    const parsedOrders = [];
    if (parsed?.phone) {
      const order = addOrder(db, parsed);
      adjustInventoryForOrderChange(db, null, order);
      parsedOrders.push(order);
    }
    await writeDb(db);
    return json(res, 200, { ok: true, parsedOrders: parsedOrders.length, rows: parsedOrders });
  }

  if (req.method === "POST" && url.pathname === "/api/settings/business-logo") {
    const currentUser = await requirePermission(req, res, db, "system.business", "ไม่มีสิทธิ์แก้ไขการตั้งค่าธุรกิจ");
    if (!currentUser) return;
    const body = await readBody(req);
    try {
      const logoUrl = await storeBusinessLogoForSave(body.logoDataUrl || body.logo || "");
      db.settings = db.settings || {};
      const profile = normalizeBusinessProfile(db.settings);
      db.settings.businessProfile = { ...profile, logoUrl };
      db.settings.businessLogoUrl = logoUrl;
      await writeDb(db);
      return json(res, 200, { ok: true, logoUrl, settings: publicSettings(db.settings) });
    } catch (error) {
      return json(res, 400, { ok: false, error: error.message || "อัปโหลดโลโก้ไม่สำเร็จ" });
    }
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/integrations/")) {
    const currentUser = await requirePermission(req, res, db, "system.integrations", "ไม่มีสิทธิ์แก้ไขการเชื่อมต่อระบบ");
    if (!currentUser) return;
    const parts = url.pathname.split("/").filter(Boolean);
    const provider = parts[2] || "";
    const action = parts[3] || "";
    if (provider === "openai" && action === "test") {
      const effective = effectiveSettings(db.settings || {});
      return json(res, 200, {
        ok: Boolean(effective.openaiApiKey),
        status: effective.openaiApiKey ? "configured" : "unavailable",
        model: effective.openaiModel || "gpt-4.1-mini",
        error: effective.openaiApiKey ? "" : "ยังไม่ได้ตั้งค่า OPENAI_API_KEY หรือ OpenAI key ฝั่ง server"
      });
    }
    if (["google-drive", "facebook"].includes(provider) && ["connect", "reconnect", "disconnect"].includes(action)) {
      const isGoogle = provider === "google-drive";
      const missing = isGoogle
        ? !(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
        : !(process.env.META_CLIENT_ID && process.env.META_CLIENT_SECRET);
      if (action === "disconnect") {
        db.settings = db.settings || {};
        const integrations = normalizeIntegrationSettings(db.settings);
        const key = isGoogle ? "googleDrive" : "facebook";
        integrations[key] = { connected: false, account: "", error: missing ? integrations[key].error : "" };
        db.settings.integrations = integrations;
        await writeDb(db);
        return json(res, 200, { ok: true, settings: publicSettings(db.settings) });
      }
      return json(res, missing ? 501 : 501, {
        ok: false,
        status: "blocked",
        provider,
        error: isGoogle
          ? "ยังไม่ได้ตั้งค่าการเชื่อมต่อ Google Drive สำหรับระบบใช้งาน"
          : "ยังไม่ได้ตั้งค่าการเชื่อมต่อ Facebook สำหรับระบบใช้งาน"
      });
    }
  }

  if (req.method === "PUT" && url.pathname === "/api/settings") {
    const currentUser = await requirePermission(req, res, db, "system.business", "ไม่มีสิทธิ์แก้ไขการตั้งค่าธุรกิจ");
    if (!currentUser) return;
    const body = await readBody(req);
    const hasIntegrationPatch = [
      "lineChannelId",
      "lineChannelSecret",
      "lineChannelAccessToken",
      "lineGroupId",
      "openaiModel",
      "lineWebhookEnabled",
      "aiPreferences",
      "integrations"
    ].some(key => Object.prototype.hasOwnProperty.call(body, key));
    if (hasIntegrationPatch && !hasPermission(currentUser, db, "system.integrations")) {
      return json(res, 403, { ok: false, error: "ไม่มีสิทธิ์แก้ไขการเชื่อมต่อระบบ" });
    }
    const hasFinancePatch = ["productCosts", "additionalCosts"].some(key => Object.prototype.hasOwnProperty.call(body, key));
    if (hasFinancePatch && !hasPermission(currentUser, db, "reports.costs")) {
      return json(res, 403, { ok: false, error: "ไม่มีสิทธิ์แก้ไขต้นทุนและการเงิน" });
    }
    const hasVipThresholdPatch = [
      "vipThreshold",
      "vvipThreshold",
      "superVipThreshold",
      "vip",
      "vvip",
      "superVip"
    ].some(key => Object.prototype.hasOwnProperty.call(body, key));
    if (hasVipThresholdPatch && currentUser.role !== "Owner") {
      return json(res, 403, { ok: false, error: "เฉพาะ Owner เท่านั้นที่แก้ไข VIP Level Settings ได้" });
    }
    const vipThresholdResult = normalizedVipThresholds(body, db.settings || {});
    if (!vipThresholdResult.ok) return json(res, 400, { ok: false, error: vipThresholdResult.error });
    const existingSettings = db.settings || {};
    const existingProfile = normalizeBusinessProfile(existingSettings);
    const bodyProfile = body.businessProfile && typeof body.businessProfile === "object" ? body.businessProfile : {};
    const nextProfile = {
      name: optionalTextPatch(bodyProfile.name ?? body.businessName, existingProfile.name),
      type: optionalTextPatch(bodyProfile.type ?? body.businessType, existingProfile.type),
      address: optionalTextPatch(bodyProfile.address ?? body.businessAddress, existingProfile.address),
      phone: optionalTextPatch(bodyProfile.phone ?? body.businessPhone, existingProfile.phone),
      email: optionalTextPatch(bodyProfile.email ?? body.businessEmail, existingProfile.email),
      logoUrl: optionalTextPatch(bodyProfile.logoUrl ?? body.businessLogoUrl, existingProfile.logoUrl)
    };
    const nextGoals = body.businessGoals === undefined
      ? normalizeBusinessGoals(existingSettings.businessGoals)
      : normalizeBusinessGoals(body.businessGoals);
    const nextAiPreferences = body.aiPreferences === undefined
      ? normalizeAiPreferences(existingSettings.aiPreferences)
      : normalizeAiPreferences(body.aiPreferences);
    const nextNotificationPreferences = body.notificationPreferences === undefined
      ? normalizeNotificationPreferences(existingSettings.notificationPreferences)
      : normalizeNotificationPreferences(body.notificationPreferences);
    const nextDisplayPreferences = body.displayPreferences === undefined
      ? normalizeDisplayPreferences(existingSettings.displayPreferences)
      : normalizeDisplayPreferences(body.displayPreferences);
    db.settings = {
      ...db.settings,
      businessName: nextProfile.name,
      businessType: nextProfile.type,
      businessAddress: nextProfile.address,
      businessPhone: nextProfile.phone,
      businessEmail: nextProfile.email,
      businessLogoUrl: nextProfile.logoUrl,
      businessProfile: nextProfile,
      businessGoals: nextGoals,
      aiPreferences: nextAiPreferences,
      notificationPreferences: nextNotificationPreferences,
      displayPreferences: nextDisplayPreferences,
      integrations: normalizeIntegrationSettings(existingSettings),
      defaultJarPrice: Number(body.defaultJarPrice || existingSettings.defaultJarPrice || 750),
      vipThresholds: vipThresholdResult.thresholds,
      messageTemplates: {
        normal: String(body.normalTemplate ?? existingSettings.messageTemplates?.normal ?? ""),
        vip: String(body.vipTemplate ?? existingSettings.messageTemplates?.vip ?? "")
      },
      followUpDaysPerUnit: Math.max(1, Number(body.followUpDaysPerUnit || existingSettings.followUpDaysPerUnit || 15)),
      products: body.products === undefined
        ? normalizeProductRecords(existingSettings.products)
        : normalizeProductRecords(body.products),
      productCosts: body.productCosts === undefined
        ? normalizeSettingsCostRows(existingSettings.productCosts, "costPerJar")
        : normalizeSettingsCostRows(body.productCosts, "costPerJar"),
      additionalCosts: body.additionalCosts === undefined
        ? normalizeSettingsCostRows(existingSettings.additionalCosts, "amount")
        : normalizeSettingsCostRows(body.additionalCosts, "amount"),
      customerSources: body.customerSources === undefined
        ? normalizeCustomerSources(existingSettings.customerSources)
        : normalizeCustomerSources(body.customerSources),
      lineChannelId: process.env.LINE_CHANNEL_ID
        ? existingSettings.lineChannelId || ""
        : String(body.lineChannelId ?? existingSettings.lineChannelId ?? ""),
      lineChannelSecret: process.env.LINE_CHANNEL_SECRET
        ? existingSettings.lineChannelSecret || ""
        : secretInputValue(body.lineChannelSecret, existingSettings.lineChannelSecret),
      lineChannelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
        ? existingSettings.lineChannelAccessToken || ""
        : secretInputValue(body.lineChannelAccessToken, existingSettings.lineChannelAccessToken),
      lineGroupId: process.env.LINE_GROUP_ID
        ? existingSettings.lineGroupId || ""
        : String(body.lineGroupId ?? existingSettings.lineGroupId ?? ""),
      openaiModel: process.env.OPENAI_MODEL
        ? existingSettings.openaiModel || "gpt-4.1-mini"
        : String(body.openaiModel ?? existingSettings.openaiModel ?? "gpt-4.1-mini"),
      lineWebhookEnabled: body.lineWebhookEnabled === undefined
        ? Boolean(existingSettings.lineWebhookEnabled)
        : Boolean(body.lineWebhookEnabled),
      staffCanExport: body.staffCanExport === undefined
        ? Boolean(existingSettings.staffCanExport)
        : Boolean(body.staffCanExport),
      rolePermissions: sanitizeRolePermissions(existingSettings.rolePermissions || {})
    };
    await writeDb(db);
    return json(res, 200, { ok: true, settings: publicSettings(db.settings) }, {
      "Server-Timing": `dbread;dur=${dbReadMs}`,
      "X-Settings-Db-Read-Ms": String(dbReadMs)
    });
  }

  if (req.method === "POST" && url.pathname === "/api/products") {
    if (!await requirePermission(req, res, db, "products.edit", "ไม่มีสิทธิ์เพิ่มสินค้า")) return;
    const body = await readBody(req);
    const incoming = normalizeProductRecords([body])[0];
    if (!incoming?.name) return json(res, 400, { ok: false, error: "กรุณาระบุชื่อสินค้า" });
    incoming.id = body.id ? String(body.id) : "";
    const products = normalizeProductRecords(db.settings.products);
    const incomingIdentity = normalizedProductIdentity(incoming);
    const existingIndex = products.findIndex(item => {
      const identity = normalizedProductIdentity(item);
      return (
        (incoming.id && item.id === incoming.id) ||
        (incomingIdentity.sku && incomingIdentity.sku === identity.sku) ||
        (incomingIdentity.name && incomingIdentity.name === identity.name)
      );
    });
    const previousProduct = existingIndex >= 0 ? products[existingIndex] : null;
    const now = new Date().toISOString();
    const preserveExistingName = existingIndex >= 0
      && !incoming.id
      && incomingIdentity.name
      && incomingIdentity.name === normalizedProductIdentity(products[existingIndex]).name;
    const product = existingIndex >= 0
      ? normalizeProductRecords([{
          ...products[existingIndex],
          ...incoming,
          name: preserveExistingName ? products[existingIndex].name : incoming.name,
          id: products[existingIndex].id,
          archived: false,
          createdAt: products[existingIndex].createdAt || now,
          updatedAt: now
        }])[0]
      : {
          ...incoming,
          id: incoming.id || newProductId(products),
          archived: false,
          createdAt: incoming.createdAt || now,
          updatedAt: now
        };
    if (existingIndex >= 0) products[existingIndex] = product;
    else products.push(product);
    const productCosts = normalizeSettingsCostRows(db.settings.productCosts, "costPerJar");
    const existingCostIndex = productCostIndex(productCosts, product.id, [
      previousProduct?.name,
      product.name
    ]);
    const costRow = {
      id: product.id,
      name: product.name,
      costPerJar: product.costPerItem,
      enabled: true
    };
    if (existingCostIndex === -1) productCosts.push(costRow);
    else productCosts[existingCostIndex] = costRow;
    const patch = { products, productCosts };
    const persistStartedAt = Date.now();
    if (typeof persistSettingsPatch === "function") {
      await persistSettingsPatch(patch);
    } else {
      db.settings = { ...db.settings, ...patch };
      await writeDb(db);
    }
    const persistMs = Date.now() - persistStartedAt;
    return json(res, 200, { ok: true, product, settings: productSettingsPayload(patch) }, {
      "Server-Timing": `dbread;dur=0, dbwrite;dur=${persistMs}`,
      "X-Settings-Db-Read-Ms": "0",
      "X-Settings-Db-Write-Ms": String(persistMs)
    });
  }

  if (req.method === "PUT" && /^\/api\/products\/[^/]+$/.test(url.pathname)) {
    if (!await requirePermission(req, res, db, "products.edit", "ไม่มีสิทธิ์แก้ไขสินค้า")) return;
    const productId = decodeURIComponent(url.pathname.split("/").pop() || "");
    const body = await readBody(req);
    const products = normalizeProductRecords(db.settings.products);
    const index = products.findIndex(item => item.id === productId);
    if (index === -1) return json(res, 404, { ok: false, error: "ไม่พบสินค้า" });
    const previous = products[index];
    const next = normalizeProductRecords([{
      ...previous,
      ...body,
      id: productId,
      archived: previous.archived,
      createdAt: previous.createdAt,
      updatedAt: new Date().toISOString()
    }])[0];
    products[index] = next;
    const productCosts = normalizeSettingsCostRows(db.settings.productCosts, "costPerJar");
    const costIndex = productCostIndex(productCosts, productId, [previous.name, next.name]);
    const costRow = {
      id: productId,
      name: next.name,
      costPerJar: next.costPerItem,
      enabled: !next.archived
    };
    if (costIndex === -1) productCosts.push(costRow);
    else productCosts[costIndex] = costRow;
    const patch = { products, productCosts };
    const persistStartedAt = Date.now();
    if (typeof persistSettingsPatch === "function") {
      await persistSettingsPatch(patch);
    } else {
      db.settings = { ...db.settings, ...patch };
      await writeDb(db);
    }
    const persistMs = Date.now() - persistStartedAt;
    return json(res, 200, { ok: true, product: next, settings: productSettingsPayload(patch) }, {
      "Server-Timing": `dbread;dur=0, dbwrite;dur=${persistMs}`,
      "X-Settings-Db-Read-Ms": "0",
      "X-Settings-Db-Write-Ms": String(persistMs)
    });
  }

  if (req.method === "POST" && /^\/api\/products\/[^/]+\/archive$/.test(url.pathname)) {
    if (!await requirePermission(req, res, db, "products.delete", "ไม่มีสิทธิ์ลบสินค้า")) return;
    const parts = url.pathname.split("/");
    const productId = decodeURIComponent(parts[parts.length - 2] || "");
    const body = await readBody(req);
    const products = normalizeProductRecords(db.settings.products);
    const index = products.findIndex(item => item.id === productId);
    if (index === -1) return json(res, 404, { ok: false, error: "ไม่พบสินค้า" });
    const archived = body.archived === undefined ? true : Boolean(body.archived);
    products[index] = {
      ...products[index],
      archived,
      status: archived ? "ปิดใช้งาน" : "พร้อมขาย",
      updatedAt: new Date().toISOString()
    };
    const productCosts = normalizeSettingsCostRows(db.settings.productCosts, "costPerJar").map(item => (
      item.id === productId || item.name === products[index].name
        ? { ...item, enabled: !archived }
        : item
    ));
    const patch = { products, productCosts };
    if (typeof persistSettingsPatch === "function") {
      await persistSettingsPatch(patch);
    } else {
      db.settings = { ...db.settings, ...patch };
      await writeDb(db);
    }
    db.settings = { ...db.settings, ...patch };
    return json(res, 200, {
      ok: true,
      productId,
      archived,
      counts: productManagementCounts(db.settings)
    });
  }

  if (req.method === "DELETE" && /^\/api\/products\/[^/]+$/.test(url.pathname)) {
    if (!await requirePermission(req, res, db, "products.delete", "ไม่มีสิทธิ์ลบสินค้า")) return;
    const productId = decodeURIComponent(url.pathname.split("/").pop() || "");
    const products = normalizeProductRecords(db.settings.products);
    const index = products.findIndex(item => item.id === productId);
    if (index === -1) return json(res, 404, { ok: false, error: "ไม่พบสินค้า" });
    const product = products[index];
    const references = productReferenceReport(db, product);
    const externalReferenceCount = references.total - references.productCosts.length;
    if (externalReferenceCount > 0) {
      return json(res, 409, {
        ok: false,
        error: "ไม่สามารถลบสินค้านี้ถาวรได้ เพราะยังมีประวัติออเดอร์หรือข้อมูลที่อ้างอิงสินค้าอยู่ กรุณาปิดใช้งานสินค้าแทนเพื่อเก็บประวัติเดิมไว้",
        canDisable: true,
        references: {
          orders: references.orders.length,
          packageOrders: references.packageOrders.length,
          adCostRecords: references.adCostRecords.length,
          contactLogs: references.contactLogs.length
        }
      });
    }
    products.splice(index, 1);
    const productCosts = normalizeSettingsCostRows(db.settings.productCosts, "costPerJar").filter(item =>
      item.id !== productId && normalizedProductNameKey(item.name) !== normalizedProductNameKey(product.name)
    );
    const patch = { products, productCosts };
    if (typeof persistSettingsPatch === "function") {
      await persistSettingsPatch(patch);
    } else {
      db.settings = { ...db.settings, ...patch };
      await writeDb(db);
    }
    db.settings = { ...db.settings, ...patch };
    return json(res, 200, {
      ok: true,
      productId,
      deletedProductId: productId,
      deleted: true,
      counts: productManagementCounts(db.settings)
    });
  }

  if (req.method === "PUT" && url.pathname === "/api/followup-rules") {
    if (!await requirePermission(req, res, db, "system.business", "ไม่มีสิทธิ์ตั้งค่าการติดตาม")) return;
    const body = await readBody(req);
    const daysPerUnit = Math.max(1, Number(body.daysPerUnit || db.settings.followUpDaysPerUnit || 15));
    db.settings = {
      ...db.settings,
      followUpDaysPerUnit: daysPerUnit
    };
    db.followUpRules = buildFollowUpRules(daysPerUnit);
    await writeDb(db);
    return json(res, 200, {
      ok: true,
      daysPerUnit,
      rules: db.followUpRules,
      settings: publicSettings(db.settings)
    });
  }

  if (req.method === "POST" && url.pathname === "/api/team") {
    if (!await requireOwner(req, res, db)) return;
    const body = await readBody(req);
    const role = normalizeUserRole(body.role);
    if (!canManageUser(currentUser, null, role)) {
      return json(res, 403, { ok: false, error: "Admin ไม่สามารถสร้างหรือกำหนด Owner ได้" });
    }
    const password = String(body.password || body.pin || "").trim();
    const username = String(body.username || "").trim();
    const name = String(body.name || body.displayName || "").trim();
    if (!name) return json(res, 400, { ok: false, error: "กรุณาใส่ชื่อผู้ใช้งาน" });
    if (!username) return json(res, 400, { ok: false, error: "กรุณาใส่ชื่อเข้าใช้งาน" });
    if (!password) return json(res, 400, { ok: false, error: "กรุณาตั้งรหัสผ่าน" });
    if ((db.users || []).some(item => String(item.username || "").trim() === username)) {
      return json(res, 409, { ok: false, error: "ชื่อเข้าใช้งานนี้ถูกใช้แล้ว" });
    }
    const subscription = currentSubscription(db);
    const maxUsers = planEntitlement(subscription?.plan).maxUsers;
    if (body.active !== false && maxUsers !== null && activeTenantUserCount(db) >= maxUsers) {
      return json(res, 402, {
        ok: false,
        code: "PLAN_USER_LIMIT_REACHED",
        error: `แพ็กเกจ ${subscription?.plan || "starter"} รองรับผู้ใช้งานสูงสุด ${maxUsers} คน`,
        billing: subscriptionBillingPayload(db)
      });
    }
    const user = {
      id: uid("u"),
      name,
      username,
      role,
      phone: "",
      passwordHash: hashPassword(password),
      active: body.active !== false
    };
    db.users.push(user);
    await writeDb(db);
    return json(res, 200, { ok: true, user: publicUser(user) });
  }

  if (req.method === "PUT" && url.pathname.startsWith("/api/team/")) {
    if (!await requireOwner(req, res, db)) return;
    const id = url.pathname.split("/").pop();
    const body = await readBody(req);
    const user = db.users.find(item => item.id === id);
    if (!user) return json(res, 404, { ok: false, error: "ไม่พบผู้ใช้" });
    const nextRole = body.role !== undefined ? normalizeUserRole(body.role) : user.role;
    if (!canManageUser(currentUser, user, nextRole)) {
      return json(res, 403, { ok: false, error: "Admin ไม่สามารถแก้ไขหรือลดสิทธิ์ Owner ได้" });
    }
    if (user.role === "Owner" && nextRole !== "Owner" && isLastActiveOwner(db.users, user)) {
      return json(res, 409, { ok: false, error: "ต้องมี Owner อย่างน้อย 1 บัญชีเสมอ" });
    }
    if (user.role === "Owner" && user.active !== false && body.active === false && isLastActiveOwner(db.users, user)) {
      return json(res, 409, { ok: false, error: "ไม่สามารถปิดใช้งาน Owner คนสุดท้ายได้" });
    }
    if (body.active === true && user.active === false) {
      const subscription = currentSubscription(db);
      const maxUsers = planEntitlement(subscription?.plan).maxUsers;
      if (maxUsers !== null && activeTenantUserCount(db) >= maxUsers) {
        return json(res, 402, {
          ok: false,
          code: "PLAN_USER_LIMIT_REACHED",
          error: `แพ็กเกจ ${subscription?.plan || "starter"} รองรับผู้ใช้งานสูงสุด ${maxUsers} คน`,
          billing: subscriptionBillingPayload(db)
        });
      }
    }
    if (body.username !== undefined) {
      const username = String(body.username).trim();
      if (!username) return json(res, 400, { ok: false, error: "กรุณาใส่ชื่อเข้าใช้งาน" });
      if (db.users.some(item => item.id !== id && String(item.username || "").trim() === username)) {
        return json(res, 409, { ok: false, error: "ชื่อเข้าใช้งานนี้ถูกใช้แล้ว" });
      }
      user.username = username;
    }
    if (body.name !== undefined || body.displayName !== undefined) {
      const name = String(body.name ?? body.displayName ?? "").trim();
      if (!name) return json(res, 400, { ok: false, error: "กรุณาใส่ชื่อผู้ใช้งาน" });
      user.name = name;
    }
    user.phone = "";
    user.role = nextRole;
    if (body.active !== undefined) user.active = Boolean(body.active);
    if (body.password) {
      user.passwordHash = hashPassword(body.password);
      delete user.password;
      delete user.pin;
    }
    await writeDb(db);
    return json(res, 200, { ok: true, user: publicUser(user) });
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/team/")) {
    if (!await requireOwner(req, res, db)) return;
    const id = url.pathname.split("/").pop();
    const user = db.users.find(item => item.id === id);
    if (!user) return json(res, 404, { ok: false, error: "ไม่พบผู้ใช้" });
    if (!canManageUser(currentUser, user)) {
      return json(res, 403, { ok: false, error: "Admin ไม่สามารถลบ Owner ได้" });
    }
    if (isLastActiveOwner(db.users, user)) {
      return json(res, 409, { ok: false, error: "ไม่สามารถลบ Owner คนสุดท้ายได้" });
    }
    if (currentUser.id === id && currentUser.role === "Owner") {
      return json(res, 409, { ok: false, error: "ไม่สามารถลบ Owner ที่กำลังใช้งานอยู่ได้" });
    }
    db.users = db.users.filter(item => item.id !== id);
    if (typeof deleteUser === "function") await deleteUser(id);
    else await writeDb(db);
    return json(res, 200, { ok: true, deletedUserId: id });
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/export/")) {
    const type = url.pathname.split("/").pop();
    const exportPermission = type === "orders"
      ? "orders.export"
      : type === "customers" ? "customers.export" : "reports.export";
    if (!await requirePermission(req, res, db, exportPermission, "ไม่มีสิทธิ์ส่งออกข้อมูล")) return;
    const date = url.searchParams.get("date") || toDateOnly();
    const enriched = enrichDb(db, date);
    if (type === "customers") {
      return csvResponse(res, "customers.csv", enriched.customers.map(customer => ({
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        status: customer.status,
        vipLevel: customer.vipLevel,
        totalOrders: customer.purchaseCount,
        totalQuantity: customer.totalJars,
        totalAmount: customer.totalSpent,
        followUpDate: customer.followUpDate,
        tags: (customer.tags || []).join("|")
      })));
    }
    if (type === "orders") {
      return csvResponse(res, "orders.csv", enriched.orders.map(order => ({
        id: order.id,
        order_number: order.orderNumber || "",
        product: order.items || "",
        date: order.date,
        time: order.time || "",
        source_channel: order.sourceChannel || "",
        social_name: order.socialName || "",
        source: order.source,
        customerName: order.customerName,
        customer_name: order.customerName,
        phone: order.phone,
        alternate_phone: order.alternatePhone || "",
        address: order.address || "",
        quantity: order.jars,
        amount: order.amount,
        social_name: order.socialName || "",
        free_gift: order.freeGift || "",
        vip_card_status: order.vipCardStatus || "",
        vip_card_reminder: order.vipCardReminder || "",
        vip_discount_flag: order.vipDiscountFlag || "",
        tags: (order.tags || []).join("|"),
        origin_source: order.originSource || "",
        origin_source_other: order.originSourceOther || "",
        note: order.note || ""
      })));
    }
    if (type === "followups") {
      return csvResponse(res, "followups.csv", enriched.customers
        .filter(customer => customer.followUpDate && customer.followUpDate <= date)
        .map(customer => ({
          id: customer.id,
          name: customer.name,
          phone: customer.phone,
          vipLevel: customer.vipLevel,
          status: customer.status,
          followUpDate: customer.followUpDate,
          lastPurchaseDate: customer.lastPurchaseDate,
          lastJars: customer.lastJars
        })));
    }
    if (type === "vip") {
      return csvResponse(res, "vip-customers.csv", enriched.customers
        .filter(customer => customer.vipLevel !== "NORMAL")
        .map(customer => ({
          id: customer.id,
          name: customer.name,
          phone: customer.phone,
          vipLevel: customer.vipLevel,
          totalAmount: customer.totalSpent,
          totalOrders: customer.purchaseCount
        })));
    }
    if (type === "contact-logs") {
      return csvResponse(res, "contact-logs.csv", (db.contactLogs || []).map(log => ({
        id: log.id,
        customerId: log.customerId,
        date: log.date,
        result: log.result,
        note: log.note,
        staff: log.staff,
        nextFollowUpDate: log.nextFollowUpDate
      })));
    }
    return json(res, 404, { ok: false, error: "ไม่พบ export type" });
  }

  if (req.method === "GET" && url.pathname === "/api/backup") {
    if (!await requirePermission(req, res, db, "system.danger", "ไม่มีสิทธิ์สำรองข้อมูล")) return;
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"zomin-backup.json\"",
      "Cache-Control": "no-store"
    });
    res.end(JSON.stringify({ exportedAt: new Date().toISOString(), data: db }, null, 2));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tags") {
    if (!await requirePermission(req, res, db, "customers.edit", "ไม่มีสิทธิ์แก้ไขลูกค้า")) return;
    const body = await readBody(req);
    const tags = splitTags(body.name || body.tags);
    if (!tags.length) return json(res, 400, { ok: false, error: "กรุณาใส่ชื่อ Tag" });
    db.tags = Array.from(new Set([...(db.tags || []), ...tags])).sort((a, b) => a.localeCompare(b, "th"));
    await writeDb(db);
    return json(res, 200, { ok: true, tags: db.tags });
  }

  if (req.method === "POST" && url.pathname === "/api/contact-log") {
    if (!await requirePermission(req, res, db, "customers.edit", "ไม่มีสิทธิ์บันทึกการติดต่อลูกค้า")) return;
    const body = await readBody(req);
    const customer = db.customers.find(item => item.id === body.customerId);
    if (!customer) return json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
    const logDate = toDateOnly(body.date || new Date());
    const logResult = String(body.result || "โทรติด").trim();
    const requestedOrderId = String(body.orderId || body.order_id || body.opportunityCycleId || "").trim();
    const manualOpportunityResult = logResult === OPPORTUNITY_CHAT_RESULT || logResult === OPPORTUNITY_CRM_RESULT;
    const requestedOrder = requestedOrderId
      ? (db.orders || []).find(order => order.id === requestedOrderId && order.customerId === customer.id)
      : null;
    if (requestedOrderId && !requestedOrder) {
      return json(res, 400, { ok: false, error: "รอบออเดอร์นี้ไม่ตรงกับลูกค้า" });
    }
    const cycleOrder = requestedOrder || (manualOpportunityResult ? latestOpportunityOrderForCustomer(db, customer.id) : null);
    const cycleOrderId = String(cycleOrder?.id || "");
    const logNote = manualOpportunityResult && cycleOrderId
      ? appendOpportunityCycleNote(body.note || "", cycleOrderId)
      : String(body.note || "").trim();
    db.contactLogs = db.contactLogs || [];
    if (manualOpportunityResult) {
      const existing = db.contactLogs.find(log => {
        if (log.customerId !== customer.id || log.result !== logResult) return false;
        if (!cycleOrderId) return log.date === logDate;
        return inferLegacyOpportunityLogOrderId(db, customer.id, log) === cycleOrderId;
      });
      if (existing) {
        return json(res, 200, {
          ok: true,
          customer,
          log: { ...existing, orderId: inferLegacyOpportunityLogOrderId(db, customer.id, existing) },
          duplicate: true
        });
      }
    }
    customer.lastContactDate = logDate;
    customer.lastContactNote = logNote;
    const log = {
      id: uid("log"),
      customerId: customer.id,
      date: logDate,
      result: logResult,
      note: logNote,
      staff: String(body.staff || body.staffName || "").trim(),
      nextFollowUpDate: toDateOnly(body.nextFollowUpDate || ""),
      createdAt: new Date().toISOString(),
      orderId: cycleOrderId
    };
    db.contactLogs.push(log);
    await writeDb(db);
    return json(res, 200, { ok: true, customer, log });
  }

  return json(res, 404, { ok: false, error: "API not found" });
}

async function appHandler(req, res) {
  try {
    if (await handlePlatformAdminRequest(req, res)) return;
    const requestPathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
    if (req.url.startsWith("/api/")) {
      const pathname = requestPathname;
      const sessionUser = getCurrentUser(req);
      if (!sessionUser?.id && (pathname === "/api/state" || isBillingApiPath(pathname))) {
        return json(res, 401, { ok: false, error: "Unauthorized" }, { "Set-Cookie": clearSessionCookie() });
      }
      if (!sessionUser?.id && pathname.startsWith("/api/platform-admin")) {
        return json(res, 401, { ok: false, error: "Unauthorized" }, { "Set-Cookie": clearSessionCookie() });
      }
      if (
        sessionUser?.id
        && !["/api/login", "/api/logout"].includes(pathname)
        && dbProvider === "supabase"
        && typeof withTenantContext === "function"
        && typeof resolveTenantForUser === "function"
      ) {
        const tenant = await resolveTenantForUser(sessionUser.id);
        if (!tenant) return sessionExpiredResponse(req, res);
        return await withTenantContext(tenant, () => handleApi(req, res));
      }
      return await handleApi(req, res);
    }
    const pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
    const isAssetRequest = Boolean(path.extname(pathname));
    if (!isAssetRequest && !isPublicAppPath(pathname)) {
      const routeUser = getCurrentUser(req);
      if (!routeUser) return redirectToLogin(res);
      if (dbProvider === "supabase" && typeof resolveTenantForUser === "function") {
        const tenant = await resolveTenantForUser(routeUser.id);
        if (!tenant) return redirectToLogin(res);
      }
    }
    if (["/settings/users", "/team"].includes(pathname)) {
      const sessionUser = getCurrentUser(req);
      const task = async () => {
        const db = await readDb();
        const currentUser = currentUserFromDb(sessionUser, db);
        if (!currentUser) {
          text(res, 401, "Unauthorized");
          return true;
        }
        if (currentUser.role !== "Owner") {
          text(res, 403, "Forbidden");
          return true;
        }
        return false;
      };
      if (sessionUser?.id && dbProvider === "supabase" && typeof withTenantContext === "function" && typeof resolveTenantForUser === "function") {
        const tenant = await resolveTenantForUser(sessionUser.id);
        if (!tenant) return text(res, 401, "Unauthorized");
        const handled = await withTenantContext(tenant, task);
        if (handled) return;
      } else {
        const handled = await task();
        if (handled) return;
      }
    }
    return serveStatic(req, res);
  } catch (error) {
    console.error("Unhandled request error", JSON.stringify({
      path: req.url || "",
      code: String(error?.code || "INTERNAL_ERROR")
    }));
    return json(res, 500, { ok: false, error: "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง" });
  }
}

const server = http.createServer(appHandler);

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Growup Pilot is running at http://${HOST}:${PORT}`);
  });
}

module.exports = appHandler;
module.exports.server = server;
