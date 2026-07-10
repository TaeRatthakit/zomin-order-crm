const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("./lib/env").loadEnv();
const {
  readDb,
  findUserForLogin,
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
  persistUserProfile,
  persistSettingsPatch
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
  return {
    ...effective,
    followUpDaysPerUnit: Number(effective.followUpDaysPerUnit || 15),
    products: normalizeProductRecords(effective.products),
    productCosts: normalizeSettingsCostRows(effective.productCosts, "costPerJar"),
    additionalCosts: normalizeSettingsCostRows(effective.additionalCosts, "amount"),
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

function requireAdmin(req, res) {
  const user = requireUser(req, res);
  if (!user) return null;
  if (!["Owner", "Admin"].includes(user.role)) {
    json(res, 403, { ok: false, error: "ต้องใช้สิทธิ์ Owner หรือ Admin" });
    return null;
  }
  return user;
}

function normalizeUserRole(role) {
  return ["Owner", "Admin", "Staff"].includes(role) ? role : "Staff";
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
  const currentUser = requireUser(req, res);
  if (!currentUser) return true;
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/api/import-jobs/active") {
    const type = url.searchParams.get("type") || "orders";
    const job = await getActiveImportJob(type) || await getLatestImportJob(type);
    return json(res, 200, { ok: true, job: importJobView(job) });
  }

  if (req.method === "GET" && url.pathname === "/api/import-jobs/latest-cleanup-preview") {
    if (!requireAdmin(req, res)) return true;
    const preview = await previewLatestImportCleanup(url.searchParams.get("type") || "orders");
    if (!preview) return json(res, 404, { ok: false, error: "ไม่พบงานนำเข้าล่าสุด" });
    return json(res, 200, { ok: true, preview: importCleanupView(preview) });
  }

  if (req.method === "POST" && url.pathname === "/api/import-jobs") {
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
    if (!requireAdmin(req, res)) return true;
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
    if (["queued", "running", "paused"].includes(job.status)) {
      job.status = "cancelled";
      job.completedAt = new Date().toISOString();
      await saveImportJob(job);
    }
    json(res, 200, { ok: true, job: importJobView(job) });
    return true;
  }

  if (req.method === "POST" && parts[3] === "batches") {
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
  const vipDiscountFlag = previousVipCardSent && /ไลน์บริษัท|line company|บริษัท/i.test(sourceChannel)
    ? "ลูกค้ามีบัตร VIP และสั่งผ่านไลน์บริษัท: รองรับส่วนลด VIP กระปุกละ 10 บาท"
    : "";
  const note = [String(payload.note || "").trim(), vipDiscountFlag].filter(Boolean).join(" | ");
  const order = {
    id: payload.id || uid("o"),
    customerId: customer.id,
    orderNumber: normalizeImportText(payload.orderNumber),
    items: canonicalProductNameForOrder(db.settings || {}, payload.items || payload.product || payload.productName || "Growup"),
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
    originSource: String(payload.originSource || payload.origin_source || "").trim(),
    lineMessageId: normalizeImportText(payload.lineMessageId || payload.line_message_id || ""),
    duplicateFingerprint: duplicateFingerprint(payload),
    socialName: String(payload.socialName || payload.social_name || "").trim(),
    freeGift: String(payload.freeGift || payload.free_gift || "").trim(),
    productId: String(payload.productId || "").trim(),
    packageId: String(payload.packageId || "").trim(),
    packageName: String(payload.packageName || "").trim(),
    paidQuantity: Math.max(0, Number(payload.paidQuantity || 0)),
    freeQuantity: Math.max(0, Number(payload.freeQuantity || 0)),
    totalQuantityShipped: Math.max(0, Number(payload.totalQuantityShipped || 0)),
    packageExpenses: normalizePackageExpenses(payload.packageExpenses),
    vipCardStatus,
    note,
    rawText: String(payload.rawText || "").trim()
  };

  applyOrderProfitSnapshot(order, db.settings || {}, "created");
  db.orders.push(order);
  return order;
}

function findDuplicateOrder(db, payload = {}) {
  const recentExactDuplicate = findExactDuplicateOrderWithin24Hours(db, payload);
  if (recentExactDuplicate) return recentExactDuplicate;
  return null;
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
  const pattern = new RegExp(`(?:${labels.join("|")})\\s*[:：-]\\s*([^\\n]+)`, "i");
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
  ["jars", "จำนวนกระปุก"],
  ["amount", "ยอดซื้อ"],
  ["originSource", "ลูกค้ามาจาก"],
  ["freeGift", "ของแถมที่ลูกค้าได้"],
  ["vipCardStatus", "สถานะบัตร VIP"],
  ["tags", "อาการลูกค้า"],
  ["note", "หมายเหตุ"]
];

function parsePrimaryLineOrderForm(rawText) {
  const textValue = String(rawText || "").trim();
  if (!textValue) return null;
  const lines = textValue.split(/\n+/).map(line => line.trim()).filter(Boolean);
  const labels = PRIMARY_LINE_ORDER_FIELDS.map(([, label]) => label);
  const labelMap = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const matchedLabel = labels.find(label => {
      const normalizedLine = line.toLowerCase();
      const normalizedLabel = label.toLowerCase();
      const escapedLabel = normalizedLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return normalizedLine === normalizedLabel
        || new RegExp(`^${escapedLabel}\\s*[:：]`).test(normalizedLine);
    });
    if (!matchedLabel) continue;
    const inlineValue = line.slice(matchedLabel.length).replace(/^\s*[:：]\s*/, "").trim();
    const nextLine = lines[index + 1] || "";
    const nextLineIsLabel = labels.some(label => {
      const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`^${escapedLabel}\\s*(?:[:：]|$)`, "i").test(nextLine);
    });
    labelMap.set(matchedLabel, inlineValue || (nextLineIsLabel ? "" : nextLine));
  }
  if (!labelMap.size) return null;
  const requiredLabels = ["วันที่ซื้อ", "ชื่อลูกค้า", "เบอร์โทร", "ที่อยู่จัดส่ง", "จำนวนกระปุก", "ยอดซื้อ"];
  const hasPrimaryShape = requiredLabels.every(label => labelMap.has(label));
  if (!hasPrimaryShape) return null;
  const get = label => String(labelMap.get(label) || "").trim();
  const phone = normalizePhone(get("เบอร์โทร"));
  if (!phone) return null;
  return {
    items: normalizeProductNameForMatching(get("สินค้า")),
    orderNumber: normalizeImportText(get("เลขออเดอร์")),
    name: normalizeImportText(get("ชื่อลูกค้า") || `ลูกค้า ${phone}`),
    phone,
    alternatePhone: normalizePhone(get("เบอร์โทรสำรอง")),
    address: normalizeImportText(get("ที่อยู่จัดส่ง")),
    date: normalizeImportDate(get("วันที่ซื้อ")) || toDateOnly(),
    jars: Number(get("จำนวนกระปุก").replace(/[^\d.]/g, "")) || parseQuantity(get("จำนวนกระปุก")) || 1,
    amount: get("ยอดซื้อ")
      ? parseCurrency(get("ยอดซื้อ")) ?? Number(get("ยอดซื้อ").replace(/,/g, "").replace(/[^\d.]/g, ""))
      : null,
    source: "LINE",
    sourceChannel: normalizeImportText(get("ช่องทางการสั่งซื้อ") || "LINE"),
    originSource: normalizeImportText(get("ลูกค้ามาจาก")),
    socialName: normalizeImportText(get("Facebook / LINE ลูกค้า")),
    freeGift: normalizeImportText(get("ของแถมที่ลูกค้าได้")),
    vipCardStatus: normalizeImportText(get("สถานะบัตร VIP") || "ยังไม่ได้ส่งบัตร") || "ยังไม่ได้ส่งบัตร",
    tags: splitTags(get("อาการลูกค้า")),
    note: normalizeImportText(get("หมายเหตุ")),
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
      const order = addOrder(db, normalized);
      adjustInventoryForOrderChange(db, null, order);
      parsedOrders.push(order);
      persistedOrders.push({
        id: order.id,
        lineMessageId: order.lineMessageId || "",
        phone: order.phone || "",
        amount: order.amount,
        date: order.date
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
    originSource: get("origin_source", "origin source", "ลูกค้ามาจาก", "มาจาก", "แหล่งที่มา"),
    freeGift: get("free_gift", "free gift", "ของแถมที่ลูกค้าได้", "ของแถม", "แถม"),
    vipCardStatus: !vipValue
      ? ""
      : /^(เคย|ใช่|มี|ส่งแล้ว|ได้แล้ว|yes|y|true|1)$/i.test(vipValue)
        ? "ส่งบัตรแล้ว"
        : vipValue,
    note: get("note", "หมายเหตุ", "remark", "remarks"),
    rawText: JSON.stringify({ ...row, __orderNumber: orderNumber, __alternatePhone: get("alternate_phone", "alternate phone", "secondary phone", "เบอร์โทรสำรอง", "เบอร์สำรอง", "โทรสำรอง"), __originSource: get("origin_source", "origin source", "ลูกค้ามาจาก", "มาจาก", "แหล่งที่มา") })
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
    const user = getCurrentUser(req);
    return json(res, 200, { ok: true, user });
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

  if (req.method === "PUT" && url.pathname === "/api/settings/finance") {
    if (!requireAdmin(req, res)) return;
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

  const dbReadStartedAt = Date.now();
  const db = await readDb();
  const dbReadMs = Date.now() - dbReadStartedAt;
  const currentUser = isLineWebhook ? null : requireUser(req, res);
  if (!isLineWebhook && !currentUser) return;

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
    return json(res, 200, {
      ...enriched,
      settings: publicSettings(enriched.settings),
      users: ["Owner", "Admin"].includes(currentUser.role) ? enriched.users.map(publicUser) : [currentUser],
      currentUser,
      summary: buildSummary(enriched, date)
    });
  }

  if (req.method === "GET" && url.pathname === "/api/marketing-performance") {
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

  if (req.method === "POST" && url.pathname === "/api/ad-costs") {
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
      const body = await readBody(req);
      const record = normalizeAdCostInput(db, body, db.settings.adCostRecords[index]);
      if (!record) return json(res, 400, { ok: false, error: "ข้อมูลค่าโฆษณาไม่ครบ" });
      db.settings.adCostRecords[index] = record;
      await writeDb(db);
      return json(res, 200, { ok: true, record });
    }
    if (req.method === "DELETE") {
      const [record] = db.settings.adCostRecords.splice(index, 1);
      await writeDb(db);
      return json(res, 200, { ok: true, record });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/ad-platforms") {
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
    if (!requireAdmin(req, res)) return;
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 50)));
    const rows = (db.lineMessages || [])
      .map(lineDebugFromMessage)
      .sort((a, b) => String(b.received_at || "").localeCompare(String(a.received_at || "")))
      .slice(0, limit);
    return json(res, 200, { ok: true, summary: lineDebugSummary(rows), rows });
  }

  if (req.method === "POST" && url.pathname === "/api/customers") {
    return json(res, 409, { ok: false, error: "สร้างลูกค้าแยกเดี่ยวไม่ได้ กรุณาสร้างผ่านออเดอร์" });
  }

  if (req.method === "PUT" && url.pathname.startsWith("/api/customers/")) {
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
    const order = db.orders.find(item => item.id === id);
    if (!order) return json(res, 404, { ok: false, error: "ไม่พบออเดอร์" });
    const previousOrder = { ...order };
    const previousCustomerIds = [order.customerId];
    const customer = db.customers.find(item => item.id === order.customerId);
    if (customer && body.tags !== undefined) {
      customer.tags = splitTags(body.tags);
      db.tags = Array.from(new Set([...(db.tags || []), ...(customer.tags || [])]));
    }
    Object.assign(order, {
      orderNumber: body.orderNumber !== undefined ? normalizeImportText(body.orderNumber) : order.orderNumber,
      items: body.items !== undefined ? normalizeProductNameForMatching(body.items) : order.items,
      customerName: body.name !== undefined ? String(body.name).trim() : order.customerName,
      phone: body.phone !== undefined ? normalizePhone(body.phone) : order.phone,
      address: body.address !== undefined ? String(body.address).trim() : order.address,
      date: body.date ? toDateOnly(body.date) : order.date,
      jars: body.jars !== undefined ? Number(body.jars) : order.jars,
      amount: body.amount !== undefined ? Number(body.amount) : order.amount,
      source: body.sourceChannel ?? order.source,
      sourceChannel: body.sourceChannel ?? order.sourceChannel,
      alternatePhone: body.alternatePhone ?? order.alternatePhone,
      originSource: body.originSource ?? order.originSource,
      socialName: body.socialName ?? order.socialName,
      freeGift: body.freeGift ?? order.freeGift,
      productId: body.productId !== undefined ? String(body.productId || "") : String(order.productId || ""),
      packageId: body.packageId !== undefined ? String(body.packageId || "") : String(order.packageId || ""),
      packageName: body.packageName !== undefined ? String(body.packageName || "") : String(order.packageName || ""),
      paidQuantity: body.paidQuantity !== undefined ? Math.max(0, Number(body.paidQuantity || 0)) : Number(order.paidQuantity || 0),
      freeQuantity: body.freeQuantity !== undefined ? Math.max(0, Number(body.freeQuantity || 0)) : Number(order.freeQuantity || 0),
      totalQuantityShipped: body.totalQuantityShipped !== undefined
        ? Math.max(0, Number(body.totalQuantityShipped || 0))
        : Number(order.totalQuantityShipped || 0),
      packageExpenses: body.packageExpenses !== undefined
        ? normalizePackageExpenses(body.packageExpenses)
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
    const body = await readBody(req);
    const prepared = prepareCsvImport(body.content || "", db);
    return json(res, 200, { ok: true, ...prepared });
  }

  if (req.method === "POST" && url.pathname === "/api/parse-preview") {
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
    if (!requireAdmin(req, res)) return;
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

  if (req.method === "PUT" && url.pathname === "/api/settings") {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    db.settings = {
      ...db.settings,
      businessName: String(body.businessName ?? db.settings.businessName),
      defaultJarPrice: Number(body.defaultJarPrice || db.settings.defaultJarPrice || 750),
      vipThresholds: {
        vip: Number(body.vipThreshold ?? body.vip ?? db.settings.vipThresholds?.vip ?? 5000),
        vvip: Number(body.vvipThreshold ?? body.vvip ?? db.settings.vipThresholds?.vvip ?? 10000),
        superVip: Number(body.superVipThreshold ?? body.superVip ?? db.settings.vipThresholds?.superVip ?? 20000)
      },
      messageTemplates: {
        normal: String(body.normalTemplate ?? db.settings.messageTemplates?.normal ?? ""),
        vip: String(body.vipTemplate ?? db.settings.messageTemplates?.vip ?? "")
      },
      followUpDaysPerUnit: Math.max(1, Number(body.followUpDaysPerUnit || db.settings.followUpDaysPerUnit || 15)),
      products: body.products === undefined
        ? normalizeProductRecords(db.settings.products)
        : normalizeProductRecords(body.products),
      productCosts: body.productCosts === undefined
        ? normalizeSettingsCostRows(db.settings.productCosts, "costPerJar")
        : normalizeSettingsCostRows(body.productCosts, "costPerJar"),
      additionalCosts: body.additionalCosts === undefined
        ? normalizeSettingsCostRows(db.settings.additionalCosts, "amount")
        : normalizeSettingsCostRows(body.additionalCosts, "amount"),
      lineChannelId: process.env.LINE_CHANNEL_ID
        ? db.settings.lineChannelId || ""
        : String(body.lineChannelId ?? db.settings.lineChannelId ?? ""),
      lineChannelSecret: process.env.LINE_CHANNEL_SECRET
        ? db.settings.lineChannelSecret || ""
        : secretInputValue(body.lineChannelSecret, db.settings.lineChannelSecret),
      lineChannelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
        ? db.settings.lineChannelAccessToken || ""
        : secretInputValue(body.lineChannelAccessToken, db.settings.lineChannelAccessToken),
      lineGroupId: process.env.LINE_GROUP_ID
        ? db.settings.lineGroupId || ""
        : String(body.lineGroupId ?? db.settings.lineGroupId ?? ""),
      openaiModel: process.env.OPENAI_MODEL
        ? db.settings.openaiModel || "gpt-4.1-mini"
        : String(body.openaiModel ?? db.settings.openaiModel ?? "gpt-4.1-mini"),
      lineWebhookEnabled: body.lineWebhookEnabled === undefined
        ? Boolean(db.settings.lineWebhookEnabled)
        : Boolean(body.lineWebhookEnabled),
      staffCanExport: body.staffCanExport === undefined
        ? Boolean(db.settings.staffCanExport)
        : Boolean(body.staffCanExport)
    };
    await writeDb(db);
    return json(res, 200, { ok: true, settings: publicSettings(db.settings) }, {
      "Server-Timing": `dbread;dur=${dbReadMs}`,
      "X-Settings-Db-Read-Ms": String(dbReadMs)
    });
  }

  if (req.method === "POST" && url.pathname === "/api/products") {
    if (!requireAdmin(req, res)) return;
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
    if (!requireAdmin(req, res)) return;
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
    if (!requireAdmin(req, res)) return;
    const parts = url.pathname.split("/");
    const productId = decodeURIComponent(parts[parts.length - 2] || "");
    const products = normalizeProductRecords(db.settings.products);
    const index = products.findIndex(item => item.id === productId);
    if (index === -1) return json(res, 404, { ok: false, error: "ไม่พบสินค้า" });
    products[index] = { ...products[index], archived: true, status: "เก็บถาวร" };
    const productCosts = normalizeSettingsCostRows(db.settings.productCosts, "costPerJar").map(item => (
      item.id === productId || item.name === products[index].name
        ? { ...item, enabled: false }
        : item
    ));
    db.settings = { ...db.settings, products, productCosts };
    await writeDb(db);
    return json(res, 200, { ok: true, product: products[index], settings: publicSettings(db.settings) });
  }

  if (req.method === "PUT" && url.pathname === "/api/followup-rules") {
    if (!requireAdmin(req, res)) return;
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
    if (!requireAdmin(req, res)) return;
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
    if (!requireAdmin(req, res)) return;
    const id = url.pathname.split("/").pop();
    const body = await readBody(req);
    const user = db.users.find(item => item.id === id);
    if (!user) return json(res, 404, { ok: false, error: "ไม่พบผู้ใช้" });
    const nextRole = body.role !== undefined ? normalizeUserRole(body.role) : user.role;
    if (!canManageUser(currentUser, user, nextRole)) {
      return json(res, 403, { ok: false, error: "Admin ไม่สามารถแก้ไขหรือลดสิทธิ์ Owner ได้" });
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
    if (!requireAdmin(req, res)) return;
    const id = url.pathname.split("/").pop();
    const user = db.users.find(item => item.id === id);
    if (!user) return json(res, 404, { ok: false, error: "ไม่พบผู้ใช้" });
    if (!canManageUser(currentUser, user)) {
      return json(res, 403, { ok: false, error: "Admin ไม่สามารถลบ Owner ได้" });
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
    if (!(currentUser.role === "Admin" || db.settings.staffCanExport)) {
      return json(res, 403, { ok: false, error: "ต้องใช้สิทธิ์ Admin หรือเปิด Staff Export" });
    }
    const date = url.searchParams.get("date") || toDateOnly();
    const enriched = enrichDb(db, date);
    const type = url.pathname.split("/").pop();
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
    if (!requireAdmin(req, res)) return;
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"zomin-backup.json\"",
      "Cache-Control": "no-store"
    });
    res.end(JSON.stringify({ exportedAt: new Date().toISOString(), data: db }, null, 2));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tags") {
    const body = await readBody(req);
    const tags = splitTags(body.name || body.tags);
    if (!tags.length) return json(res, 400, { ok: false, error: "กรุณาใส่ชื่อ Tag" });
    db.tags = Array.from(new Set([...(db.tags || []), ...tags])).sort((a, b) => a.localeCompare(b, "th"));
    await writeDb(db);
    return json(res, 200, { ok: true, tags: db.tags });
  }

  if (req.method === "POST" && url.pathname === "/api/contact-log") {
    const body = await readBody(req);
    const customer = db.customers.find(item => item.id === body.customerId);
    if (!customer) return json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
    customer.lastContactDate = toDateOnly(body.date || new Date());
    customer.lastContactNote = String(body.note || "").trim();
    const log = {
      id: uid("log"),
      customerId: customer.id,
      date: toDateOnly(body.date || new Date()),
      result: String(body.result || "โทรติด").trim(),
      note: String(body.note || "").trim(),
      staff: String(body.staff || body.staffName || "").trim(),
      nextFollowUpDate: toDateOnly(body.nextFollowUpDate || "")
    };
    db.contactLogs = db.contactLogs || [];
    db.contactLogs.push(log);
    await writeDb(db);
    return json(res, 200, { ok: true, customer, log });
  }

  return json(res, 404, { ok: false, error: "API not found" });
}

async function appHandler(req, res) {
  try {
    if (req.url.startsWith("/api/")) return await handleApi(req, res);
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
