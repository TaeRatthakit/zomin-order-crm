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
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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
    lineWebhookEnabled: booleanEnv(process.env.LINE_WEBHOOK_ENABLED, Boolean(settings.lineWebhookEnabled))
  };
}

function publicSettings(settings = {}) {
  const effective = effectiveSettings(settings);
  return {
    ...effective,
    lineChannelSecret: "",
    lineChannelAccessToken: "",
    lineChannelSecretConfigured: Boolean(effective.lineChannelSecret),
    lineChannelAccessTokenConfigured: Boolean(effective.lineChannelAccessToken),
    lineChannelIdFromEnv: Boolean(process.env.LINE_CHANNEL_ID),
    lineChannelSecretFromEnv: Boolean(process.env.LINE_CHANNEL_SECRET),
    lineChannelAccessTokenFromEnv: Boolean(process.env.LINE_CHANNEL_ACCESS_TOKEN)
  };
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
  if (totalSpent >= Number(thresholds.superVip || 20000)) return "SUPER VIP";
  if (totalSpent >= Number(thresholds.vvip || 10000)) return "VVIP";
  if (totalSpent >= Number(thresholds.vip || 5000)) return "VIP";
  return "NORMAL";
}

function followUpDaysForJars(jars, rules) {
  const count = Number(jars || 0);
  const sorted = [...rules].sort((a, b) => Number(a.jars) - Number(b.jars));
  const exact = sorted.find(rule => Number(rule.jars) === count);
  if (exact) return Number(exact.days);
  return Math.max(15, count * 15 || 15);
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
    const lastJars = Number(lastOrder?.jars || 0);
    const daysToNext = followUpDaysForJars(lastJars, db.followUpRules);
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
        const sourceChannel = order.sourceChannel || order.source_channel || order.source || "";
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
      const sourceChannel = order.sourceChannel || order.source_channel || order.source || "";
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
  const customer = payload.customerId
    ? db.customers.find(item => item.id === payload.customerId)
    : findOrCreateCustomer(db, payload);

  if (!customer) throw new Error("ไม่พบลูกค้า");

  const jars = Number(payload.jars || 1);
  const amount = Number(payload.amount || jars * Number(db.settings.defaultJarPrice || 750));
  const previousVipCardSent = (db.orders || []).some(order =>
    order.customerId === customer.id && order.vipCardStatus === "ส่งบัตรแล้ว"
  );
  const vipCardStatus = String(
    payload.vipCardStatus || payload.vip_card_status || (previousVipCardSent ? "ส่งบัตรแล้ว" : "ยังไม่ได้ส่งบัตร")
  ).trim();
  const sourceChannel = String(payload.sourceChannel || payload.source_channel || payload.source || "Manual").trim();
  const vipDiscountFlag = previousVipCardSent && /ไลน์บริษัท|line company|บริษัท/i.test(sourceChannel)
    ? "ลูกค้ามีบัตร VIP และสั่งผ่านไลน์บริษัท: รองรับส่วนลด VIP กระปุกละ 10 บาท"
    : "";
  const note = [String(payload.note || "").trim(), vipDiscountFlag].filter(Boolean).join(" | ");
  const order = {
    id: payload.id || uid("o"),
    customerId: customer.id,
    date: toDateOnly(payload.date || new Date()),
    time: String(payload.time || new Date().toTimeString().slice(0, 5)),
    items: String(payload.items || "Zomin").trim(),
    jars,
    amount,
    source: String(payload.source || sourceChannel || "Manual").trim(),
    sourceChannel,
    socialName: String(payload.socialName || payload.social_name || "").trim(),
    freeGift: String(payload.freeGift || payload.free_gift || "").trim(),
    vipCardStatus,
    note,
    rawText: String(payload.rawText || "").trim()
  };

  db.orders.push(order);
  return order;
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
  const jars = Number(get("jars", "jar", "จำนวนกระปุก", "กระปุก", "qty", "quantity") || 1);
  const sourceChannel = get("source_channel", "source channel", "ช่องทาง", "ช่องทางสั่ง", "source") || "Import";
  return {
    name: get("name", "customer", "customer name", "ชื่อ", "ชื่อลูกค้า", "ลูกค้า"),
    phone: get("phone", "tel", "mobile", "เบอร์", "เบอร์โทร", "โทร"),
    address: get("address", "ที่อยู่"),
    date: get("date", "order date", "วันที่", "วันที่ซื้อ") || toDateOnly(),
    jars,
    amount: Number(String(get("amount", "total", "ยอด", "ยอดซื้อ", "ราคา")).replace(/,/g, "")) || jars * defaultJarPrice,
    tags: get("tags", "tag", "แท็ก"),
    items: get("items", "product", "สินค้า") || "Zomin",
    source: "Import",
    sourceChannel,
    socialName: get("social_name", "social name", "ชื่อเฟส", "ชื่อไลน์", "facebook", "line"),
    freeGift: get("free_gift", "free gift", "ของแถม", "แถม"),
    vipCardStatus: get("vip_card_status", "vip card status", "สถานะบัตร vip", "บัตร vip") || "ยังไม่ได้ส่งบัตร",
    rawText: JSON.stringify(row)
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

  if (req.method === "GET" && url.pathname === "/api/session") {
    const user = getCurrentUser(req);
    return json(res, 200, { ok: true, user });
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    destroySession(req);
    return json(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
  }

  const db = await readDb();

  if (req.method === "POST" && url.pathname === "/api/login") {
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

  const isLineWebhook = url.pathname === "/api/line/webhook";
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
    const order = addOrder(db, { ...body, source: body.source || "Manual" });
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
      socialName: body.socialName ?? order.socialName,
      freeGift: body.freeGift ?? order.freeGift,
      vipCardStatus: body.vipCardStatus ?? order.vipCardStatus
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

    if (type === "line") {
      const parsedRows = parseLineImportContent(content, db.settings.defaultJarPrice);
      for (const parsed of parsedRows) {
        if (parsed?.phone) imported.push(addOrder(db, parsed));
      }
    } else {
      const rows = parseDelimited(content);
      for (const row of rows) {
        const normalized = normalizeImportRow(row, Number(db.settings.defaultJarPrice || 750));
        if (normalized.phone) imported.push(addOrder(db, normalized));
      }
    }

    await writeDb(db);
    return json(res, 200, { ok: true, imported: imported.length });
  }

  if (req.method === "POST" && url.pathname === "/api/parse-preview") {
    const body = await readBody(req);
    const content = body.content || "";
    const rows = parseLineImportContent(content, db.settings.defaultJarPrice)
      .map((parsed, index) => ({ id: index + 1, ...parsed }));
    return json(res, 200, { ok: true, rows });
  }

  if (req.method === "GET" && url.pathname === "/api/line/webhook") {
    return json(res, 200, {
      ok: true,
      message: "Zomin LINE webhook endpoint is ready. Use POST /api/line/webhook."
    });
  }

  if (req.method === "POST" && url.pathname === "/api/line/webhook") {
    const body = await readBody(req);
    const signature = req.headers["x-line-signature"];
    const settings = effectiveSettings(db.settings);
    if (!settings.lineWebhookEnabled) {
      return json(res, 403, { ok: false, error: "LINE Webhook ยังไม่ได้เปิดใช้งาน" });
    }
    if (!verifyLineSignature(body._rawBody, settings.lineChannelSecret, signature)) {
      return json(res, 401, { ok: false, error: "LINE signature ไม่ถูกต้อง" });
    }
    const events = Array.isArray(body.events) ? body.events : [{ message: { text: body.text || body.content || "" } }];
    const parsedOrders = [];
    for (const event of events) {
      const rawText = event.message?.text || "";
      db.lineMessages.push({
        id: uid("line"),
        receivedAt: new Date().toISOString(),
        rawEvent: event,
        text: rawText,
        raw_text: rawText
      });
      if (rawText) {
        const parsed = parseLineOrder(rawText, settings.defaultJarPrice);
        if (parsed?.phone) parsedOrders.push(addOrder(db, parsed));
      }
    }
    await writeDb(db);
    return json(res, 200, { ok: true, parsedOrders: parsedOrders.length });
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
        vip: Number(body.vipThreshold || body.vip || db.settings.vipThresholds?.vip || 5000),
        vvip: Number(body.vvipThreshold || body.vvip || db.settings.vipThresholds?.vvip || 10000),
        superVip: Number(body.superVipThreshold || body.superVip || db.settings.vipThresholds?.superVip || 20000)
      },
      messageTemplates: {
        normal: String(body.normalTemplate ?? db.settings.messageTemplates?.normal ?? ""),
        vip: String(body.vipTemplate ?? db.settings.messageTemplates?.vip ?? "")
      },
      lineChannelId: process.env.LINE_CHANNEL_ID ? db.settings.lineChannelId || "" : String(body.lineChannelId ?? ""),
      lineChannelSecret: process.env.LINE_CHANNEL_SECRET
        ? db.settings.lineChannelSecret || ""
        : secretInputValue(body.lineChannelSecret, db.settings.lineChannelSecret),
      lineChannelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
        ? db.settings.lineChannelAccessToken || ""
        : secretInputValue(body.lineChannelAccessToken, db.settings.lineChannelAccessToken),
      lineWebhookEnabled: Boolean(body.lineWebhookEnabled),
      staffCanExport: Boolean(body.staffCanExport)
    };
    await writeDb(db);
    return json(res, 200, { ok: true, settings: publicSettings(db.settings) });
  }

  if (req.method === "PUT" && url.pathname === "/api/followup-rules") {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    db.followUpRules = (body.rules || [])
      .map(rule => ({ jars: Number(rule.jars), days: Number(rule.days) }))
      .filter(rule => rule.jars > 0 && rule.days > 0)
      .sort((a, b) => a.jars - b.jars);
    await writeDb(db);
    return json(res, 200, { ok: true, rules: db.followUpRules });
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
        date: order.date,
        time: order.time || "",
        customerName: order.customerName,
        phone: order.phone,
        quantity: order.jars,
        amount: order.amount,
        source: order.source,
        source_channel: order.sourceChannel || "",
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
