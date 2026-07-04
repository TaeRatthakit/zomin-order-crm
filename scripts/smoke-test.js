const { Readable } = require("stream");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.NODE_ENV = "development";
process.env.DATABASE_PROVIDER = "json";
process.env.LINE_WEBHOOK_ENABLED = "true";
if (!process.env.JSON_DB_PATH) {
  process.env.JSON_DB_PATH = path.join(os.tmpdir(), `zomin-smoke-${process.pid}.json`);
  fs.copyFileSync(path.join(__dirname, "..", "data", "db.json"), process.env.JSON_DB_PATH);
}
const appHandler = require("../server");

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
  const res = {
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
        text: Buffer.concat(chunks).toString("utf8")
      });
    }
  };
  return res;
}

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = makeRequest(path, options);
    const res = makeResponse(resolve);
    Promise.resolve(appHandler(req, res)).catch(reject);
  });
}

function header(headers, name) {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found?.[1] || "";
}

function fail(message) {
  throw new Error(`Smoke test failed: ${message}`);
}

function bangkokNow() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`
  };
}

async function main() {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || "zomin-smoke-test-secret";

  const login = await request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" })
  });
  if (login.status !== 200) fail(`admin login returned ${login.status}: ${login.text}`);
  const cookie = header(login.headers, "set-cookie");
  if (!cookie || !cookie.includes("HttpOnly")) fail("admin login did not set an HttpOnly session cookie");

  const adminState = await request("/api/state", { headers: { cookie } });
  if (adminState.status !== 200) fail(`admin state returned ${adminState.status}: ${adminState.text}`);
  const parsedAdminState = JSON.parse(adminState.text);
  if (!parsedAdminState.currentUser || parsedAdminState.currentUser.role !== "Admin") {
    fail("state did not return Admin session");
  }

  const financeSettings = await request("/api/settings", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      productCosts: [{ id: "pc_smoke", name: "Zomin", costPerJar: 48, enabled: true }],
      additionalCosts: [
        { id: "ac_order", name: "ค่ากล่อง", amount: 5, type: "fixed_per_order", enabled: true },
        { id: "ac_item", name: "ค่าแพ็ก", amount: 2, type: "per_item", enabled: true },
        { id: "ac_cod", name: "ค่า COD", amount: 2.5, type: "percent_sales", enabled: true }
      ]
    })
  });
  if (financeSettings.status !== 200) fail(`finance settings returned ${financeSettings.status}: ${financeSettings.text}`);
  const savedFinanceSettings = JSON.parse(financeSettings.text).settings;
  if (savedFinanceSettings.productCosts?.[0]?.costPerJar !== 48) fail("product cost did not persist");
  if (
    savedFinanceSettings.additionalCosts?.map(item => item.type).join(",")
    !== "fixed_per_order,per_item,percent_sales"
  ) {
    fail("additional cost calculation types did not persist");
  }

  const staffLogin = await request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "staff", password: "staff123" })
  });
  if (staffLogin.status !== 200) fail(`staff login returned ${staffLogin.status}: ${staffLogin.text}`);
  const staffCookie = header(staffLogin.headers, "set-cookie");
  const staffTeam = await request("/api/state", { headers: { cookie: staffCookie } });
  if (staffTeam.status !== 200) fail(`staff state returned ${staffTeam.status}: ${staffTeam.text}`);
  const parsedStaffState = JSON.parse(staffTeam.text);
  if (!parsedStaffState.currentUser || parsedStaffState.currentUser.role !== "Staff") {
    fail("state did not return Staff session");
  }

  const customersCsv = await request("/api/export/customers", { headers: { cookie } });
  if (customersCsv.status !== 200) fail(`customers export returned ${customersCsv.status}`);
  if (!customersCsv.text.includes("vipLevel")) fail("customers CSV header is missing expected columns");

  const ordersCsv = await request("/api/export/orders", { headers: { cookie } });
  if (ordersCsv.status !== 200) fail(`orders export returned ${ordersCsv.status}`);
  if (!ordersCsv.text.includes("customerName")) fail("orders CSV header is missing expected columns");

  const backup = await request("/api/backup", { headers: { cookie } });
  if (backup.status !== 200) fail(`backup returned ${backup.status}`);
  const parsedBackup = JSON.parse(backup.text);
  if (!parsedBackup.data || !Array.isArray(parsedBackup.data.users)) fail("backup JSON is missing data.users");

  const webhookHealth = await request("/api/line/webhook");
  if (webhookHealth.status !== 200) fail(`LINE webhook health returned ${webhookHealth.status}`);

  const nowInBangkok = bangkokNow();
  const uniqueSuffix = crypto.randomBytes(3).toString("hex");
  const uniquePhoneSuffix = String(Date.now()).slice(-5);
  const newLineOrderText = [
    "สินค้า : Zomin Plus",
    `เลขออเดอร์ : LINE-${uniqueSuffix}`,
    "วันที่ซื้อ : 3/7/2569",
    "ช่องทางการสั่งซื้อ : ไลน์บริษัท",
    "Facebook / LINE ลูกค้า : line-test",
    "",
    "ชื่อลูกค้า : คุณไลน์ ทดสอบ",
    `เบอร์โทร : 08123${uniquePhoneSuffix}`,
    "เบอร์โทรสำรอง : 0891234567",
    "ที่อยู่จัดส่ง : 99 ถนนสุขุมวิท กรุงเทพฯ",
    "",
    "จำนวนกระปุก : 3",
    "ยอดซื้อ : 2,250 บาท",
    "ของแถมที่ลูกค้าได้ : แถม 1 กระปุก",
    "",
    "สถานะบัตร VIP : ส่งบัตรแล้ว",
    "",
    "อาการลูกค้า : ปวดเข่า, นอนไม่หลับ",
    "",
    "ลูกค้ามาจาก : ลูกค้าบอกต่อ",
    "",
    "หมายเหตุ : โทรก่อนส่ง"
  ].join("\n");
  const newLinePreview = await request("/api/parse-preview", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ content: newLineOrderText })
  });
  if (newLinePreview.status !== 200) fail(`new LINE format preview returned ${newLinePreview.status}`);
  const newLineRow = JSON.parse(newLinePreview.text).rows?.[0];
  if (!newLineRow || newLineRow.items !== "Zomin Plus") {
    fail(`new LINE format did not parse สินค้า: ${JSON.stringify(newLineRow)}`);
  }
  if (newLineRow.orderNumber !== `LINE-${uniqueSuffix}` || newLineRow.sourceChannel !== "ไลน์บริษัท") {
    fail("new LINE format did not parse order number or sales channel");
  }
  if (newLineRow.name !== "คุณไลน์ ทดสอบ" || newLineRow.phone !== `08123${uniquePhoneSuffix}`) {
    fail("new LINE format did not parse customer fields");
  }
  if (newLineRow.date !== "2026-07-03" || newLineRow.socialName !== "line-test") {
    fail("new LINE format did not parse date or customer social");
  }
  if (newLineRow.alternatePhone !== "0891234567" || newLineRow.address !== "99 ถนนสุขุมวิท กรุงเทพฯ") {
    fail("new LINE format did not parse alternate phone or shipping address");
  }
  if (newLineRow.jars !== 3 || newLineRow.amount !== 2250 || newLineRow.freeGift !== "แถม 1 กระปุก") {
    fail("new LINE format did not parse quantity, amount, or free gift");
  }
  if (newLineRow.vipCardStatus !== "ส่งบัตรแล้ว" || newLineRow.originSource !== "ลูกค้าบอกต่อ" || newLineRow.note !== "โทรก่อนส่ง") {
    fail("new LINE format did not parse VIP, source, or note");
  }
  if (!Array.isArray(newLineRow.tags) || !newLineRow.tags.includes("ปวดเข่า") || !newLineRow.tags.includes("นอนไม่หลับ")) {
    fail("new LINE format did not parse customer symptoms");
  }
  const newLineImport = await request("/api/line/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      events: [{
        type: "message",
        replyToken: "",
        source: { type: "group", groupId: "smoke-test-group" },
        message: { type: "text", id: `line-message-${uniqueSuffix}`, text: newLineOrderText }
      }]
    })
  });
  if (newLineImport.status !== 200) fail(`new LINE format import returned ${newLineImport.status}: ${newLineImport.text}`);
  if (JSON.parse(newLineImport.text).parsedOrders !== 1) {
    fail(`new LINE webhook format was not imported: ${newLineImport.text}`);
  }
  const stateAfterLineImport = await request("/api/state", { headers: { cookie } });
  const importedLineOrder = JSON.parse(stateAfterLineImport.text).orders?.find(order => order.orderNumber === `LINE-${uniqueSuffix}`);
  if (!importedLineOrder || importedLineOrder.items !== "Zomin Plus" || importedLineOrder.orderNumber !== `LINE-${uniqueSuffix}`) {
    fail("new LINE format product was not persisted by the webhook path");
  }

  const oldLinePreview = await request("/api/parse-preview", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      content: [
        `เลขออเดอร์ : OLD-${uniqueSuffix}`,
        "วันที่ซื้อ : 3/7/2569",
        "ช่องทางการสั่งซื้อ : LINE",
        "Facebook / LINE ลูกค้า :",
        "",
        "ชื่อลูกค้า : ลูกค้าเดิม",
        "เบอร์โทร : 0821234567",
        "ที่อยู่จัดส่ง : กรุงเทพฯ",
        "จำนวนกระปุก : 2",
        "ยอดซื้อ : 1,500 บาท"
      ].join("\n")
    })
  });
  if (oldLinePreview.status !== 200) fail(`legacy LINE format preview returned ${oldLinePreview.status}`);
  const oldLineRow = JSON.parse(oldLinePreview.text).rows?.[0];
  if (!oldLineRow || oldLineRow.orderNumber !== `OLD-${uniqueSuffix}` || oldLineRow.items) {
    fail("legacy LINE format without สินค้า is no longer compatible");
  }
  if (oldLineRow.socialName) fail("blank LINE field consumed the next Thai label");

  const duplicateBase = {
    orderNumber: `DUP-BASE-${uniqueSuffix}-001`,
    items: "Zomin Plus",
    name: "  Somchai   Dee  ",
    phone: `089-111-${uniqueSuffix}`,
    address: ` 123/4   Bangkok ${uniqueSuffix} `,
    date: nowInBangkok.date,
    time: nowInBangkok.time,
    jars: 2,
    amount: 1500,
    lineMessageId: "line-msg-a"
  };
  const firstOrder = await request("/api/orders", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(duplicateBase)
  });
  if (firstOrder.status !== 200) fail(`first duplicate-check order returned ${firstOrder.status}: ${firstOrder.text}`);
  if (JSON.parse(firstOrder.text).mutation?.order?.items !== "Zomin Plus") {
    fail("product was not saved into the order record");
  }

  const differentAmount = await request("/api/orders", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      ...duplicateBase,
      orderNumber: `DUP-BASE-${uniqueSuffix}-002`,
      amount: 1600,
      lineMessageId: "line-msg-b"
    })
  });
  if (differentAmount.status !== 200) {
    fail(`different amount should import normally, got ${differentAmount.status}: ${differentAmount.text}`);
  }

  const exactDuplicate = await request("/api/orders", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      ...duplicateBase,
      orderNumber: `DUP-BASE-${uniqueSuffix}-003`,
      name: "somchai dee",
      phone: `089111${uniqueSuffix}`,
      address: `123/4 bangkok ${uniqueSuffix}`,
      lineMessageId: "line-msg-c"
    })
  });
  if (exactDuplicate.status !== 409) {
    fail(`exact duplicate should be blocked, got ${exactDuplicate.status}: ${exactDuplicate.text}`);
  }

  console.log("Smoke test passed.");
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
