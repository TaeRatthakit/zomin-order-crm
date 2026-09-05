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
  if (url.hostname === "api.line.me") { replies.push(JSON.parse(options.body || "{}")); return response(null, 204); }
  const table = url.pathname.split("/").pop();
  if (!Object.hasOwn(store, table)) return response({ error: `unknown table ${table}` }, 404);
  const method = String(options.method || "GET").toUpperCase();
  if (method === "GET") return response(selectedRows(table, url));
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
      inserted.push(row);
    }
    return response(prefer.includes("return=minimal") ? null : inserted);
  }
  if (method === "PATCH") { const patch = JSON.parse(options.body || "{}"); selectedRows(table, url).forEach(row => Object.assign(row, patch)); return response(null, 204); }
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
  if (latest("normal-001")?.raw_event?.__debug?.processing_status !== "replied") fail("normal event did not reach replied state");
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
