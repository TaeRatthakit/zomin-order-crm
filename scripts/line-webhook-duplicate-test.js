const { Readable } = require("stream");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.NODE_ENV = "development";
process.env.DATABASE_PROVIDER = "json";
process.env.LINE_WEBHOOK_ENABLED = "true";
process.env.JSON_DB_PATH = path.join(os.tmpdir(), `zomin-line-webhook-${process.pid}.json`);

function baseDb(overrides = {}) {
  return {
    settings: {
      businessName: "Zomin",
      defaultJarPrice: 280,
      lineWebhookEnabled: true,
      lineChannelSecret: "",
      lineChannelAccessToken: "",
      lineGroupId: "",
      products: [
        {
          id: "p_zomin",
          name: "Zomin",
          sku: "ZOMIN",
          costPerItem: 100,
          stockQuantity: 1000,
          lowStockAlert: 5,
          archived: false,
          salesPackages: []
        }
      ]
    },
    users: [],
    customers: [],
    orders: [],
    lineMessages: [],
    contactLogs: [],
    tags: [],
    followUpRules: [],
    notificationReads: [],
    ...overrides
  };
}

fs.writeFileSync(process.env.JSON_DB_PATH, `${JSON.stringify(baseDb(), null, 2)}\n`, "utf8");

const appHandler = require("../server");

function writeFixture(db) {
  fs.writeFileSync(process.env.JSON_DB_PATH, `${JSON.stringify(baseDb(db), null, 2)}\n`, "utf8");
}

function readFixture() {
  return JSON.parse(fs.readFileSync(process.env.JSON_DB_PATH, "utf8"));
}

function fail(message) {
  throw new Error(`LINE webhook duplicate regression failed: ${message}`);
}

function makeRequest(route, options = {}) {
  const body = options.body || "";
  const req = Readable.from(body ? [body] : []);
  req.method = options.method || "GET";
  req.url = route;
  req.headers = {
    host: "127.0.0.1",
    "content-type": "application/json",
    ...(options.headers || {})
  };
  return req;
}

function makeResponse(resolve) {
  const chunks = [];
  return {
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
}

function request(route, options = {}) {
  return new Promise((resolve, reject) => {
    const req = makeRequest(route, options);
    const res = makeResponse(resolve);
    Promise.resolve(appHandler(req, res)).catch(reject);
  });
}

function customer(id = "c_target") {
  return {
    id,
    name: "ร. ทดสอบ",
    phone: "0831111132",
    address: "31/1 Bangkok",
    tags: [],
    note: "",
    createdAt: "2026-07-01",
    lastContactDate: "",
    lastContactNote: ""
  };
}

function existingOrder(patch = {}) {
  return {
    id: patch.id || "o_existing",
    customerId: patch.customerId || "c_target",
    orderNumber: patch.orderNumber || "8/7",
    customerName: patch.customerName || "ร. ทดสอบ",
    phone: patch.phone || "0831111132",
    address: patch.address || "31/1 Bangkok",
    date: patch.date || "2026-07-07",
    time: patch.time || "10:13:00",
    items: patch.items || "Zomin",
    jars: patch.jars ?? 1,
    amount: patch.amount ?? 280,
    source: "LINE",
    sourceChannel: "LINE",
    productId: "p_zomin",
    rawText: "",
    createdAt: patch.createdAt || "2026-07-07T03:13:45.164439+00:00",
    updatedAt: patch.updatedAt || "2026-07-16T04:30:38.852374+00:00"
  };
}

function lineOrderText({
  orderNumber = "8/16",
  date = "16/7/69",
  name = "ร. ทดสอบ",
  phone = "0831111132",
  address = "31/1 Bangkok",
  quantity = 1,
  amount = 280
} = {}) {
  return [
    "สินค้า: Zomin",
    `เลขออเดอร์: ${orderNumber}`,
    `วันที่ซื้อ: ${date}`,
    "ช่องทางการสั่งซื้อ: LINE",
    "Facebook / LINE ลูกค้า: line-test",
    `ชื่อลูกค้า: ${name}`,
    `เบอร์โทร: ${phone}`,
    "เบอร์โทรสำรอง:",
    `ที่อยู่จัดส่ง: ${address}`,
    `จำนวน: ${quantity}`,
    `ยอดซื้อ: ${amount}`,
    "ช่องทางการขาย: LINE",
    "ของแถมที่ลูกค้าได้:",
    "สถานะบัตร VIP: ยังไม่ได้ส่งบัตร",
    "อาการลูกค้า:",
    "หมายเหตุ:"
  ].join("\n");
}

async function postLineMessage(messageId, text) {
  const body = JSON.stringify({
    events: [
      {
        type: "message",
        replyToken: `reply-${messageId}`,
        source: { type: "group", groupId: "group-test", userId: "user-test" },
        message: { type: "text", id: messageId, text }
      }
    ]
  });
  const response = await request("/api/line/webhook", { method: "POST", body });
  if (response.status !== 200) fail(`webhook returned ${response.status}: ${response.text}`);
  return JSON.parse(response.text);
}

async function testJulySevenToSixteenCreatesNewOrder() {
  writeFixture({
    customers: [customer()],
    orders: [existingOrder()]
  });
  const result = await postLineMessage("line-new-8-16", lineOrderText({ orderNumber: "8/16", date: "16/7/69" }));
  if (result.parsedOrders !== 1) fail("07/07/69 -> 16/07/69 did not parse one new order");
  const db = readFixture();
  const orders = db.orders || [];
  if (orders.length !== 2) fail(`expected 2 orders after >24h import, got ${orders.length}`);
  const created = orders.find(order => order.orderNumber === "8/16");
  if (!created) fail("new order 8/16 was not created");
  if (created.date !== "2026-07-16") fail(`Buddhist year 16/7/69 parsed as ${created.date}`);
}

async function testGenuineUpsaleWithin24HoursUpdatesExistingCycle() {
  writeFixture({
    customers: [customer()],
    orders: [existingOrder({
      id: "o_upsale",
      orderNumber: "10/16",
      date: "2026-07-16",
      time: "08:00:00",
      jars: 1,
      amount: 280,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })]
  });
  const result = await postLineMessage("line-upsale", lineOrderText({ orderNumber: "10/16", date: "16/7/69", quantity: 2, amount: 500 }));
  if (result.parsedOrders !== 1) fail("upsale message did not parse");
  const db = readFixture();
  if ((db.orders || []).length !== 1) fail("upsale created a second order instead of updating");
  const order = db.orders[0];
  if (Number(order.jars) !== 2 || Number(order.amount) !== 500) fail("upsale did not update quantity/amount");
  if (order.lineMessageId !== "line-upsale") fail("upsale did not store latest LINE message id");
}

async function testSameLineMessageDeliveredTwiceWritesOnce() {
  writeFixture({ customers: [], orders: [] });
  const text = lineOrderText({ orderNumber: "1/16", date: "16/7/69", phone: "0832222232", address: "55 Bangkok" });
  const first = await postLineMessage("line-repeat", text);
  const second = await postLineMessage("line-repeat", text);
  if (first.parsedOrders !== 1) fail("first repeated message did not create an order");
  if (second.parsedOrders !== 0) fail("second repeated message created or updated an order");
  const db = readFixture();
  if ((db.orders || []).length !== 1) fail("same LINE message id wrote more than one order");
}

async function testSameCustomerProductAfter24HoursCreatesNewOrder() {
  writeFixture({
    customers: [customer()],
    orders: [existingOrder({ id: "o_old_same", orderNumber: "2/14", date: "2026-07-14", time: "08:00:00", updatedAt: "2026-07-16T04:30:38.852374+00:00" })]
  });
  const result = await postLineMessage("line-after-24", lineOrderText({ orderNumber: "2/16", date: "16/7/69" }));
  if (result.parsedOrders !== 1) fail("same customer/product after 24 hours did not parse");
  const db = readFixture();
  if ((db.orders || []).length !== 2) fail("same customer/product after 24 hours was treated as duplicate");
}

async function testBuddhistYearThailandTimezoneBoundary() {
  writeFixture({
    customers: [customer()],
    orders: [existingOrder({
      id: "o_boundary",
      orderNumber: "TZ/1",
      date: "2026-07-15",
      time: "23:30:00",
      jars: 1,
      amount: 280,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })]
  });
  const result = await postLineMessage("line-boundary", lineOrderText({ orderNumber: "TZ/1", date: "16/7/69", quantity: 3, amount: 840 }));
  if (result.parsedOrders !== 1) fail("timezone boundary message did not parse");
  const db = readFixture();
  if ((db.orders || []).length !== 1) fail("timezone boundary within 24h created a duplicate order");
  const order = db.orders[0];
  if (Number(order.jars) !== 3 || Number(order.amount) !== 840) fail("timezone boundary upsale did not update existing order");
}

async function main() {
  await testJulySevenToSixteenCreatesNewOrder();
  await testGenuineUpsaleWithin24HoursUpdatesExistingCycle();
  await testSameLineMessageDeliveredTwiceWritesOnce();
  await testSameCustomerProductAfter24HoursCreatesNewOrder();
  await testBuddhistYearThailandTimezoneBoundary();
  console.log("LINE webhook duplicate regression tests passed");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
