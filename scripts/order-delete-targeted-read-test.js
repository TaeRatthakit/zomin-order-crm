"use strict";

const assert = require("node:assert/strict");

process.env.VERCEL_ENV = "preview";
process.env.DATABASE_PROVIDER = "json";
process.env.SUPABASE_URL = "https://enwabsfsmwwcwwirdwok.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";

const adapter = require("../lib/db/supabase-adapter");
const { orderMutationPayload } = require("../server");
const tenantId = "tenant-preview-a";
const actorId = "user-preview-a";
const customerId = "customer-preview-a";
const orderRows = [
  {
    id: "order-target",
    tenant_id: tenantId,
    customer_id: customerId,
    order_number: "QA-DELETE-A",
    customer_name: "QA Customer",
    phone: "0990000001",
    items: "Test product",
    quantity: 1,
    amount: 100,
    order_date: "2026-09-20",
    order_time: "10:00:00",
    source: "TEST"
  },
  {
    id: "order-sibling",
    tenant_id: tenantId,
    customer_id: customerId,
    order_number: "QA-DELETE-B",
    customer_name: "QA Customer",
    phone: "0990000001",
    items: "Test product",
    quantity: 2,
    amount: 200,
    order_date: "2026-09-19",
    order_time: "10:00:00",
    source: "TEST"
  }
];
const fixture = {
  users: [
    { id: actorId, username: "qa-owner", name: "QA Owner", role: "Owner", is_active: true },
    { id: "user-preview-b", username: "qa-staff", name: "QA Staff", role: "Staff", is_active: false }
  ],
  customers: [{
    id: customerId,
    tenant_id: tenantId,
    name: "QA Customer",
    phone: "0990000001",
    latest_address: "",
    note: "QA only"
  }],
  settings: [
    { id: "role-permissions", tenant_id: tenantId, key: "rolePermissions", value: {} },
    { id: "products", tenant_id: tenantId, key: "products", value: [{ id: "product-a", name: "Test product", stockQuantity: 7 }] },
    { id: "follow-up-days", tenant_id: tenantId, key: "followUpDaysPerUnit", value: 15 },
    { id: "vip-thresholds", tenant_id: tenantId, key: "vipThresholds", value: { vip: 5000, vvip: 10000, superVip: 20000 } }
  ],
  follow_up_rules: [{ tenant_id: tenantId, jars: 1, days: 15 }],
  tags: [{ tenant_id: tenantId, name: "QA tag" }, { tenant_id: tenantId, name: "Existing tag" }],
  customer_tags: [{ tenant_id: tenantId, customer_id: customerId, tag_name: "QA tag" }],
  contact_logs: [{ id: "contact-a", tenant_id: tenantId, customer_id: customerId, contact_date: "2026-09-18", result: "TEST", note: "QA" }],
  subscriptions: [{ id: "subscription-a", tenant_id: tenantId, plan: "starter", status: "active", is_initial: true }],
  payments: [{ id: "payment-a", tenant_id: tenantId, status: "pending", amount_minor: 0 }],
  tenant_memberships: [
    { tenant_id: tenantId, user_id: actorId, is_active: true },
    { tenant_id: tenantId, user_id: "user-preview-b", is_active: true }
  ]
};
const requests = [];

function filteredRows(table, params) {
  let rows = fixture[table] || [];
  const id = params.get("id");
  const customer = params.get("customer_id");
  const user = params.get("user_id");
  const key = params.get("key");
  if (id?.startsWith("eq.")) rows = rows.filter(row => String(row.id) === id.slice(3));
  if (customer?.startsWith("eq.")) rows = rows.filter(row => String(row.customer_id) === customer.slice(3));
  if (user?.startsWith("eq.")) rows = rows.filter(row => String(row.user_id) === user.slice(3));
  if (key?.startsWith("in.")) {
    const keys = key.slice(3).replace(/^\(|\)$/g, "").split(",");
    rows = rows.filter(row => keys.includes(String(row.key)));
  }
  if (params.has("is_active")) rows = rows.filter(row => String(row.is_active) === params.get("is_active").slice(3));
  const limit = Number(params.get("limit"));
  const offset = Number(params.get("offset") || 0);
  if (Number.isFinite(limit) && limit > 0) rows = rows.slice(offset, offset + limit);
  return rows;
}

global.fetch = async input => {
  const url = new URL(input);
  const table = url.pathname.split("/").pop();
  const params = url.searchParams;
  requests.push({ table, params });
  if (table === "orders") {
    const id = params.get("id");
    const customer = params.get("customer_id");
    let rows = orderRows;
    if (id?.startsWith("eq.")) rows = rows.filter(row => row.id === id.slice(3));
    if (customer?.startsWith("eq.")) rows = rows.filter(row => row.customer_id === customer.slice(3));
    const limit = Number(params.get("limit"));
    const offset = Number(params.get("offset") || 0);
    if (Number.isFinite(limit) && limit > 0) rows = rows.slice(offset, offset + limit);
    return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify(filteredRows(table, params)), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};

function assertTenantScopedReads() {
  const tenantTables = new Set([
    "customers", "orders", "follow_up_rules", "settings", "tags", "customer_tags",
    "contact_logs", "subscriptions", "payments", "tenant_memberships"
  ]);
  for (const request of requests) {
    if (tenantTables.has(request.table)) {
      assert.equal(request.params.get("tenant_id"), `eq.${tenantId}`, `${request.table} must remain tenant-scoped`);
    }
  }
}

async function main() {
  await adapter.withTenantContext({ tenantId, userId: actorId, tenantRole: "Owner" }, async () => {
    const intentDb = await adapter.readOrderDeleteIntentDb();
    assert.deepEqual(requests.map(request => request.table).sort(), ["settings", "subscriptions", "users"]);
    assert.equal(requests.some(request => request.table === "tenant_memberships"), false,
      "intent read reuses the active membership resolution from the authenticated handler");
    assert.equal(intentDb.users.length, 1);
    assert.equal(intentDb.users[0].id, actorId);
    assert.equal(intentDb.subscriptions.length, 1);
    assertTenantScopedReads();

    requests.length = 0;
    const db = await adapter.readOrderDeleteDb("order-target");
    assert.equal(db.orders.length, 2, "target order and every order for its customer are loaded");
    assert.deepEqual(db.orders.map(order => order.id).sort(), ["order-sibling", "order-target"]);
    assert.equal(db.customers.length, 1);
    assert.equal(db.customers[0].id, customerId);
    assert.deepEqual(db.customers[0].tags, ["QA tag"]);
    assert.equal(db.contactLogs.length, 1);
    assert.deepEqual(db.tags.sort(), ["Existing tag", "QA tag"]);
    assert.equal(db.settings.products[0].stockQuantity, 7);
    assert.equal(requests.some(request => request.table === "line_messages"), false);
    assert.equal(requests.some(request => request.table === "payments"), false,
      "payments are only loaded for the subscription-blocked billing response");
    assertTenantScopedReads();

    const deletedOrder = db.orders.find(order => order.id === "order-target");
    db.orders = db.orders.filter(order => order.id !== deletedOrder.id);
    const mutation = orderMutationPayload(db, {
      deletedOrderId: deletedOrder.id,
      previousCustomerIds: [customerId],
      selectedDate: "2026-09-20"
    });
    assert.equal(mutation.customers.length, 1);
    assert.equal(mutation.customers[0].purchaseCount, 1);
    assert.equal(mutation.customers[0].totalJars, 2);
    assert.equal(mutation.customers[0].totalSpent, 200);
    assert.deepEqual(mutation.customers[0].orders.map(order => order.id), ["order-sibling"]);
    assert.equal(mutation.customers[0].contactLogs[0].id, "contact-a");

    const billing = await adapter.readOrderDeleteBillingDb();
    assert.equal(billing.users.length, 2);
    assert.equal(billing.payments.length, 1);
    assertTenantScopedReads();
  });
  console.log("Order delete targeted-read tests passed.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
