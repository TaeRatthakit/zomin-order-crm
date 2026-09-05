const crypto = require("crypto");
require("../lib/env").loadEnv();

const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
const missing = required.filter(key => !process.env[key]);
if (missing.length) { console.error(`Missing required environment: ${missing.join(", ")}`); process.exit(1); }
const base = new URL(process.env.SUPABASE_URL);
const projectRef = base.hostname.split(".")[0] || "unknown";
const filterDate = String(process.env.LINE_RECONCILE_DATE || "").trim();
const headers = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` };
async function get(table, params = {}) {
  const url = new URL(`${base.origin}/rest/v1/${table}`);
  Object.entries({ limit: "10000", ...params }).forEach(([key, value]) => url.searchParams.set(key, value));
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${table} query failed: ${res.status}`);
  return res.json();
}
function eventMessageId(row) { return String(row.raw_event?.message?.id || row.raw_event?.message?.messageId || "").trim(); }
function eventText(row) { return String(row.raw_event?.message?.text || ""); }
function label(text, names) {
  const pattern = names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return String(text).match(new RegExp(`(?:${pattern})\\s*[:：]\\s*([^\\n\\r]+)`, "i"))?.[1]?.trim() || "";
}
function eventOrderNumber(row) { return label(eventText(row), ["เลขออเดอร์", "order_number", "order number"]); }
function eventOrderDate(row) {
  const raw = label(eventText(row), ["วันที่ซื้อ", "order_date", "order date"]);
  const match = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (!match) return "";
  const year = Number(match[3]) < 100 ? Number(match[3]) + 2500 - 543 : Number(match[3]);
  return `${year}-${String(Number(match[2])).padStart(2, "0")}-${String(Number(match[1])).padStart(2, "0")}`;
}
function eventStatus(row) {
  const debug = row.raw_event?.__debug || {};
  return String(debug.processing_status || (debug.supabase_insert_status === "inserted" ? "persisted" : "")).trim().toLowerCase();
}
function orderLineMessageId(row) {
  try { const parsed = JSON.parse(row.raw_text || "{}"); return String(parsed.__lineMessageId || parsed.primary?.__lineMessageId || "").trim(); } catch { return ""; }
}
function safeId(value) { return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12); }
(async () => {
  const tenants = await get("tenants", { select: "id,status" });
  const missingOrders = [], failures = [];
  for (const tenant of tenants.filter(row => row.status === "active")) {
    const [events, orders] = await Promise.all([
      get("line_messages", { select: "id,created_at,raw_event", tenant_id: `eq.${tenant.id}` }),
      get("orders", { select: "id,order_number,order_date,raw_text", tenant_id: `eq.${tenant.id}` })
    ]);
    const orderIds = new Set(orders.map(orderLineMessageId).filter(Boolean));
    const orderKeys = new Set(orders.map(order => `${String(order.order_number || "").trim()}|${String(order.order_date || "").trim()}`));
    for (const event of events) {
      if (filterDate && !String(event.created_at || "").startsWith(filterDate)) continue;
      const status = eventStatus(event); const messageId = eventMessageId(event);
      const orderKey = `${eventOrderNumber(event)}|${eventOrderDate(event)}`;
      if (["persisted", "replied"].includes(status) && messageId && !orderIds.has(messageId) && !orderKeys.has(orderKey)) missingOrders.push({ tenantId: tenant.id, lineEventId: event.id, lineMessageIdHash: safeId(messageId), status, receivedAt: event.created_at });
      if (status === "failed") failures.push({ tenantId: tenant.id, lineEventId: event.id, lineMessageIdHash: safeId(messageId), category: event.raw_event?.__debug?.failure_category || "unknown", receivedAt: event.created_at });
    }
  }
  console.log(JSON.stringify({ ok: missingOrders.length === 0, projectRef, successfulEventsWithoutOrders: missingOrders, failedEvents: failures, counts: { successfulEventsWithoutOrders: missingOrders.length, failedEvents: failures.length } }, null, 2));
  if (missingOrders.length) process.exitCode = 2;
})().catch(error => { console.error(error.message || String(error)); process.exitCode = 1; });
