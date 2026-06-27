const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("./lib/env").loadEnv();
const { readDb, writeDb, deleteOrder, deleteCustomer } = require("./lib/db");
const {
  hashPassword,
  verifyPassword,
  createSession,
  getSession,
  destroySession,
  sessionCookie,
  clearSessionCookie
} = require("./lib/auth");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
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

function normalizeImportDate(value) {
  const textValue = normalizeImportText(value);
  if (!textValue) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(textValue)) return textValue;
  const match = textValue.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (!match) return toDateOnly(textValue);
  const year = Number(match[3]) > 2400 ? Number(match[3]) - 543 : Number(match[3]);
  return `${year}-${String(match[2]).padStart(2, "0")}-${String(match[1]).padStart(2, "0")}`;
}

function publicUser(user) {
  const { pin, password, passwordHash, ...safeUser } = user;
  return safeUser;
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

function publicSettings(settings = {}) {
  const effective = effectiveSettings(settings);
  return {
    ...effective,
    followUpDaysPerUnit: Number(effective.followUpDaysPerUnit || 15),
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

function isPlaceholderChannel(value) {
  return /^manual(?:\s+import)?$/i.test(String(value || "").trim());
}

function orderChannel(order = {}) {
  const candidates = [order.sourceChannel, order.source_channel, order.source];
  const channel = candidates.map(value => String(value || "").trim()).find(value => value && !isPlaceholderChannel(value));
  return channel || "";
}

function normalizeDuplicateOrderNumber(value) {
  return normalizeImportText(value).toLowerCase();
}

function duplicateOrderKey(order = {}) {
  const orderNumber = normalizeDuplicateOrderNumber(order.orderNumber || order.order_number || "");
  if (orderNumber) return `order:${orderNumber}`;
  return `fallback:${toDateOnly(order.date || order.order_date || "")}|${normalizePhone(order.phone || "")}|${Number(order.amount || 0)}`;
}

function fallbackDuplicateKey(order = {}) {
  return JSON.stringify([
    toDateOnly(order.date || order.order_date || ""),
    normalizePhone(order.phone || ""),
    Number(order.amount || 0)
  ]);
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
  if (user.role !== "Admin") {
    json(res, 403, { ok: false, error: "ต้องใช้สิทธิ์ Admin" });
    return null;
  }
  return user;
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
    const error = new Error("duplicate");
    error.code = "ORDER_DUPLICATE";
    error.order = duplicate;
    throw error;
  }
  const customer = payload.customerId
    ? db.customers.find(item => item.id === payload.customerId)
    : findOrCreateCustomer(db, payload);

  if (!customer) throw new Error("ไม่พบลูกค้า");

  const jars = Number(payload.jars || 1);
  const amount = payload.amount !== undefined && payload.amount !== ""
    ? Number(payload.amount)
    : jars * Number(db.settings.defaultJarPrice || 750);
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
    customerName: normalizeImportText(payload.name || customer.name),
    address: normalizeImportText(payload.address || customer.address),
    date: toDateOnly(payload.date || new Date()),
    time: String(payload.time || bangkokTime()),
    items: String(payload.items || "Zomin").trim(),
    jars,
    amount,
    source: isPlaceholderChannel(payload.source) ? "" : String(payload.source || sourceChannel || "").trim(),
    sourceChannel,
    alternatePhone: String(payload.alternatePhone || payload.alternate_phone || "").trim(),
    originSource: String(payload.originSource || payload.origin_source || "").trim(),
    socialName: String(payload.socialName || payload.social_name || "").trim(),
    freeGift: String(payload.freeGift || payload.free_gift || "").trim(),
    vipCardStatus,
    note,
    rawText: String(payload.rawText || "").trim()
  };

  db.orders.push(order);
  return order;
}

function findDuplicateOrder(db, payload = {}) {
  const orderNumber = normalizeDuplicateOrderNumber(payload.orderNumber || payload.order_number || "");
  if (orderNumber) {
    const existing = (db.orders || []).find(order => normalizeDuplicateOrderNumber(order.orderNumber || order.order_number || "") === orderNumber);
    if (existing) return existing;
  }
  const date = toDateOnly(payload.date || payload.orderDate || "");
  const phone = normalizePhone(payload.phone || "");
  const amount = Number(payload.amount || 0);
  return (db.orders || []).find(order =>
    toDateOnly(order.date) === date &&
    normalizePhone(order.phone || "") === phone &&
    Number(order.amount || 0) === amount
  ) || null;
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

  return {
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
    name: parsed.name || parsed.customerName || "",
    phone: normalizePhone(parsed.phone || ""),
    amount: Number(parsed.amount || 0),
    jars: Number(parsed.jars || parsed.quantity || 0) || 1,
    date: toDateOnly(parsed.date || new Date()),
    orderNumber: normalizeImportText(parsed.orderNumber || parsed.order_number || ""),
    source: parsed.source || "LINE",
    sourceChannel: parsed.sourceChannel || parsed.source_channel || "LINE"
  };
}

async function parseOrderWithAI(textValue, settings = {}) {
  const fallback = parseLineOrder(textValue, settings.defaultJarPrice);
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
            content: "Extract a LINE order into JSON. Return only valid JSON with keys: orderDate, orderNumber, salesChannel, tag, customerSocial, customerName, shippingAddress, phoneNumber, quantity, totalAmount, freeGift, vipStatus. Use Thai field values when present. If a field is missing, use an empty string."
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
      date: normalizeImportDate(parsed.orderDate) || fallback?.date || toDateOnly(),
      orderNumber: normalizeImportText(parsed.orderNumber || ""),
      sourceChannel: normalizeImportText(parsed.salesChannel || fallback?.sourceChannel || "LINE"),
      tags: splitTags(parsed.tag || ""),
      socialName: normalizeImportText(parsed.customerSocial || fallback?.socialName || ""),
      name: normalizeImportText(parsed.customerName || fallback?.name || ""),
      address: normalizeImportText(parsed.shippingAddress || fallback?.address || ""),
      phone: normalizePhone(parsed.phoneNumber || fallback?.phone || ""),
      jars: Number(parsed.quantity || fallback?.jars || 0) || 1,
      amount: Number(parsed.totalAmount || fallback?.amount || 0),
      freeGift: normalizeImportText(parsed.freeGift || fallback?.freeGift || ""),
      vipCardStatus: normalizeImportText(parsed.vipStatus || fallback?.vipCardStatus || "ยังไม่ได้ส่งบัตร") || "ยังไม่ได้ส่งบัตร",
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
  for (const event of events) {
    const { replyToken, source, text } = extractLineWebhookContext(event);
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
    const normalized = normalizedOrderForStorage(parsed);
    const missingFields = missingRequiredOrderFields(normalized);
    if (missingFields.length) {
      debug.parser_status = "missing_required_fields";
      debug.error_message = `Missing fields: ${missingFields.join(", ")}`;
      console.log("LINE webhook parser missing fields", JSON.stringify({ groupId: source.groupId || "", missingFields }));
      replies.push({ replyToken, messages: [{ type: "text", text: formatMissingFieldsMessage(missingFields) }] });
      continue;
    }
    try {
      parsedOrders.push(addOrder(db, normalized));
      debug.parser_status = "parsed";
      debug.supabase_insert_status = "pending_write";
      console.log("LINE webhook order parsed", JSON.stringify({
        groupId: source.groupId || "",
        orderNumber: normalized.orderNumber || "",
        phone: normalized.phone || "",
        amount: normalized.amount,
        date: normalized.date
      }));
      replies.push({ replyToken, messages: [{ type: "text", text: "✅ Order imported into OrderPilot CRM." }] });
    } catch (error) {
      if (error.code === "ORDER_DUPLICATE") {
        debug.parser_status = "duplicate";
        debug.supabase_insert_status = "skipped_duplicate";
        console.log("LINE webhook duplicate order skipped", JSON.stringify({
          groupId: source.groupId || "",
          orderNumber: normalized.orderNumber || "",
          phone: normalized.phone || "",
          amount: normalized.amount,
          date: normalized.date
        }));
        replies.push({ replyToken, messages: [{ type: "text", text: "✅ Order imported into OrderPilot CRM." }] });
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
  console.log("LINE webhook Supabase write completed", JSON.stringify({ parsedOrders: parsedOrders.length }));
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
  const jars = Number(get("jars", "jar", "จำนวนกระปุก", "กระปุก", "ซื้อกี่กระปุก", "qty", "quantity") || 1);
  const amountText = String(get("amount", "total", "ยอด", "ยอดซื้อ", "ราคา")).replace(/,/g, "").trim();
  const parsedAmount = amountText === "" ? NaN : Number(amountText);
  const sourceChannel = get("source_channel", "source channel", "ช่องทาง", "ช่องทางสั่ง", "สั่งจาก", "source") || "Import";
  const vipValue = normalizeImportText(get(
    "vip_card_status",
    "vip card status",
    "สถานะบัตร vip",
    "บัตร vip",
    "เคยได้บัตรvipแล้วหรือยัง"
  ));
  return {
    orderNumber: normalizeImportText(get("order number", "order_number", "เลขออเดอร์")),
    name: get("name", "customer", "customer name", "ชื่อ", "ชื่อลูกค้า", "ชื่อลูกค้ารับของ", "ลูกค้า"),
    phone: get("phone", "tel", "mobile", "เบอร์", "เบอร์โทร", "โทร"),
    address: get("address", "ที่อยู่"),
    date: normalizeImportDate(get("date", "order date", "วันที่", "วันที่ซื้อ", "วันที่สั่งซื้อ")) || toDateOnly(),
    jars,
    amount: Number.isFinite(parsedAmount) ? parsedAmount : jars * defaultJarPrice,
    tags: get("tags", "tag", "แท็ก"),
    items: get("items", "product", "สินค้า") || "Zomin",
    source: "Import",
    sourceChannel,
    socialName: get(
      "social_name",
      "social name",
      "ชื่อเฟส",
      "ชื่อไลน์",
      "ชื่อ facebook หรือ ไลน์ ของลูกค้า",
      "facebook",
      "line"
    ),
    freeGift: get("free_gift", "free gift", "ของแถม", "แถม"),
    vipCardStatus: !vipValue
      ? ""
      : /^(เคย|ใช่|มี|ส่งแล้ว|ได้แล้ว|yes|y|true|1)$/i.test(vipValue)
        ? "ส่งบัตรแล้ว"
        : vipValue,
    rawText: JSON.stringify({ ...row, __orderNumber: normalizeImportText(get("order number", "order_number", "เลขออเดอร์")) })
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
  "phone",
  "tags",
  "items",
  "sourceChannel",
  "socialName",
  "freeGift",
  "vipCardStatus"
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
        text(res, 200, fallbackFile, MIME_TYPES[".html"]);
      });
    }
    if (error) return text(res, 404, "Not found");
    const ext = path.extname(filePath);
    text(res, 200, file, MIME_TYPES[ext] || "application/octet-stream");
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
    const db = await readDb();
    const body = await readBody(req);
    const username = String(body.username || body.userId || "").trim();
    const password = String(body.password || body.pin || "");
    const user = db.users.find(item =>
      item.active !== false &&
      (item.username === username || item.id === username)
    );
    if (!user) return json(res, 401, { ok: false, error: "ไม่พบผู้ใช้งาน" });
    const upgraded = ensurePasswordHash(user, password);
    if (!verifyPassword(password, user.passwordHash)) {
      return json(res, 401, { ok: false, error: "Username หรือ Password ไม่ถูกต้อง" });
    }
    if (upgraded) await writeDb(db);
    const session = createSession(user);
    return json(res, 200, { ok: true, user: publicUser(user) }, {
      "Set-Cookie": sessionCookie(session.token, session.expiresAt)
    });
  }

  if (isLineWebhook && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      message: "Zomin LINE webhook endpoint is ready. Use POST /api/line/webhook."
    });
  }

  const db = await readDb();
  const currentUser = isLineWebhook ? null : requireUser(req, res);
  if (!isLineWebhook && !currentUser) return;

  if (req.method === "GET" && url.pathname === "/api/state") {
    const date = url.searchParams.get("date") || toDateOnly();
    const enriched = enrichDb(db, date);
    return json(res, 200, {
      ...enriched,
      settings: publicSettings(enriched.settings),
      users: currentUser.role === "Admin" ? enriched.users.map(publicUser) : [currentUser],
      currentUser,
      summary: buildSummary(enriched, date)
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
    const body = await readBody(req);
    const customer = findOrCreateCustomer(db, body);
    await writeDb(db);
    return json(res, 200, { ok: true, customer });
  }

  if (req.method === "PUT" && url.pathname.startsWith("/api/customers/")) {
    const id = url.pathname.split("/").pop();
    const body = await readBody(req);
    const customer = db.customers.find(item => item.id === id);
    if (!customer) return json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
    Object.assign(customer, {
      name: body.name ?? customer.name,
      phone: body.phone ? normalizePhone(body.phone) : customer.phone,
      address: body.address ?? customer.address,
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
    } catch (error) {
      if (error.code === "ORDER_DUPLICATE") {
        return json(res, 409, { ok: false, error: "ออเดอร์นี้มีอยู่แล้ว" });
      }
      throw error;
    }
    await writeDb(db);
    return json(res, 200, { ok: true, order });
  }

  if (req.method === "PUT" && url.pathname.startsWith("/api/orders/")) {
    const id = url.pathname.split("/").pop();
    const body = await readBody(req);
    const order = db.orders.find(item => item.id === id);
    if (!order) return json(res, 404, { ok: false, error: "ไม่พบออเดอร์" });
    const customer = db.customers.find(item => item.id === order.customerId);
    if (customer) {
      if (body.name !== undefined) customer.name = String(body.name).trim();
      if (body.phone !== undefined) customer.phone = normalizePhone(body.phone);
      if (body.address !== undefined) customer.address = String(body.address).trim();
      if (body.tags !== undefined) customer.tags = splitTags(body.tags);
      db.tags = Array.from(new Set([...(db.tags || []), ...(customer.tags || [])]));
    }
    Object.assign(order, {
      date: body.date ? toDateOnly(body.date) : order.date,
      jars: body.jars !== undefined ? Number(body.jars) : order.jars,
      amount: body.amount !== undefined ? Number(body.amount) : order.amount,
      source: body.sourceChannel ?? order.source,
      sourceChannel: body.sourceChannel ?? order.sourceChannel,
      alternatePhone: body.alternatePhone ?? order.alternatePhone,
      originSource: body.originSource ?? order.originSource,
      socialName: body.socialName ?? order.socialName,
      freeGift: body.freeGift ?? order.freeGift,
      vipCardStatus: body.vipCardStatus ?? order.vipCardStatus,
      note: body.note ?? order.note
    });
    await writeDb(db);
    return json(res, 200, { ok: true, order });
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/orders/")) {
    const id = url.pathname.split("/").pop();
    const orderIndex = db.orders.findIndex(item => item.id === id);
    if (orderIndex === -1) return json(res, 404, { ok: false, error: "ไม่พบออเดอร์" });
    await deleteOrder(id);
    return json(res, 200, { ok: true, deletedOrderId: id });
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
            imported.push(addOrder(db, parsed));
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
            imported.push(addOrder(db, row));
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
    const parsedOrders = parsed?.phone ? [addOrder(db, parsed)] : [];
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
    return json(res, 200, { ok: true, settings: publicSettings(db.settings) });
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
    const password = String(body.password || body.pin || "staff123").trim() || "staff123";
    const user = {
      id: uid("u"),
      name: String(body.name || "").trim(),
      username: String(body.username || body.phone || uid("staff")).trim(),
      role: body.role === "Admin" ? "Admin" : "Staff",
      phone: normalizePhone(body.phone || ""),
      passwordHash: hashPassword(password),
      active: body.active !== false
    };
    if (!user.name) return json(res, 400, { ok: false, error: "กรุณาใส่ชื่อทีมงาน" });
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
    if (body.username !== undefined) user.username = String(body.username).trim();
    if (body.name !== undefined) user.name = String(body.name).trim();
    if (body.phone !== undefined) user.phone = normalizePhone(body.phone);
    if (body.role !== undefined) user.role = body.role === "Admin" ? "Admin" : "Staff";
    if (body.active !== undefined) user.active = Boolean(body.active);
    if (body.password) {
      user.passwordHash = hashPassword(body.password);
      delete user.password;
      delete user.pin;
    }
    await writeDb(db);
    return json(res, 200, { ok: true, user: publicUser(user) });
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
        date: order.date,
        time: order.time || "",
        customerName: order.customerName,
        phone: order.phone,
        alternate_phone: order.alternatePhone || "",
        address: order.address || "",
        quantity: order.jars,
        amount: order.amount,
        source: order.source,
        source_channel: order.sourceChannel || "",
        origin_source: order.originSource || "",
        social_name: order.socialName || "",
        free_gift: order.freeGift || "",
        vip_card_status: order.vipCardStatus || "",
        vip_card_reminder: order.vipCardReminder || "",
        vip_discount_flag: order.vipDiscountFlag || "",
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
    console.log(`Zomin Order CRM is running at http://${HOST}:${PORT}`);
  });
}

module.exports = appHandler;
module.exports.server = server;
