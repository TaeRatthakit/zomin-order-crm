const { Readable } = require("stream");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.NODE_ENV = "development";
process.env.DATABASE_PROVIDER = "json";
process.env.LINE_WEBHOOK_ENABLED = "true";
process.env.JSON_DB_PATH = path.join(os.tmpdir(), `zomin-line-webhook-${process.pid}.json`);

const lineReplies = [];
let lineReplyFailuresRemaining = 0;
global.fetch = async (url, options = {}) => {
  if (String(url).includes("api.line.me/v2/bot/message/reply")) {
    lineReplies.push(JSON.parse(options.body || "{}"));
    if (lineReplyFailuresRemaining > 0) {
      lineReplyFailuresRemaining -= 1;
      return { ok: false, status: 500, json: async () => ({ error: "forced reply failure" }), text: async () => "forced reply failure" };
    }
    return { ok: true, status: 204, json: async () => null, text: async () => "" };
  }
  throw new Error(`Unexpected fetch in LINE webhook test: ${url}`);
};

function baseDb(overrides = {}) {
  return {
    settings: {
      businessName: "Zomin",
      defaultJarPrice: 280,
      lineWebhookEnabled: true,
      lineChannelSecret: "",
      lineChannelAccessToken: "test-token",
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

const SUCCESS_REPLY = "✅ นำเข้าออเดอร์เรียบร้อยแล้ว\nGrowup Pilot บันทึกข้อมูลเรียบร้อย";
const SAME_DAY_WARNING = "⚠️ พบออเดอร์ที่คล้ายกันภายในวันนี้\nกรุณาตรวจสอบว่าเป็นออเดอร์ใหม่ของลูกค้า หรือเป็นข้อความที่ส่งซ้ำ";

function lastReplyText(result) {
  return result.replies?.at(-1)?.messages?.[0]?.text || "";
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
  amount = 280,
  includeOptionalFields = true
} = {}) {
  const lines = [
    "สินค้า: Zomin",
    `เลขออเดอร์: ${orderNumber}`,
    `วันที่ซื้อ: ${date}`,
    "ช่องทางการสั่งซื้อ: LINE",
    "Facebook / LINE ลูกค้า: line-test",
    `ชื่อลูกค้า: ${name}`,
    `เบอร์โทร: ${phone}`,
    ...(includeOptionalFields ? ["เบอร์โทรสำรอง:"] : []),
    `ที่อยู่จัดส่ง: ${address}`,
    `จำนวน: ${quantity}`,
    `ยอดซื้อ: ${amount}`,
    "ช่องทางการขาย: LINE",
    ...(includeOptionalFields
      ? ["ของแถมที่ลูกค้าได้:", "สถานะบัตร VIP: ยังไม่ได้ส่งบัตร", "อาการลูกค้า:", "หมายเหตุ:"]
      : [])
  ];
  return lines.join("\n");
}

async function postLineMessage(messageId, text) {
  lineReplies.length = 0;
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
  return { ...JSON.parse(response.text), replies: [...lineReplies] };
}

async function testJulySevenToSixteenCreatesNewOrder() {
  writeFixture({
    customers: [customer()],
    orders: [existingOrder()]
  });
  const result = await postLineMessage("line-new-8-16", lineOrderText({ orderNumber: "8/16", date: "16/7/69" }));
  if (result.parsedOrders !== 1) fail("07/07/69 -> 16/07/69 did not parse one new order");
  if (lastReplyText(result) !== SUCCESS_REPLY) fail("success reply changed for a normal new order");
  const db = readFixture();
  const orders = db.orders || [];
  if (orders.length !== 2) fail(`expected 2 orders after >24h import, got ${orders.length}`);
  const created = orders.find(order => order.orderNumber === "8/16");
  if (!created) fail("new order 8/16 was not created");
  if (created.date !== "2026-07-16") fail(`Buddhist year 16/7/69 parsed as ${created.date}`);
}

async function testSimilarOrderSameDayCreatesNewOrderWithWarning() {
  writeFixture({
    customers: [customer()],
    orders: [existingOrder({
      id: "o_same_day",
      orderNumber: "11/16",
      date: "2026-07-16",
      time: "09:00:00",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })]
  });
  const result = await postLineMessage("line-similar-same-day", lineOrderText({ orderNumber: "12/16", date: "16/7/69" }));
  if (result.parsedOrders !== 1) fail("similar same-day order did not parse");
  const db = readFixture();
  if ((db.orders || []).length !== 2) fail("similar same-day order was not saved as a new order");
  const replyText = lastReplyText(result);
  if (!replyText.startsWith(SUCCESS_REPLY)) fail("similar same-day reply did not keep original success text first");
  if (!replyText.includes(SAME_DAY_WARNING)) fail("similar same-day reply did not append warning");
}

async function testSimilarOrderDifferentCreatedDayCreatesNewOrderWithoutWarning() {
  writeFixture({
    customers: [customer()],
    orders: [existingOrder({
      id: "o_previous_created_day",
      orderNumber: "13/16",
      date: "2026-07-16",
      time: "09:00:00",
      createdAt: "2026-07-15T03:00:00.000Z",
      updatedAt: "2026-07-15T03:00:00.000Z"
    })]
  });
  const result = await postLineMessage("line-similar-different-created-day", lineOrderText({ orderNumber: "14/16", date: "16/7/69" }));
  if (result.parsedOrders !== 1) fail("similar different-created-day order did not parse");
  const db = readFixture();
  if ((db.orders || []).length !== 2) fail("similar different-created-day order was not saved as a new order");
  if (lastReplyText(result) !== SUCCESS_REPLY) fail("different-created-day similar order should not append warning");
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

async function testMissingPhoneDoesNotSaveAndReplies() {
  writeFixture({ customers: [], orders: [] });
  const result = await postLineMessage("line-missing-phone", lineOrderText({ phone: "" }));
  if (result.parsedOrders !== 0) fail("missing phone was reported as a saved order");
  const db = readFixture();
  if ((db.orders || []).length !== 0 || (db.customers || []).length !== 0) fail("missing phone created CRM data");
  if (Number(db.settings?.products?.[0]?.stockQuantity) !== 1000) fail("missing phone changed inventory");
  if (lastReplyText(result) !== [
    "❌ ไม่สามารถบันทึกออเดอร์ได้",
    "ข้อมูลไม่ครบ: เบอร์โทร",
    "กรุณาเพิ่มข้อมูลที่ขาดแล้วส่งออเดอร์ใหม่อีกครั้ง"
  ].join("\n")) fail("missing phone reply was not explicit");
}

async function testMultipleMissingRequiredFieldsAreListed() {
  writeFixture({ customers: [], orders: [] });
  const result = await postLineMessage("line-missing-multiple", lineOrderText({ phone: "", address: "", quantity: "" }));
  if (result.parsedOrders !== 0) fail("multiple missing fields were reported as a saved order");
  const db = readFixture();
  if ((db.orders || []).length !== 0 || (db.customers || []).length !== 0) fail("multiple missing fields created CRM data");
  if (Number(db.settings?.products?.[0]?.stockQuantity) !== 1000) fail("multiple missing fields changed inventory");
  if (lastReplyText(result) !== [
    "❌ ไม่สามารถบันทึกออเดอร์ได้",
    "ข้อมูลไม่ครบ: เบอร์โทร, ที่อยู่จัดส่ง, จำนวน",
    "กรุณาเพิ่มข้อมูลที่ขาดแล้วส่งออเดอร์ใหม่อีกครั้ง"
  ].join("\n")) fail("multiple missing fields were not all listed");
}

async function testOptionalFieldsCanBeEmpty() {
  writeFixture({ customers: [], orders: [] });
  const result = await postLineMessage("line-optional-empty", lineOrderText({ includeOptionalFields: false }));
  if (result.parsedOrders !== 1 || lastReplyText(result) !== SUCCESS_REPLY) fail("optional fields changed valid order processing");
  if ((readFixture().orders || []).length !== 1) fail("optional-field order was not saved");
}

async function testReplyFailureDoesNotCreateDuplicateOnRetry() {
  writeFixture({ customers: [], orders: [] });
  lineReplyFailuresRemaining = 1;
  const first = await postLineMessage("line-reply-failure", lineOrderText({ orderNumber: "reply/1" }));
  if (first.parsedOrders !== 1 || (readFixture().orders || []).length !== 1) fail("reply failure did not leave one saved order");
  const retry = await postLineMessage("line-reply-failure", lineOrderText({ orderNumber: "reply/1" }));
  if (retry.parsedOrders !== 0 || (readFixture().orders || []).length !== 1) fail("LINE reply retry created a duplicate order");
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
  await testSimilarOrderSameDayCreatesNewOrderWithWarning();
  await testSimilarOrderDifferentCreatedDayCreatesNewOrderWithoutWarning();
  await testGenuineUpsaleWithin24HoursUpdatesExistingCycle();
  await testSameLineMessageDeliveredTwiceWritesOnce();
  await testMissingPhoneDoesNotSaveAndReplies();
  await testMultipleMissingRequiredFieldsAreListed();
  await testOptionalFieldsCanBeEmpty();
  await testReplyFailureDoesNotCreateDuplicateOnRetry();
  await testSameCustomerProductAfter24HoursCreatesNewOrder();
  await testBuddhistYearThailandTimezoneBoundary();
  console.log("LINE webhook duplicate regression tests passed");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
