"use strict";

const assert = require("assert");

process.env.NODE_ENV = "development";
process.env.DATABASE_PROVIDER = "supabase";
process.env.SUPABASE_URL = "https://order-performance-test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-key";

const calls = [];
const rows = {
  tenant_memberships: [{ tenant_id: "tenant-test", user_id: "owner-test", is_active: true }],
  users: [{ id: "owner-test", username: "owner", name: "Owner", role: "Owner", is_active: true }],
  settings: [{ id: "tenant-test:rolePermissions", tenant_id: "tenant-test", key: "rolePermissions", value: {} }],
  subscriptions: [{ id: "subscription-test", tenant_id: "tenant-test", plan: "business", status: "active" }]
};

global.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  assert.strictEqual(url.hostname, "order-performance-test.supabase.co");
  const table = url.pathname.split("/").pop();
  const method = String(options.method || "GET").toUpperCase();
  calls.push({ method, table });
  if (method === "GET") {
    const selected = rows[table] || [];
    return new Response(JSON.stringify(table === "settings" && url.searchParams.has("key")
      ? selected.filter(row => row.key === "rolePermissions") : selected), { status: 200 });
  }
  if (method === "DELETE") return new Response(null, { status: 204 });
  if (method === "POST") {
    if (global.__failPostTable === table) {
      return new Response(JSON.stringify({ message: `test failure on ${table}` }), { status: 500 });
    }
    return new Response("[]", { status: 200 });
  }
  throw new Error(`Unexpected ${method} ${table}`);
};

const adapter = require("../lib/db/supabase-adapter");
const context = { tenantId: "tenant-test", userId: "owner-test", tenantRole: "Owner" };

(async () => {
  const readCounts = [];
  const priorWriteCounts = [];
  const optimizedWriteCounts = [];
  for (let index = 0; index < 5; index += 1) {
    calls.length = 0;
    const db = await adapter.withTenantContext(context, () => adapter.readOrderDeleteIntentDb());
    assert.strictEqual(db.users[0].id, "owner-test");
    assert.strictEqual(db.subscriptions[0].status, "active");
    assert.deepStrictEqual([...new Set(calls.map(call => call.table))].sort(),
      ["users", "settings", "subscriptions"].sort());
    assert(!calls.some(call => call.table === "tenant_memberships"),
      "Delete intent read must reuse the membership check performed by authenticated tenant resolution");
    readCounts.push(calls.length);

    const mutation = {
      order: { id: `order-test-${index}`, customerId: "customer-test", orderNumber: `TEST-${index}`, date: "2026-09-28", jars: 1, amount: 100 },
      customers: [{ id: "customer-test", name: "Test Customer", phone: "0800000000", tags: [] }],
      affectedCustomerIds: ["customer-test"],
      tags: ["existing"]
    };
    calls.length = 0;
    await adapter.withTenantContext(context, () => adapter.persistOrderMutation(mutation, { products: [{ id: "product-test", stockQuantity: 10 }] }));
    assert(calls.some(call => call.method === "POST" && call.table === "customers"),
      "missing previous-customer snapshot must not suppress required customer persistence");
    priorWriteCounts.push(calls.length);

    calls.length = 0;
    await adapter.withTenantContext(context, () => adapter.persistOrderMutation({
      ...mutation,
      previousCustomers: mutation.customers.map(customer => ({ ...customer })),
      persistTagNames: [],
      persistCustomerTags: false
    }, null));
    assert.deepStrictEqual(calls.map(call => `${call.method} ${call.table}`).sort(), ["POST orders"]);
    optimizedWriteCounts.push(calls.length);
  }

  const customerBase = {
    id: "customer-test",
    name: "Test Customer",
    phone: "0800000000",
    address: "Original test address",
    note: "Original test note",
    assignedTo: "owner-test",
    firstPurchaseDate: "2026-01-01",
    lastPurchaseDate: "2026-09-28",
    purchaseCount: 2,
    totalJars: 3,
    totalSpent: 300,
    status: "NORMAL",
    vipLevel: "NORMAL",
    customerScore: 50,
    followUpDate: "2026-10-01",
    lastContactDate: "2026-09-01",
    lastContactNote: "Test contact",
    tags: ["existing", "second"]
  };
  const customerChangeMutation = (field, value) => ({
    order: {
      id: `order-customer-change-${field}`,
      customerId: "customer-test",
      orderNumber: `TEST-CUSTOMER-${field}`,
      date: "2026-09-28",
      jars: 1,
      amount: 100,
      note: `order-only change ${field}`
    },
    customers: [{ ...customerBase, [field]: value }],
    previousCustomers: [{ ...customerBase }],
    affectedCustomerIds: ["customer-test"],
    persistTagNames: [],
    persistCustomerTags: false
  });
  const customerBusinessChanges = [
    ["name", "Updated Test Customer"],
    ["phone", "0800000001"],
    ["address", "Updated test address"],
    ["status", "VIP"],
    ["vipLevel", "VIP"],
    ["assignedTo", "staff-test"],
    ["followUpDate", "2026-10-02"],
    ["purchaseCount", 3],
    ["totalJars", 4],
    ["totalSpent", 400],
    ["firstPurchaseDate", "2026-01-02"],
    ["lastPurchaseDate", "2026-09-29"]
  ];
  for (const [field, value] of customerBusinessChanges) {
    calls.length = 0;
    await adapter.withTenantContext(context, () => adapter.persistOrderMutation(customerChangeMutation(field, value), null));
    assert(calls.some(call => call.method === "POST" && call.table === "customers"), `${field} change must still upsert customer`);
    assert(calls.some(call => call.method === "POST" && call.table === "orders"), `${field} change must persist order`);
  }

  calls.length = 0;
  await adapter.withTenantContext(context, () => adapter.persistOrderMutation({
    ...customerChangeMutation("name", customerBase.name),
    previousCustomers: [{ ...customerBase, id: "different-customer" }]
  }, null));
  assert(calls.some(call => call.method === "POST" && call.table === "customers"),
    "unmatched previous-customer snapshot must not suppress required customer persistence");

  const normalizedPreviousCustomer = {
    ...customerBase,
    address: null,
    note: null,
    assignedTo: null,
    firstPurchaseDate: null,
    lastPurchaseDate: null,
    purchaseCount: null,
    totalJars: null,
    totalSpent: null,
    status: undefined,
    vipLevel: undefined,
    customerScore: undefined,
    followUpDate: null,
    lastContactDate: null,
    lastContactNote: null
  };
  const normalizedNextCustomer = {
    ...normalizedPreviousCustomer,
    address: "",
    note: "",
    assignedTo: "",
    firstPurchaseDate: "",
    lastPurchaseDate: "",
    purchaseCount: 0,
    totalJars: 0,
    totalSpent: 0,
    status: "NORMAL",
    vipLevel: "NORMAL",
    customerScore: 0,
    followUpDate: "",
    lastContactDate: "",
    lastContactNote: ""
  };
  calls.length = 0;
  await adapter.withTenantContext(context, () => adapter.persistOrderMutation({
    ...customerChangeMutation("name", customerBase.name),
    customers: [normalizedNextCustomer],
    previousCustomers: [normalizedPreviousCustomer]
  }, null));
  assert(!calls.some(call => call.method === "POST" && call.table === "customers"),
    "null/empty/default representations with identical persisted payload must not upsert customer");
  assert(calls.some(call => call.method === "POST" && call.table === "orders"),
    "normalization-only customer equality must preserve order persistence");

  calls.length = 0;
  await adapter.withTenantContext(context, () => adapter.persistOrderMutation({
    ...customerChangeMutation("name", customerBase.name),
    customers: [{ ...customerBase, tags: ["second", "existing"] }],
    previousCustomers: [{ ...customerBase, tags: ["existing", "second"] }],
    persistTagNames: [],
    persistCustomerTags: false
  }, null));
  assert(!calls.some(call => call.method === "POST" && call.table === "customers"),
    "tag-array ordering alone must not trigger a customer-row upsert");
  assert(calls.some(call => call.method === "POST" && call.table === "orders"),
    "tag-array ordering alone must preserve order persistence");

  const taggedAndInventoryChanged = {
    ...customerChangeMutation("name", customerBase.name),
    customers: [{ ...customerBase, tags: ["existing", "new-tag"] }],
    previousCustomers: [{ ...customerBase, tags: ["existing"] }],
    persistTagNames: ["new-tag"],
    persistCustomerTags: true
  };
  calls.length = 0;
  await adapter.withTenantContext(context, () => adapter.persistOrderMutation(taggedAndInventoryChanged, { products: [{ id: "product-test", stockQuantity: 9 }] }));
  assert(!calls.some(call => call.method === "POST" && call.table === "customers"), "tag-only change must not force a customer-row upsert");
  assert(calls.some(call => call.method === "POST" && call.table === "orders"), "tag change must preserve order write");
  assert(calls.some(call => call.method === "POST" && call.table === "settings"), "inventory change must persist product settings");
  assert(calls.some(call => call.method === "POST" && call.table === "tags"), "new tag must persist");
  assert(calls.some(call => call.method === "POST" && call.table === "customer_tags"), "changed customer tags must persist");

  calls.length = 0;
  await adapter.withTenantContext(context, () => adapter.persistOrderMutation({
    ...taggedAndInventoryChanged,
    customers: [{ ...taggedAndInventoryChanged.customers[0], tags: ["existing"] }],
    previousCustomers: [{ ...taggedAndInventoryChanged.customers[0], tags: ["existing"] }],
    persistTagNames: [],
    persistCustomerTags: false
  }, null));
  assert(!calls.some(call => ["customers", "settings", "tags", "customer_tags"].includes(call.table) && call.method !== "GET"),
    "unchanged customer/product/tag state must not issue redundant writes");
  assert(calls.some(call => call.method === "POST" && call.table === "orders"), "no-value save must preserve normal order persistence");

  calls.length = 0;
  global.__failPostTable = "orders";
  await assert.rejects(() => adapter.withTenantContext(context, () => adapter.persistOrderMutation({
    order: { id: "order-failure", customerId: "customer-test", orderNumber: "TEST-FAIL", date: "2026-09-28", jars: 1, amount: 100 },
    customers: [{ id: "customer-test", name: "Test Customer", phone: "0800000000", tags: [] }],
    previousCustomers: [{ id: "customer-test", name: "Test Customer", phone: "0800000000", tags: [] }],
    affectedCustomerIds: ["customer-test"],
    persistTagNames: [],
    persistCustomerTags: false
  }, null)), /test failure on orders/);
  delete global.__failPostTable;
  assert(!calls.some(call => call.method === "POST" && call.table === "customers"), "failed no-value order save must not write customer data");

  calls.length = 0;
  await adapter.withTenantContext(context, () => adapter.readDb());
  const fullReadCount = calls.length;
  assert(fullReadCount > Math.max(...readCounts));
  assert(priorWriteCounts.every(count => count > 2));
  console.log(`order-performance-write-test: PASS; intent reads ${fullReadCount} -> ${readCounts.join(",")}; unchanged Edit calls ${priorWriteCounts.join(",")} -> ${optimizedWriteCounts.join(",")}; customer business fields, null/empty normalization, tag ordering, inventory, no-value save and failed-save checks passed`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
