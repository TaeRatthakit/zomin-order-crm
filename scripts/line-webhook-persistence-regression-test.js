const { Readable } = require("stream");

process.env.NODE_ENV = "development";
process.env.DATABASE_PROVIDER = "supabase";
process.env.SUPABASE_URL = "https://line-persistence-test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.LINE_WEBHOOK_ENABLED = "true";
process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-line-token";
process.env.LINE_CHANNEL_SECRET = "";
process.env.LINE_GROUP_ID = "";

const store = Object.fromEntries([
  "tenants", "tenant_memberships", "users", "settings", "customers", "orders", "line_messages",
  "follow_up_rules", "tags", "customer_tags", "contact_logs", "notification_reads", "subscriptions", "payments"
].map(key => [key, []]));
const failures = { orders: false, ignoreOrders: false };
const replies = [];
const replyTimingLogs = [];
const lifecycleTimingLogs = [];
const databaseReads = [];
let replyObservedAfterDurableSave = false;
const originalConsoleInfo = console.info;
console.info = (...args) => {
  if (args[0] === "LINE reply timing") replyTimingLogs.push(JSON.parse(args[1]));
  if (args[0] === "LINE order lifecycle timing") lifecycleTimingLogs.push(JSON.parse(args[1]));
  originalConsoleInfo(...args);
};

function resetStore() {
  Object.keys(store).forEach(key => { store[key] = []; });
  store.tenants.push({ id: "tenant_a", name: "Tenant A", status: "active" });
  store.settings.push(
    { id: "tenant_a:products", key: "products", value: [{ id: "p_zomin", name: "Zomin", costPerItem: 100, stockQuantity: 1000, archived: false, salesPackages: [] }], tenant_id: "tenant_a" },
    { id: "tenant_a:lineGroupId", key: "lineGroupId", value: "group-a", tenant_id: "tenant_a" }
  );
  failures.orders = false;
  failures.ignoreOrders = false;
  replies.length = 0;
  replyTimingLogs.length = 0;
  lifecycleTimingLogs.length = 0;
  databaseReads.length = 0;
  replyObservedAfterDurableSave = false;
}

function response(body, status = 200) {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function decode(value) { return decodeURIComponent(String(value || "")); }
function matches(row, key, raw) {
  const value = decode(raw);
  if (value.startsWith("eq.")) return String(row[key] ?? "") === decode(value.slice(3));
  if (value.startsWith("in.")) return new Set(value.slice(3).replace(/^\(|\)$/g, "").split(",").map(decode)).has(String(row[key] ?? ""));
  if (value === "is.null") return row[key] == null;
  if (value === "not.is.null") return row[key] != null;
  return true;
}
function selectedRows(table, url) {
  return (store[table] || []).filter(row => [...url.searchParams.entries()]
    .filter(([key]) => !["select", "limit", "order", "on_conflict"].includes(key))
    .every(([key, value]) => matches(row, key, value)));
}

global.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.hostname === "api.line.me") {
    replyObservedAfterDurableSave = store.orders.length > 0;
    replies.push(JSON.parse(options.body || "{}"));
    return response(null, 204);
  }
  const table = url.pathname.split("/").pop();
  if (!Object.hasOwn(store, table)) return response({ error: `unknown table ${table}` }, 404);
  const method = String(options.method || "GET").toUpperCase();
  if (method === "GET") {
    databaseReads.push({ table, query: url.search });
    return response(selectedRows(table, url));
  }
  if (method === "POST") {
    if (table === "orders" && failures.orders) return response({ error: "forced order write failure" }, 503);
    const rows = JSON.parse(options.body || "[]");
    const prefer = String(options.headers?.Prefer || "");
    const conflict = (url.searchParams.get("on_conflict") || "id").split(",");
    const inserted = [];
    for (const row of rows) {
      const index = store[table].findIndex(existing => conflict.every(key => String(existing[key] ?? "") === String(row[key] ?? "")));
      if (index >= 0 && prefer.includes("resolution=ignore-duplicates")) continue;
      if (index >= 0) store[table][index] = { ...store[table][index], ...row };
      else if (!(table === "orders" && failures.ignoreOrders)) store[table].push({ ...row });
      else continue;
      inserted.push(store[table].find(existing => conflict.every(key => String(existing[key] ?? "") === String(row[key] ?? ""))) || row);
    }
    return response(prefer.includes("return=minimal") ? null : inserted);
  }
  if (method === "PATCH") {
    const patch = JSON.parse(options.body || "{}");
    const selected = selectedRows(table, url);
    selected.forEach(row => Object.assign(row, patch));
    return String(options.headers?.Prefer || "").includes("return=representation") ? response(selected) : response(null, 204);
  }
  if (method === "DELETE") { const selected = new Set(selectedRows(table, url)); store[table] = store[table].filter(row => !selected.has(row)); return response(null, 204); }
  return response({ error: "unsupported" }, 405);
};

const appHandler = require("../server");
const adapter = require("../lib/db/supabase-adapter");
function fail(message) { throw new Error(`LINE webhook persistence regression failed: ${message}`); }
function makeRequest(body) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = "POST"; req.url = "/api/line/webhook"; req.headers = { host: "127.0.0.1", "content-type": "application/json" };
  return req;
}
function makeResponse(resolve) {
  const chunks = [];
  return { statusCode: 200, headers: {}, writeHead(status, headers = {}) { this.statusCode = status; this.headers = { ...this.headers, ...headers }; }, setHeader(k, v) { this.headers[k] = v; }, write(c) { if (c) chunks.push(Buffer.from(String(c))); }, end(c) { if (c) chunks.push(Buffer.from(String(c))); resolve({ status: this.statusCode, body: Buffer.concat(chunks).toString() }); } };
}
function request(body) { return new Promise((resolve, reject) => Promise.resolve(appHandler(makeRequest(body), makeResponse(resolve))).catch(reject)); }
function lineEvent(id, orderNumber = "1/9") {
  return { events: [{ type: "message", replyToken: `reply-${id}`, source: { type: "group", groupId: "group-a", userId: "line-user" }, message: { type: "text", id, text: ["สินค้า: Zomin", `เลขออเดอร์: ${orderNumber}`, "วันที่ซื้อ: 5/9/69", "ช่องทางการสั่งซื้อ: LINE", "Facebook / LINE ลูกค้า: line-test", "ชื่อลูกค้า: ลูกค้าทดสอบ", "เบอร์โทร: 0812345678", "ที่อยู่จัดส่ง: 1 Bangkok", "จำนวนกระปุก: 1", "ยอดซื้อ: 280", "ช่องทางการขาย: LINE", "สถานะบัตร VIP: ยังไม่ได้ส่งบัตร"].join("\n") } }] };
}
function latest(id) { return store.line_messages.find(row => row.id === adapter.lineMessageStorageId(id)); }
async function testNormal() {
  resetStore(); const result = await request(lineEvent("normal-001"));
  if (result.status !== 200 || store.orders.length !== 1 || replies.length !== 1) fail("normal order did not persist and reply exactly once");
  if (store.customers.length !== 1 || store.orders[0].customer_id !== store.customers[0].id) fail("normal order customer linkage was not persisted exactly once");
  if (store.settings.find(row => row.key === "products")?.value?.[0]?.stockQuantity !== 999) fail("normal order inventory was not decremented exactly once");
  if (![store.orders[0], store.customers[0], store.settings.find(row => row.key === "products")].every(row => row?.tenant_id === "tenant_a")) fail("normal order persistence escaped its tenant");
  if (latest("normal-001")?.raw_event?.__debug?.processing_status !== "replied") fail("normal event did not reach replied state");
  if (!replyObservedAfterDurableSave) fail("reply started before the durable order write");
  const timing = replyTimingLogs[0];
  if (!timing || timing.correlationId !== "normal-001" || timing.httpStatus !== 204 || timing.status !== "completed") fail("reply timing status or correlation is missing");
  if (![timing.lineApiRequestMs, timing.lineApiResponseHandlingMs, timing.lifecyclePersistenceMs, timing.totalReplySideMs].every(value => Number.isFinite(value) && value >= 0)) fail("reply timing durations are invalid");
  if (!timing.lineApiResponseReceivedAt || !timing.lineApiResponseHandledAt || !timing.lifecycleStartedAt || !timing.lifecycleCompletedAt) fail("reply timing stage timestamps are incomplete");
  const serializedTiming = JSON.stringify(timing);
  if (serializedTiming.includes("test-line-token") || serializedTiming.includes("0812345678") || serializedTiming.includes("ลูกค้าทดสอบ")) fail("reply timing leaked a secret or customer PII");
  const lifecycleTiming = lifecycleTimingLogs[0];
  if (!lifecycleTiming || lifecycleTiming.correlationId !== "normal-001" || lifecycleTiming.status !== "completed") fail("full lifecycle timing is missing");
  if (!["payloadParsingMs", "tenantResolutionMs", "initialDatabaseReadMs", "duplicateClaimMs", "orderParsingMs", "relatedOrderStateReadMs", "persistenceAndVerificationMs", "lineApiTotalMs", "repliedLifecyclePersistenceMs", "totalThroughLifecycleMs"].every(key => Number.isFinite(lifecycleTiming[key]) && lifecycleTiming[key] >= 0)) fail("full lifecycle stage durations are invalid");
  const serializedLifecycle = JSON.stringify(lifecycleTiming);
  if (serializedLifecycle.includes("test-line-token") || serializedLifecycle.includes("0812345678") || serializedLifecycle.includes("ลูกค้าทดสอบ")) fail("full lifecycle timing leaked a secret or customer PII");
  if (databaseReads.some(read => read.table === "customers" && !read.query.includes("phone=eq."))) fail("LINE path performed an unbounded customer read");
  if (databaseReads.some(read => read.table === "orders" && !read.query.includes("id=in.") && !read.query.includes("phone=eq.") && !read.query.includes("customer_id=in."))) fail("LINE path performed an unbounded order read");
  if (databaseReads.some(read => read.table === "settings" && !read.query.includes("key=in."))) fail("LINE path performed an unbounded settings read");
}
async function testWriteFailure() {
  resetStore(); failures.orders = true; const result = await request(lineEvent("failure-001", "2/9"));
  if (result.status !== 500 || replies.length) fail("write failure was acknowledged or replied");
  if (latest("failure-001")?.raw_event?.__debug?.failure_category !== "persistence_failed") fail("write failure category missing");
}
async function testUnconfirmedWrite() {
  resetStore(); failures.ignoreOrders = true; const result = await request(lineEvent("verify-001", "3/9"));
  if (result.status !== 500 || replies.length) fail("unconfirmed write was acknowledged or replied");
  if (latest("verify-001")?.raw_event?.__debug?.failure_category !== "order_not_verified") fail("read-back verification did not fail");
}
async function testConcurrency() {
  resetStore(); await Promise.all([request(lineEvent("duplicate-001", "4/9")), request(lineEvent("duplicate-001", "4/9")), request(lineEvent("distinct-001", "5/9")), request(lineEvent("distinct-002", "6/9"))]);
  if (store.orders.length !== 3 || new Set(store.orders.map(row => row.id)).size !== 3) fail("concurrency produced the wrong order count");
}
function testGuard() {
  const original = { node: process.env.NODE_ENV, vercel: process.env.VERCEL_ENV, url: process.env.SUPABASE_URL };
  process.env.NODE_ENV = "production"; process.env.VERCEL_ENV = "production"; process.env.SUPABASE_URL = "https://wrong-project.supabase.co";
  try { adapter.assertProductionDatabaseTarget(); fail("Production guard accepted the wrong project"); } catch (error) { if (error.code !== "SUPABASE_PRODUCTION_PROJECT_MISMATCH") throw error; }
  Object.assign(process.env, { NODE_ENV: original.node, VERCEL_ENV: original.vercel, SUPABASE_URL: original.url });
}
(async () => { await testNormal(); await testWriteFailure(); await testUnconfirmedWrite(); await testConcurrency(); testGuard(); console.log("LINE webhook persistence regression tests passed"); })().catch(error => { console.error(error); process.exit(1); });
