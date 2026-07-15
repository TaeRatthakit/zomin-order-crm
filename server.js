const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("./lib/env").loadEnv();
const {
  readDb,
  findUserForLogin,
  readUserById,
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
  persistSettingsPatch,
  readSettingsPatch,
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

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");

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
  return safeUser;
}

function sanitizeAvatarDataUrl(value) {
  const textValue = String(value || "").trim();
  if (!textValue) return "";
  if (!/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,/i.test(textValue)) return "";
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
  const allowedThemes = new Set(["dark"]);
  const allowedLanguages = new Set(["th"]);
  const allowedDateFormats = new Set(["DD/MM/YYYY", "YYYY-MM-DD", "DD MMM YYYY"]);
  const allowedNumberFormats = new Set(["1,234.56", "1.234,56", "1234.56"]);
  const allowedCurrencies = new Set(["THB", "USD"]);
  return {
    theme: allowedThemes.has(preferences.theme) ? preferences.theme : "dark",
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
  const quantity = order.packageId
    ? Number(order.totalQuantityShipped || order.jars || 0)
    : Number(order.jars || 0);
  return quantity * Number(productConfig.costPerJar || 0);
}

function packageExpenseForOrderSnapshot(order = {}) {
  if (!order.packageId) return 0;
  return normalizePackageExpenses(order.packageExpenses)
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
  const packageExpenseSnapshot = snapshotMoney(packageExpenseForOrderSnapshot(order));
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
  const selectedPackage = packageId
    ? salesPackages.find(item => item.id === packageId && item.enabled !== false)
    : null;
  if (packageId && !selectedPackage) {
    const error = new Error(PRODUCT_RESOLUTION_ERROR);
    error.code = "PRODUCT_NOT_FOUND";
    throw error;
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
  return marketingPerformance({
    orders: db.orders || [],
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
  const updatedValue = String(order.updatedAt || order.updated_at || "").trim();
  if (updatedValue) {
    const updated = new Date(updatedValue);
    if (!Number.isNaN(updated.getTime())) return updated;
  }
  const createdValue = String(order.createdAt || order.created_at || "").trim();
  if (createdValue && /T/.test(createdValue)) {
    const created = new Date(createdValue);
    if (!Number.isNaN(created.getTime())) return created;
  }
  const date = toDateOnly(order.date || order.order_date || "");
  if (!date) return null;
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

function findExactDuplicateOrderWithin24Hours(db, payload = {}) {
  const payloadFields = normalizeDuplicateComparisonFields(payload);
  const now = new Date();
  const windowStart = now.getTime() - (24 * 60 * 60 * 1000);
  return (db.orders || []).find(order => {
    const orderDateTime = parseOrderDateTime(order);
    if (!orderDateTime) return false;
    const orderTime = orderDateTime.getTime();
    if (orderTime < windowStart || orderTime > now.getTime()) return false;
    const existingFields = normalizeDuplicateComparisonFields(order);
    const matchedFields = Object.keys(payloadFields).filter(key => existingFields[key] === payloadFields[key]);
    if (matchedFields.length !== 5) return false;
    order.__duplicateMatch = {
      matchedFields,
      payload: payloadFields,
      existing: existingFields
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
  return publicUser(storedUser);
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
  const duplicate = findDuplicateOrder(db, payload);
  if (duplicate) {
    console.log("Duplicate order detected", JSON.stringify({
      matchedFields: duplicate.__duplicateMatch?.matchedFields || [],
      payload: duplicate.__duplicateMatch?.payload || normalizeDuplicateComparisonFields(payload),
      existing: duplicate.__duplicateMatch?.existing || normalizeDuplicateComparisonFields(duplicate),
      existingOrderId: duplicate.id || "",
      existingOrderNumber: duplicate.orderNumber || duplicate.order_number || "",
      existingDate: duplicate.date || duplicate.order_date || "",
      existingTime: duplicate.time || duplicate.order_time || ""
    }));
    const error = new Error("duplicate");
    error.code = "ORDER_DUPLICATE";
    error.order = duplicate;
    throw error;
  }
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

function findLineUpsaleOrder(db, payload = {}, now = new Date()) {
  const targetOrderNumber = orderNumberKey(payload.orderNumber || payload.order_number || "");
  if (!targetOrderNumber) return null;
  return (db.orders || []).find(order => {
    if (orderNumberKey(order.orderNumber || order.order_number || "") !== targetOrderNumber) return false;
    if (!sameOrderCustomerIdentity(order, payload)) return false;
    return isWithinPreviousHours(parseOrderDateTime(order), 24, now);
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

async function handleLineWebhookEvents(db, settings, events) {
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
        replies.push({ replyToken, messages: [{ type: "text", text: "✅ นำเข้าออเดอร์เรียบร้อยแล้ว\nGrowup Pilot บันทึกข้อมูลเรียบร้อย" }] });
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
  await writeDb(db);
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
  const requestedPath = safePath === "/" ? "/index.html" : safePath;
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

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const isLineWebhook = url.pathname === "/api/line/webhook";
  const requestStartedAt = Date.now();

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

  if (req.method === "POST" && url.pathname === "/api/logout") {
    destroySession(req);
    return json(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readBody(req);
    const username = String(body.username || body.userId || "").trim();
    const password = String(body.password || body.pin || "");
    const user = typeof findUserForLogin === "function"
      ? await findUserForLogin(username)
      : (await readDb()).users.find(item =>
        item.active !== false &&
        (item.username === username || item.id === username)
      );
    if (!user) return json(res, 401, { ok: false, error: "ไม่พบผู้ใช้งาน" });
    const upgraded = ensurePasswordHash(user, password);
    if (!verifyPassword(password, user.passwordHash)) {
      return json(res, 401, { ok: false, error: "Username หรือ Password ไม่ถูกต้อง" });
    }
    if (upgraded) {
      const db = await readDb();
      const storedUser = db.users.find(item => item.id === user.id);
      if (storedUser) {
        storedUser.passwordHash = user.passwordHash;
        delete storedUser.password;
        delete storedUser.pin;
        await writeDb(db);
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
    return json(res, 200, {
      ...enriched,
      settings: publicSettings(enriched.settings),
      users: currentUser.role === "Owner" ? enriched.users.map(publicUser) : [currentUser],
      currentUser,
      currentPermissions,
      permissionCatalog: currentUser.role === "Owner" ? PERMISSION_GROUPS : [],
      summary: buildSummary(enriched, date)
    });
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
    if (!await requirePermission(req, res, db, "system.business", "ไม่มีสิทธิ์ตั้งค่าธุรกิจ")) return;
    const body = await readBody(req);
    const name = String(body.name || "").trim();
    if (!name) return json(res, 400, { ok: false, error: "กรุณาระบุช่องทางการขาย" });
    const source = normalizeCustomerSourceRecord({ name, sortOrder: 1000 });
    if (!source) return json(res, 400, { ok: false, error: "ช่องทางการขายไม่ถูกต้อง" });
    const defaultSource = DEFAULT_CUSTOMER_SOURCE_CHANNELS.find(item => item.key === source.key);
    if (defaultSource) {
      return json(res, 200, { ok: true, source: defaultSource, settings: publicSettings(db.settings || {}) });
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
    return json(res, 200, { ok: true, source: saved, settings: publicSettings(db.settings || {}) });
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
    const avatar = sanitizeAvatarDataUrl(body.avatar);
    const savedUser = typeof persistUserProfile === "function"
      ? await persistUserProfile(currentUser.id, { displayName, avatar })
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
    if (!await requirePermission(req, res, db, "orders.create", "ไม่มีสิทธิ์เพิ่มออเดอร์")) return;
    const body = await readBody(req);
    let order;
    try {
      order = addOrder(db, body);
      adjustInventoryForOrderChange(db, null, order);
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
    const mutation = orderMutationPayload(db, {
      orderId: order.id,
      selectedDate: body.selectedDate || toDateOnly()
    });
    mutation.clientMutationId = String(body.clientMutationId || "");
    if (typeof persistOrderMutation === "function") await persistOrderMutation(mutation, db.settings);
    else await writeDb(db);
    return json(res, 200, { ok: true, mutation });
  }

  if (req.method === "PUT" && url.pathname.startsWith("/api/orders/")) {
    const id = url.pathname.split("/").pop();
    const body = await readBody(req);
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
    if (!await requirePermission(req, res, db, orderPermission, "ไม่มีสิทธิ์แก้ไขออเดอร์")) return;
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
      resolvedPayload = statusOnly
        ? null
        : applyResolvedProductToPayload(db.settings || {}, { ...order, ...body }, { preservePackageSnapshot: true });
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
    applyOrderProfitSnapshot(order, db.settings || {}, "edited");
    try {
      adjustInventoryForOrderChange(db, previousOrder, order);
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
    const mutation = orderMutationPayload(db, {
      orderId: order.id,
      previousCustomerIds,
      selectedDate: body.selectedDate || toDateOnly()
    });
    mutation.clientMutationId = String(body.clientMutationId || "");
    if (typeof persistOrderMutation === "function") await persistOrderMutation(mutation, db.settings);
    else await writeDb(db);
    return json(res, 200, { ok: true, mutation });
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
    if (req.url.startsWith("/api/")) return await handleApi(req, res);
    const pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
    if (["/settings/users", "/team"].includes(pathname)) {
      const db = await readDb();
      const sessionUser = getCurrentUser(req);
      const currentUser = currentUserFromDb(sessionUser, db);
      if (!currentUser) return text(res, 401, "Unauthorized");
      if (currentUser.role !== "Owner") return text(res, 403, "Forbidden");
    }
    return serveStatic(req, res);
  } catch (error) {
    return json(res, 500, { ok: false, error: error.message || "Server error" });
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
