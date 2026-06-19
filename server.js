const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, "data", "db.json");
const PUBLIC_DIR = path.join(ROOT, "public");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};

function readDb() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function writeDb(db) {
  fs.writeFileSync(DATA_FILE, `${JSON.stringify(db, null, 2)}\n`, "utf8");
}

function json(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
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
  const { pin, password, ...safeUser } = user;
  return safeUser;
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
      orders
    };
  });

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
      return {
        ...order,
        customerName: customer?.name || "",
        phone: customer?.phone || "",
        tags: customer?.tags || [],
        status: customer?.status || "",
        vipLevel: customer?.vipLevel || "NORMAL"
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
  const order = {
    id: payload.id || uid("o"),
    customerId: customer.id,
    date: toDateOnly(payload.date || new Date()),
    time: String(payload.time || new Date().toTimeString().slice(0, 5)),
    items: String(payload.items || "Zomin").trim(),
    jars,
    amount,
    source: String(payload.source || "Manual").trim(),
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
  const plusFree = value.match(/(\d+)\s*(?:กระปุก)?\s*แถม\s*(\d+)\s*(?:กระปุก)?/);
  if (plusFree) return Number(plusFree[1]) + Number(plusFree[2]);
  const jarMatch = value.match(/(\d+)\s*(?:กระปุก|ปุก|jar|jars|ขวด)/i);
  if (jarMatch) return Number(jarMatch[1]);
  return 1;
}

function parseLineOrder(rawText, defaultJarPrice = 750) {
  const textValue = String(rawText || "").trim();
  const phoneMatch = textValue.match(/0[\d\s.-]{8,12}/);
  const phone = normalizePhone(phoneMatch?.[0] || "");
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
  const explicitName = textValue.match(/(?:ชื่อ|ลูกค้า|คุณ)\s*[:：-]?\s*([^\n,]+)/);
  const firstLine = textValue.split(/\n+/).find(line => line.trim() && !line.match(/0[\d\s.-]{8,12}/));
  const name = (explicitName?.[1] || firstLine || `ลูกค้า ${phone}`).replace(/^(ชื่อ|ลูกค้า)\s*[:：-]?\s*/i, "").trim();
  const tagMatches = Array.from(textValue.matchAll(/#([^\s#]+)/g)).map(match => match[1].trim());

  return {
    name,
    phone,
    address: addressLine ? addressLine.replace(/^ที่อยู่\s*[:：-]?\s*/, "").trim() : "",
    date,
    jars,
    amount,
    tags: tagMatches,
    source: "LINE",
    rawText: textValue
  };
}

function verifyLineSignature(rawBody, channelSecret, signature) {
  if (!channelSecret || !signature) return true;
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
  const db = readDb();

  if (req.method === "GET" && url.pathname === "/api/state") {
    const date = url.searchParams.get("date") || toDateOnly();
    const enriched = enrichDb(db, date);
    return json(res, 200, {
      ...enriched,
      users: enriched.users.map(publicUser),
      summary: buildSummary(enriched, date)
    });
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readBody(req);
    const username = String(body.username || body.userId || "").trim();
    const password = String(body.password || body.pin || "");
    const user = db.users.find(item =>
      item.active !== false &&
      (item.username === username || item.id === username)
    );
    if (!user) return json(res, 401, { ok: false, error: "ไม่พบผู้ใช้งาน" });
    const expectedPassword = String(user.password || user.pin || "");
    if (password !== expectedPassword) {
      return json(res, 401, { ok: false, error: "Username หรือ Password ไม่ถูกต้อง" });
    }
    return json(res, 200, { ok: true, user: publicUser(user) });
  }

  if (req.method === "POST" && url.pathname === "/api/customers") {
    const body = await readBody(req);
    const customer = findOrCreateCustomer(db, body);
    writeDb(db);
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
    writeDb(db);
    return json(res, 200, { ok: true, customer });
  }

  if (req.method === "POST" && url.pathname === "/api/orders") {
    const body = await readBody(req);
    const order = addOrder(db, { ...body, source: body.source || "Manual" });
    writeDb(db);
    return json(res, 200, { ok: true, order });
  }

  if (req.method === "POST" && url.pathname === "/api/import") {
    const body = await readBody(req);
    const type = body.type || "csv";
    const content = body.content || "";
    const imported = [];

    if (type === "line") {
      const chunks = String(content).split(/\n-{3,}\n|\n\n+/).map(chunk => chunk.trim()).filter(Boolean);
      for (const chunk of chunks) {
        const parsed = parseLineOrder(chunk, db.settings.defaultJarPrice);
        if (parsed.phone) imported.push(addOrder(db, parsed));
      }
    } else {
      const rows = parseDelimited(content);
      for (const row of rows) {
        const normalized = normalizeImportRow(row, Number(db.settings.defaultJarPrice || 750));
        if (normalized.phone) imported.push(addOrder(db, normalized));
      }
    }

    writeDb(db);
    return json(res, 200, { ok: true, imported: imported.length });
  }

  if (req.method === "POST" && url.pathname === "/api/parse-preview") {
    const body = await readBody(req);
    const content = body.content || "";
    const chunks = String(content).split(/\n-{3,}\n|\n\n+/).map(chunk => chunk.trim()).filter(Boolean);
    const rows = chunks
      .map(chunk => parseLineOrder(chunk, db.settings.defaultJarPrice))
      .filter(parsed => parsed.phone)
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
    if (!verifyLineSignature(body._rawBody, db.settings.lineChannelSecret, signature)) {
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
        const parsed = parseLineOrder(rawText, db.settings.defaultJarPrice);
        if (parsed.phone) parsedOrders.push(addOrder(db, parsed));
      }
    }
    writeDb(db);
    return json(res, 200, { ok: true, parsedOrders: parsedOrders.length });
  }

  if (req.method === "PUT" && url.pathname === "/api/settings") {
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
      lineChannelId: String(body.lineChannelId ?? ""),
      lineChannelSecret: String(body.lineChannelSecret ?? ""),
      lineChannelAccessToken: String(body.lineChannelAccessToken ?? ""),
      lineWebhookEnabled: Boolean(body.lineWebhookEnabled),
      staffCanExport: Boolean(body.staffCanExport)
    };
    writeDb(db);
    return json(res, 200, { ok: true, settings: db.settings });
  }

  if (req.method === "PUT" && url.pathname === "/api/followup-rules") {
    const body = await readBody(req);
    db.followUpRules = (body.rules || [])
      .map(rule => ({ jars: Number(rule.jars), days: Number(rule.days) }))
      .filter(rule => rule.jars > 0 && rule.days > 0)
      .sort((a, b) => a.jars - b.jars);
    writeDb(db);
    return json(res, 200, { ok: true, rules: db.followUpRules });
  }

  if (req.method === "POST" && url.pathname === "/api/team") {
    const body = await readBody(req);
    const user = {
      id: uid("u"),
      name: String(body.name || "").trim(),
      username: String(body.username || body.phone || uid("staff")).trim(),
      role: body.role === "Admin" ? "Admin" : "Staff",
      phone: normalizePhone(body.phone || ""),
      pin: String(body.pin || "1111").trim() || "1111",
      password: String(body.password || body.pin || "staff123").trim() || "staff123",
      active: body.active !== false
    };
    if (!user.name) return json(res, 400, { ok: false, error: "กรุณาใส่ชื่อทีมงาน" });
    db.users.push(user);
    writeDb(db);
    return json(res, 200, { ok: true, user: publicUser(user) });
  }

  if (req.method === "POST" && url.pathname === "/api/tags") {
    const body = await readBody(req);
    const tags = splitTags(body.name || body.tags);
    if (!tags.length) return json(res, 400, { ok: false, error: "กรุณาใส่ชื่อ Tag" });
    db.tags = Array.from(new Set([...(db.tags || []), ...tags])).sort((a, b) => a.localeCompare(b, "th"));
    writeDb(db);
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
    writeDb(db);
    return json(res, 200, { ok: true, customer, log });
  }

  return json(res, 404, { ok: false, error: "API not found" });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) return await handleApi(req, res);
    return serveStatic(req, res);
  } catch (error) {
    return json(res, 500, { ok: false, error: error.message || "Server error" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Zomin Order CRM is running at http://127.0.0.1:${PORT}`);
});
