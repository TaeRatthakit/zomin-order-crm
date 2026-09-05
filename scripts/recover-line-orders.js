require("../lib/env").loadEnv();
process.env.NODE_ENV = "production";
process.env.DATABASE_PROVIDER = "supabase";

const crypto = require("crypto");
const adapter = require("../lib/db/supabase-adapter");
const app = require("../server");

const EVENT_IDS = String(process.env.LINE_RECOVERY_EVENT_IDS || "line_e7e390250ffd,line_82c37fc23124")
  .split(",").map(value => value.trim()).filter(Boolean);
const APPLY = process.argv.includes("--apply");
const headers = {
  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json"
};

function safeHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12);
}
async function fetchEvents() {
  const url = new URL(`${new URL(process.env.SUPABASE_URL).origin}/rest/v1/line_messages`);
  url.searchParams.set("select", "id,tenant_id,created_at,raw_event,raw_text");
  url.searchParams.set("id", `in.(${EVENT_IDS.join(",")})`);
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`line_messages query failed: ${response.status}`);
  return response.json();
}
function eventText(row) { return String(row.raw_event?.message?.text || row.raw_text || ""); }
function eventMessageId(row) { return String(row.raw_event?.message?.id || "").trim(); }
function assertParsedOrder(order, row) {
  if (!order?.orderNumber || !order?.date || !order?.phone || !order?.items || !order?.amount || !order?.jars) {
    throw new Error(`Authoritative LINE event ${row.id} did not parse into complete order fields.`);
  }
}
function existingOrder(db, normalized) {
  return (db.orders || []).find(order => String(order.lineMessageId || "") === normalized.lineMessageId)
    || (db.orders || []).find(order => String(order.orderNumber || "") === normalized.orderNumber && String(order.date || "") === normalized.date);
}
async function recover(row) {
  if (!row.tenant_id) throw new Error(`LINE event ${row.id} has no tenant mapping.`);
  const messageId = eventMessageId(row);
  if (!messageId) throw new Error(`LINE event ${row.id} has no LINE message ID.`);
  return adapter.withTenantContext({ tenantId: row.tenant_id }, async () => {
    const db = await adapter.readDb();
    const parsed = await app.parseOrderWithAI(eventText(row), { ...db.settings, openaiApiKey: "" });
    const normalized = app.normalizedOrderForStorage({ ...parsed, lineMessageId: messageId });
    assertParsedOrder(normalized, row);
    const existing = existingOrder(db, normalized);
    const result = { eventId: row.id, messageIdHash: safeHash(messageId), tenantId: row.tenant_id, orderNumber: normalized.orderNumber, date: normalized.date, action: existing ? "already_present" : "restore" };
    if (!APPLY || existing) return result;
    const order = app.addOrder(db, { ...normalized, id: `o_line_${crypto.createHash("sha256").update(messageId).digest("hex").slice(0, 24)}`, allowProductContainsMatch: true });
    app.adjustInventoryForOrderChange(db, null, order);
    const mutation = app.orderMutationPayload(db, { orderId: order.id, selectedDate: normalized.date });
    const persisted = await adapter.persistLineOrderMutation(mutation, db.settings);
    if (!persisted?.verification?.ok) throw new Error(`Recovery verification failed for ${row.id}.`);
    const rawEvent = { ...(row.raw_event || {}), __debug: {
      ...(row.raw_event?.__debug || {}),
      processing_status: "replied",
      supabase_insert_status: "verified",
      failure_category: "",
      internal_order_id: order.id,
      recovery_status: "restored",
      recovery_reply_already_sent: true,
      verification: "row_confirmed"
    } };
    await adapter.persistLineMessageRecord({ id: row.id, receivedAt: row.created_at, rawEvent, text: eventText(row) });
    return { ...result, action: "restored", orderId: order.id };
  });
}
(async () => {
  adapter.assertProductionDatabaseTarget();
  const rows = await fetchEvents();
  if (rows.length !== EVENT_IDS.length) throw new Error(`Expected ${EVENT_IDS.length} exact incident events, found ${rows.length}.`);
  const results = [];
  for (const eventId of EVENT_IDS) results.push(await recover(rows.find(row => row.id === eventId)));
  console.log(JSON.stringify({ mode: APPLY ? "apply" : "dry-run", projectRef: adapter.databaseProjectFingerprint(), results }, null, 2));
})().catch(error => { console.error(error.message || String(error)); process.exit(1); });
